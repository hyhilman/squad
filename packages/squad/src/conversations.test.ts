import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeFakeDocker } from "../test/fake-docker.ts";
import { addAccount, getHealth, setState } from "./accounts/store.ts";
import { close, firstTurnRefused, open, send, type OpenRequest } from "./conversations.ts";
import { ensureHome, layoutOf } from "./home.ts";
import { makeLog } from "./log.ts";
import { runPass, type RunDeps } from "./run.ts";
import { uuidOfUlid } from "./ids.ts";
import { getSession } from "./sessions.ts";
import { NO_TOKENS, openStore } from "./store/db.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");

function rig(more: Partial<RunDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "conv-"));
  const home = layoutOf(join(root, "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  for (const name of ["k1", "k2"]) {
    addAccount(store.db, { runner: "pi", name, kind: "key" }, NOW);
    mkdirSync(join(home.accounts, "pi", name), { recursive: true });
    writeFileSync(join(home.accounts, "pi", name, "auth.json"), '{"fake":"not-a-real-key"}');
  }
  const cwd = join(root, "work");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const fake = makeFakeDocker(join(root, "bin"));
  const deps: RunDeps = { home, store, now: () => NOW, docker: fake.path, project: "proj", identity: { name: "Bot", email: "bot@example.com" }, user: null, log: makeLog(() => {}), env: { SQUAD_STOP_GRACE_S: "7" }, ...more };
  const req = (m: Partial<OpenRequest> = {}): OpenRequest => ({ runner: "pi", account: "pi/k1", model: "opencode-go/hy4-preview", cwd, caller: { flow: "chat", action: "chat:pi" }, ...m });
  return { home, store, fake, deps, req, cwd };
}

const rows = (r: ReturnType<typeof rig>) => r.store.db.prepare("SELECT * FROM passes ORDER BY id").all() as Record<string, unknown>[];
const sessionDirOf = (r: ReturnType<typeof rig>, id: string, name = "k1") => join(r.home.sessions, "pi", name, id);

test("open writes the row and starts nothing; the lock is not taken", () => {
  const r = rig();
  const c = open(r.req({ system: "be brief", effort: "high", labels: { team: "x" }, env: { PATH: "/p" }, task: { kind: "issue", id: "7" } }), r.deps);
  assert.equal(c.account, "pi/k1");
  assert.equal(r.fake.calls().length, 0);
  assert.equal(rows(r).length, 0);
  const row = r.store.db.prepare("SELECT * FROM conversations WHERE id = ?").get(c.id) as Record<string, unknown>;
  assert.deepEqual([row.runner, row.account, row.model, row.cwd, row.caller_flow, row.task_kind, row.task_id, row.closed_at], ["pi", "pi/k1", "opencode-go/hy4-preview", r.cwd, "chat", "issue", "7", null]);
  assert.equal(getSession(r.store.db, "pi", c.id)!.account, "pi/k1");
  assert.ok(!existsSync(join(r.home.locks, "pi", "k1.lock")), "no lock file made by open");
});

test("open refuses an unknown, dead or disabled account, and a runner mismatch", () => {
  const r = rig();
  addAccount(r.store.db, { runner: "codex", name: "c1", kind: "login" }, NOW);
  assert.throws(() => open(r.req({ account: "pi/nope" }), r.deps), /unknown pi account/);
  assert.throws(() => open(r.req({ account: "codex/c1" }), r.deps), /unknown pi account/);
  setState(r.store.db, "pi/k1", "dead", "401", NOW);
  assert.throws(() => open(r.req(), r.deps), /dead/);
  setState(r.store.db, "pi/k2", "disabled");
  assert.throws(() => open(r.req({ account: "k2" }), r.deps), /disabled/);
  assert.equal(r.store.db.prepare("SELECT count(*) AS n FROM conversations").get()!.n, 0);
});

