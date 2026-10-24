import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeFakeDocker } from "../test/fake-docker.ts";
import { addAccount, getHealth, setState } from "./accounts/store.ts";
import { close, firstTurnRefused, open, send, type OpenRequest } from "./conversations.ts";
import { ensureHome, layoutOf } from "./home.ts";
import { makeLog } from "./log.ts";
import type { RunDeps } from "./run.ts";
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

test("open refuses codex and claude, an unknown, dead or disabled account, and a runner mismatch", () => {
  const r = rig();
  addAccount(r.store.db, { runner: "codex", name: "c1", kind: "login" }, NOW);
  addAccount(r.store.db, { runner: "claude", name: "a1", kind: "login" }, NOW);
  assert.throws(() => open(r.req({ runner: "codex", account: "codex/c1" }), r.deps), /codex.*not yet|not supported yet/);
  assert.throws(() => open(r.req({ runner: "claude", account: "claude/a1" }), r.deps), /claude.*not yet|not supported yet/);
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
  assert.equal(x!.at(-1), "/skill:todo-exec issue=o/r#1");
  assert.equal(y!.at(-1), "Reply with the comment.");
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