test("two sends reuse the session folder and the same args; the pass rows carry the conversation id", async () => {
  const r = rig();
  const c = open(r.req({ system: "be brief", effort: "high" }), r.deps);
  const a = await send(c, "first", {}, r.deps);
  assert.equal(a.failure, undefined);
  assert.equal(a.account, "pi/k1");
  writeFileSync(join(sessionDirOf(r, c.id), "t.jsonl"), "{}\n");
  const b = await send(c.id, "second", {}, r.deps);
  assert.equal(b.failure, undefined);
  assert.deepEqual(readdirSync(sessionDirOf(r, c.id)), ["t.jsonl"]);
  const [x, y] = r.fake.callsOf("run");
  const flags = (argv: string[]) => argv.slice(argv.indexOf("--session-dir"), argv.indexOf("--"));
  assert.deepEqual(flags(x!), flags(y!));
  assert.ok(x!.includes("--append-system-prompt") && y!.includes("--append-system-prompt"));
  const head = (argv: string[]) => argv.slice(argv.indexOf("--model"), argv.indexOf("--"));
  assert.deepEqual(head(x!), head(y!));
  assert.deepEqual(rows(r).map((p) => p.session_id), [c.id, c.id]);
  assert.deepEqual([a.passId, b.passId].sort(), rows(r).map((p) => p.id).sort());
});

test("the skill is opened on the first turn only; later turns keep --skill and the system prompt but send the message as written", async () => {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), "skill-"));
  writeFileSync(join(dir, "SKILL.md"), "---\nname: todo-exec\n---\nDo the task.\n");
  const c = open(r.req({ system: "be brief", skill: { name: "todo-exec", dir } }), r.deps);
  await send(c, "issue=o/r#1", {}, r.deps);
  await send(c, "Reply with the comment.", {}, r.deps);
  const [x, y] = r.fake.callsOf("run");
  assert.deepEqual(r.fake.stdins(), ["/skill:todo-exec issue=o/r#1", "Reply with the comment."]);
  for (const argv of [x!, y!]) assert.ok(argv.includes("--skill") && argv.includes("--append-system-prompt"), "the same flags every turn, for the prompt cache");
});

test("every turn gets --session-id <conversation id>: pi opens it if it exists, else creates it (no other history flag exists)", async () => {
  const r = rig();
  const c = open(r.req(), r.deps);
  await send(c, "one", {}, r.deps);
  await send(c, "two", {}, r.deps);
  for (const argv of r.fake.callsOf("run")) {
    const i = argv.indexOf("--session-id");
    assert.equal(argv[i + 1], c.id);
    assert.ok(!argv.includes("--no-session") && !argv.includes("--continue"));
  }
});

test("busy: answers at once with kind busy, no wait, no health change, history untouched", async () => {
  const r = rig({ busy: () => true });
  const c = open(r.req(), r.deps);
  const res = await send(c, "hi", {}, r.deps);
  assert.equal(res.failure?.kind, "busy");
  assert.equal(r.fake.callsOf("run").length, 0);
  assert.equal(getHealth(r.store.db, "pi/k1").lastUsedAt, null);
  assert.equal(getHealth(r.store.db, "pi/k1").lastFailAt, null);
  assert.equal(res.closed, undefined);
  // The lost lock race inside the container is busy too.
  const r2 = rig();
  const c2 = open(r2.req(), r2.deps);
  r2.fake.setModes("busy");
  const res2 = await send(c2, "hi", {}, r2.deps);
  assert.equal(res2.failure?.kind, "busy");
  assert.equal(getHealth(r2.store.db, "pi/k1").lastUsedAt, null);
});

test("a first turn refused with zero tokens drops the tie: row closed, folder gone, result says so", async () => {
  const r = rig();
  const c = open(r.req(), r.deps);
  r.fake.setModes("auth");
  const res = await send(c, "hi", {}, r.deps);
  assert.equal(res.failure?.kind, "auth");
  assert.equal(res.closed, "first-turn-refused");
  const row = r.store.db.prepare("SELECT closed_at, closed_reason FROM conversations WHERE id = ?").get(c.id) as Record<string, unknown>;
  assert.notEqual(row.closed_at, null);
  assert.equal(row.closed_reason, "first-turn-refused");
  assert.ok(!existsSync(sessionDirOf(r, c.id)));
  assert.equal(getSession(r.store.db, "pi", c.id), undefined);
  await assert.rejects(send(c, "again", {}, r.deps), /closed/);
});

test("a later-turn refusal keeps the tie", async () => {
  const r = rig();
  const c = open(r.req(), r.deps);
  assert.equal((await send(c, "one", {}, r.deps)).failure, undefined);
  r.fake.setModes("auth");
  const res = await send(c, "two", {}, r.deps);
  assert.equal(res.failure?.kind, "auth");
  assert.equal(res.closed, undefined);
  assert.ok(existsSync(sessionDirOf(r, c.id)));
  assert.equal(r.store.db.prepare("SELECT closed_at FROM conversations WHERE id = ?").get(c.id)!.closed_at, null);
});

test("firstTurnRefused: quota, rate-limit and auth with zero tokens only", () => {
  const f = (kind: string) => ({ kind, code: "", message: "" }) as never;
  for (const k of ["quota", "rate-limit", "auth"]) assert.equal(firstTurnRefused(f(k), NO_TOKENS, false), true, k);
  for (const k of ["provider", "idle", "timeout", "busy", "no-account"]) assert.equal(firstTurnRefused(f(k), NO_TOKENS, false), false, k);
  assert.equal(firstTurnRefused(f("quota"), { ...NO_TOKENS, output: 3 }, false), false, "tokens were used");
  assert.equal(firstTurnRefused(f("quota"), NO_TOKENS, true), false, "an earlier turn used tokens");
  assert.equal(firstTurnRefused(undefined, NO_TOKENS, false), false);
});

test("close removes the folder and marks the row; twice is fine; send after close is refused; an unknown id throws", async () => {
  const r = rig();
  const c = open(r.req(), r.deps);
  await send(c, "one", {}, r.deps);
  assert.ok(existsSync(sessionDirOf(r, c.id)));
  close(c, r.deps);
  assert.ok(!existsSync(sessionDirOf(r, c.id)));
  assert.equal(r.store.db.prepare("SELECT closed_reason FROM conversations WHERE id = ?").get(c.id)!.closed_reason, "closed");
  assert.equal(getSession(r.store.db, "pi", c.id), undefined);
  close(c.id, r.deps);
  await assert.rejects(send(c, "x", {}, r.deps), /closed/);
  assert.throws(() => close("nope", r.deps), /unknown conversation/);
  assert.equal(r.fake.callsOf("run").length, 1);
});

test("a conversation never moves: a dead account refuses, even with another account free", async () => {
  const r = rig();
  const c = open(r.req(), r.deps);
  await send(c, "one", {}, r.deps);
  setState(r.store.db, "pi/k1", "dead", "401", NOW);
  const res = await send(c, "two", {}, r.deps);
  assert.equal(res.failure?.kind, "no-account");
  assert.equal(r.fake.callsOf("run").length, 1, "k2 was not used");
});

test("onOutput is passed through", async () => {
  const r = rig();
  const c = open(r.req(), r.deps);
  let seen = "";
  await send(c, "hi", { onOutput: (s) => (seen += s) }, r.deps);
  assert.ok(seen.length > 0);
});

// --- claude and codex ---

/** A login made fresh for the test: an empty folder, never a real login. */
function withLogin(r: ReturnType<typeof rig>, runner: "claude" | "codex", name: string): string {
  addAccount(r.store.db, { runner, name, kind: "login" }, NOW);
  const dir = join(r.home.accounts, runner, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const filesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(".jsonl"));
const mountOf = (argv: string[], target: string): string | undefined => argv.find((a, i) => argv[i - 1] === "--mount" && a.endsWith(`,target=${target}`))?.split(",")[1]!.replace("source=", "");

test("claude: open, send, send on one account: --session-id then --resume, only the new text, the transcript in the conversation folder only", async () => {
  const r = rig();
  const login = withLogin(r, "claude", "a1");
  r.fake.setModes("claude-conv");
  const c = open(r.req({ runner: "claude", account: "claude/a1", model: "claude-opus-5-5", system: "be brief" }), r.deps);
  const uuid = uuidOfUlid(c.id);
  const a = await send(c, "first", {}, r.deps);
  const b = await send(c, "second", {}, r.deps);
  assert.equal(a.failure, undefined);
  assert.equal(b.failure, undefined);
  assert.equal(b.account, "claude/a1");
  const [x, y] = r.fake.callsOf("run");
  assert.deepEqual(x!.slice(x!.indexOf("--permission-mode") + 2, x!.indexOf("--strict-mcp-config")), ["--session-id", uuid]);
  assert.deepEqual(y!.slice(y!.indexOf("--permission-mode") + 2, y!.indexOf("--strict-mcp-config")), ["--resume", uuid]);
  for (const argv of [x!, y!]) {
    assert.ok(!argv.includes("--no-session-persistence"));
    assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], "be brief", "the system prompt is a flag, on every turn");
    assert.equal(argv[argv.indexOf("-w") + 1], r.cwd, "the same cwd every turn: the transcript folder is named after it");
  }
  assert.deepEqual(r.fake.stdins(), ["first", "second"]);
  const dir = join(r.home.sessions, "claude", "a1", c.id);
  assert.equal(mountOf(x!, "/claude/projects"), dir);
  assert.deepEqual(filesUnder(dir), [join(r.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${uuid}.jsonl`)]);
  assert.deepEqual(filesUnder(login), [], "no transcript in the login folder");
  assert.deepEqual(readdirSync(join(login, "projects")), [], "only the empty mount point");
  assert.deepEqual(rows(r).map((p) => [p.account, p.session_id]), [["claude/a1", c.id], ["claude/a1", c.id]]);
  // claude reports a resumed session's running cost: 0.0477306, then 0.0977306. Turn two spent 0.05.
  const costs = (r.store.db.prepare("SELECT cli_cost_usd FROM passes ORDER BY rowid").all() as { cli_cost_usd: number }[]).map((p) => p.cli_cost_usd);
  assert.equal(costs[0], 0.0477306);
  assert.ok(Math.abs(costs[1]! - 0.05) < 1e-9, String(costs[1]));
  close(c, r.deps);
  assert.ok(!existsSync(dir));
  assert.equal(r.store.db.prepare("SELECT closed_reason FROM conversations WHERE id = ?").get(c.id)!.closed_reason, "closed");
});

test("claude: a transcript under another cwd's folder is refused before any container starts", async () => {
  const r = rig();
  withLogin(r, "claude", "a1");
  r.fake.setModes("claude-conv");
  const c = open(r.req({ runner: "claude", account: "claude/a1", model: "claude-opus-5-5" }), r.deps);
  await send(c, "first", {}, r.deps);
  const dir = join(r.home.sessions, "claude", "a1", c.id);
  renameSync(join(dir, r.cwd.replace(/[^a-zA-Z0-9]/g, "-")), join(dir, "-somewhere-else"));
  await assert.rejects(send(c, "second", {}, r.deps), /transcript is under -somewhere-else, not under the folder of cwd .*must run in the cwd the conversation started in/);
  assert.equal(r.fake.callsOf("run").length, 1);
  assert.equal(rows(r).length, 1, "no pass row for the refused turn");
});

test("claude and codex: a new conversation on the same account never sees another's history", async () => {
  const r = rig();
  withLogin(r, "claude", "a1");
  withLogin(r, "codex", "c1");
  r.fake.setModes("claude-conv");
  const c1 = open(r.req({ runner: "claude", account: "claude/a1", model: "claude-opus-5-5" }), r.deps);
  await send(c1, "one", {}, r.deps);
  const c2 = open(r.req({ runner: "claude", account: "claude/a1", model: "claude-opus-5-5" }), r.deps);
  await send(c2, "two", {}, r.deps);
  const [x, y] = r.fake.callsOf("run");
  assert.notEqual(mountOf(x!, "/claude/projects"), mountOf(y!, "/claude/projects"));
  assert.equal(y![y!.indexOf("--session-id") + 1], uuidOfUlid(c2.id), "a fresh transcript, not a resume");
  assert.notEqual(uuidOfUlid(c1.id), uuidOfUlid(c2.id));
  r.fake.setModes("codex-conv");
  const k1 = open(r.req({ runner: "codex", account: "codex/c1", model: "gpt-6.1-sol" }), r.deps);
  await send(k1, "one", {}, r.deps);
  const k2 = open(r.req({ runner: "codex", account: "codex/c1", model: "gpt-6.1-sol" }), r.deps);
  await send(k2, "two", {}, r.deps);
  const [, , p, q] = r.fake.callsOf("run");
  assert.notEqual(mountOf(p!, "/codex/sessions"), mountOf(q!, "/codex/sessions"));
  assert.ok(!q!.includes("resume"), "the second conversation starts its own thread");
});

test("codex: open, send, send on one account: the thread id is kept, the next turn resumes it with only the new text, and counts only its own tokens", async () => {
  const r = rig();
  const login = withLogin(r, "codex", "c1");
  r.fake.setModes("codex-conv");
  const c = open(r.req({ runner: "codex", account: "codex/c1", model: "gpt-6.1-sol", system: "be brief" }), r.deps);
  const a = await send(c, "first", {}, r.deps);
  assert.equal(a.failure, undefined);
  const row = () => r.store.db.prepare("SELECT resume_id, resume_totals FROM conversations WHERE id = ?").get(c.id) as { resume_id: string | null; resume_totals: string | null };
  assert.equal(row().resume_id, "00000000-0000-7000-8000-000000000003");
  const b = await send(c, "second", {}, r.deps);
  assert.equal(b.failure, undefined);
  const [x, y] = r.fake.callsOf("run");
  assert.ok(!x!.includes("--ephemeral") && !x!.includes("resume"));
  assert.ok(!y!.includes("--ephemeral"));
  assert.deepEqual(y!.slice(-3), ["resume", "00000000-0000-7000-8000-000000000003", "-"]);
  assert.deepEqual(r.fake.stdins(), ["be brief\n\nfirst", "second"], "a resumed thread has the system text already");
  // codex said 14081/5 after turn one and 29081/12 after turn two: turn two spent 15000/7.
  assert.deepEqual([a.usage.input, a.usage.output], [14081, 5]);
  assert.deepEqual([b.usage.input, b.usage.output], [15000, 7]);
  // Both pass ids come from the same fake millisecond, so insert order, not id order.
  assert.deepEqual(r.store.db.prepare("SELECT input, output FROM passes ORDER BY rowid").all().map((p) => [p.input, p.output]), [[14081, 5], [15000, 7]]);
  assert.equal((JSON.parse(row().resume_totals!) as { usage: { input: number } }).usage.input, 29081, "the next turn subtracts codex's latest total");
  const dir = join(r.home.sessions, "codex", "c1", c.id);
  assert.equal(mountOf(x!, "/codex/sessions"), dir);
  assert.equal(filesUnder(dir).length, 1);
  assert.deepEqual(filesUnder(login), [], "no rollout in the login folder");
  close(c, r.deps);
  assert.ok(!existsSync(dir));
});

test("codex: a kept thread id with no rollout on disk starts a new thread", async () => {
  const r = rig();
  withLogin(r, "codex", "c1");
  r.fake.setModes("codex-conv");
  const c = open(r.req({ runner: "codex", account: "codex/c1", model: "gpt-6.1-sol" }), r.deps);
  await send(c, "first", {}, r.deps);
  const dir = join(r.home.sessions, "codex", "c1", c.id);
  for (const f of filesUnder(dir)) renameSync(join(dir, f), join(dir, "gone.txt"));
  await send(c, "second", {}, r.deps);
  const [, y] = r.fake.callsOf("run");
  assert.ok(!y!.includes("resume"));
});

test("runPass: claude and codex keep a session only inside a conversation", async () => {
  const r = rig();
  withLogin(r, "claude", "a1");
  await assert.rejects(runPass({ runner: "claude", model: "claude-opus-5-5", prompt: "x", account: "claude/a1", cwd: r.cwd, caller: { flow: "f", action: "a" }, session: "s1" }, r.deps), /keeps a session only in a conversation/);
});
