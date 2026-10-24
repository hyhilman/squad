import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { makeFakeDocker } from "../test/fake-docker.ts";
import { addAccount, getAccount, getHealth, putHealth, roomSince, setState } from "./accounts/store.ts";
import { emptyHealth } from "./accounts/health.ts";
import { getSession } from "./sessions.ts";
import { ensureHome, layoutOf, type HomeLayout } from "./home.ts";
import { makeLog } from "./log.ts";
import { runPass, type PassRequest, type RunDeps } from "./run.ts";
import { openStore, type Store } from "./store/db.ts";
import { findForbidden } from "@squad/contract";
import { chmodSync } from "node:fs";
import { bundledPath } from "./paths.ts";
import { recordPriceHistory } from "./prices.ts";

interface Rig {
  home: HomeLayout;
  store: Store;
  cwd: string;
  fake: ReturnType<typeof makeFakeDocker>;
  deps: RunDeps;
}

const NOW = new Date("2026-10-24T12:00:00.000Z");

/** A throwaway home with fake key accounts (fresh made-up files, never a real login). */
function rig(keys: string[] = ["k1"], more: Partial<RunDeps> = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "run-"));
  const home = layoutOf(join(root, "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  for (const name of keys) {
    addAccount(store.db, { runner: "pi", name, kind: "key" }, NOW);
    mkdirSync(join(home.accounts, "pi", name), { recursive: true });
    writeFileSync(join(home.accounts, "pi", name, "auth.json"), '{"fake":"not-a-real-key"}');
  }
  const cwd = join(root, "work");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const fake = makeFakeDocker(join(root, "bin"));
  const deps: RunDeps = {
    home,
    store,
    now: () => NOW,
    docker: fake.path,
    project: "proj",
    identity: { name: "Bot", email: "bot@example.com" },
    user: null,
    log: makeLog(() => {}),
    env: { SQUAD_STOP_GRACE_S: "7" },
    ...more,
  };
  return { home, store, cwd, fake, deps };
}

const req = (r: Rig, more: Partial<PassRequest> = {}): PassRequest => ({
  runner: "pi",
  model: "opencode-go/hy4-preview",
  prompt: "say ok",
  pool: "all",
  cwd: r.cwd,
  caller: { flow: "fix", action: "fix:pi" },
  ...more,
});

const passes = (r: Rig) => r.store.db.prepare("SELECT * FROM passes ORDER BY id").all() as Record<string, unknown>[];
const mountsOf = (argv: string[]): { source: string; target: string }[] =>
  argv.flatMap((a, i) => (argv[i - 1] === "--mount" ? [a] : [])).map((m) => {
    const f = Object.fromEntries(m.split(",").map((kv) => kv.split("=") as [string, string]));
    return { source: f.source!, target: f.target! };
  });

test("ok: one pass row with the tokens, health updated, the key copy gone, one account mount that is the copy", async () => {
  const r = rig();
  const res = await runPass(req(r), r.deps);
  assert.equal(res.failure, undefined);
  assert.equal(res.text, "ok");
  assert.equal(res.account, "pi/k1");
  assert.equal(res.turns, 1);
  const rows = passes(r);
  assert.equal(rows.length, 1);
  const p = rows[0]!;
  assert.deepEqual([p.input, p.output, p.cache_read, p.cache_write, p.reasoning], [1493, 71, 64, 0, 68]);
  assert.equal(p.outcome, "ok");
  assert.equal(p.account, "pi/k1");
  assert.equal(p.exit_code, 0);
  assert.equal(p.id, res.passId);
  assert.equal(getHealth(r.store.db, "pi/k1").lastOkAt, NOW.toISOString());
  assert.deepEqual(readdirSync(r.home.staging), [], "the copy is gone");
  const runs = r.fake.callsOf("run");
  assert.equal(runs.length, 1);
  const acct = mountsOf(runs[0]!).filter((m) => m.target === "/pi");
  assert.equal(acct.length, 1);
  assert.ok(acct[0]!.source.startsWith(r.home.staging));
  assert.ok(acct[0]!.source.includes(`-${res.passId}-`), "gc tells the owner of a copy by the pass id in its name");
  assert.notEqual(acct[0]!.source, join(r.home.accounts, "pi", "k1"));
  assert.ok(!mountsOf(runs[0]!).some((m) => m.source.includes(r.home.accounts)), "no mount of the real folder");
  assert.equal(runs[0]!.at(-1), "say ok");
});

test("the raw stdout and the prompt go gzipped to logs/passes/<date>/<passId>.{log,prompt}.gz with mode 0600", async () => {
  const r = rig();
  const res = await runPass(req(r), r.deps);
  assert.equal(res.logPath, join(r.home.passLogs, "2026-10-24", `${res.passId}.log.gz`));
  assert.equal(statSync(res.logPath!).mode & 0o777, 0o600);
  assert.equal(gunzipSync(readFileSync(res.logPath!)).toString("utf8"), readFileSync(join(import.meta.dirname, "..", "test/fixtures/captures/pi/ok.jsonl"), "utf8"));
  const prompt = join(r.home.passLogs, "2026-10-24", `${res.passId}.prompt.gz`);
  assert.equal(statSync(prompt).mode & 0o777, 0o600);
  assert.equal(gunzipSync(readFileSync(prompt)).toString("utf8"), "say ok");
  assert.deepEqual(readdirSync(join(r.home.passLogs, "2026-10-24")).sort(), [`${res.passId}.log.gz`, `${res.passId}.prompt.gz`]);
});

test("a pass with no account writes no log and no prompt", async () => {
  const r = rig([]);
  const res = await runPass(req(r), r.deps);
  assert.equal(res.failure?.kind, "no-account");
  assert.equal(res.logPath, null);
  assert.deepEqual(readdirSync(r.home.passLogs), []);
});

test("free-tier 403: a provider failure that leaves the key account healthy", async () => {
  const r = rig();
  r.fake.setModes("free-tier");
  const res = await runPass(req(r), r.deps);
  assert.deepEqual([res.failure?.kind, res.failure?.code], ["provider", "403:FreeTierError"]);
  const h = getHealth(r.store.db, "pi/k1");
  assert.equal(h.suspectSince, null);
  assert.equal(h.authFails, 0);
  assert.equal(getAccount(r.store.db, "pi/k1")!.state, "active");
});

test("auth 401: suspect, then the second auth kills the account and writes events", async () => {
  const r = rig();
  r.fake.setModes("auth");
  const first = await runPass(req(r), r.deps);
  assert.equal(first.failure?.kind, "auth");
  assert.equal(first.failure?.code, "401:AuthError");
  let h = getHealth(r.store.db, "pi/k1");
  assert.equal(h.authFails, 1);
  assert.equal(h.suspectSince, NOW.toISOString());
  assert.equal(getAccount(r.store.db, "pi/k1")!.state, "active");
  const row = passes(r)[0]!;
  assert.deepEqual([row.outcome, row.fail_kind, row.fail_code], ["fail", "auth", "401:AuthError"]);
  // A suspect account waits for a probe, so no pass picks it. The probe is stood in by clearing the mark.
  const none = await runPass(req(r), r.deps);
  assert.equal(none.failure?.kind, "no-account");
  r.store.db.prepare("UPDATE health SET suspect_since = NULL WHERE account = 'pi/k1'").run();
  const second = await runPass(req(r), r.deps);
  assert.equal(second.failure?.kind, "auth");
  h = getHealth(r.store.db, "pi/k1");
  assert.equal(h.authFails, 2);
  const acct = getAccount(r.store.db, "pi/k1")!;
  assert.equal(acct.state, "dead");
  assert.equal(acct.deadCode, "401:AuthError");
  const ev = r.store.db.prepare("SELECT kind, account, code, pass_id FROM events ORDER BY id").all().map((e) => ({ ...e }));
  assert.deepEqual(ev, [
    { kind: "auth-fail", account: "pi/k1", code: "401:AuthError", pass_id: first.passId },
    { kind: "dead", account: "pi/k1", code: "401:AuthError", pass_id: second.passId },
  ]);
});

test("busy then ok: the lost race ends its row as busy, with no health change, and the next account runs", async () => {
  const r = rig(["k1", "k2"]);
  r.fake.setModes("busy", "ok");
  const res = await runPass(req(r), r.deps);
  assert.equal(res.failure, undefined);
  const rows = passes(r);
  assert.equal(rows.length, 2);
  const busyRow = rows.find((p) => p.outcome === "busy")!;
  const okRow = rows.find((p) => p.outcome === "ok")!;
  assert.notEqual(busyRow.account, okRow.account);
  assert.equal(res.account, okRow.account);
  assert.equal(busyRow.exit_code, 75);
  const busyHealth = getHealth(r.store.db, busyRow.account as string);
  assert.equal(busyHealth.lastOkAt, null);
  assert.equal(busyHealth.lastFailAt, null);
  assert.equal(busyHealth.lastUsedAt, null);
  assert.deepEqual(readdirSync(r.home.staging), []);
});

test("both busy: no-account, and every attempt left a busy row", async () => {
  const r = rig(["k1", "k2"]);
  r.fake.setModes("busy");
  const res = await runPass(req(r), r.deps);
  assert.equal(res.failure?.kind, "no-account");
  assert.equal(res.account, null);
  assert.deepEqual(passes(r).map((p) => p.outcome).sort(), ["busy", "busy", "no-account"]);
});

test("no accounts at all: no-account at once, with a row that has no account", async () => {
  const r = rig([]);
  const res = await runPass(req(r), r.deps);
  assert.equal(res.failure?.kind, "no-account");
  assert.equal(r.fake.calls().length, 0);
  const rows = passes(r);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.outcome, rows[0]!.account, rows[0]!.fail_kind], ["no-account", null, "no-account"]);
  assert.equal(res.passId, rows[0]!.id);
});

test("a named account that the host probe says is busy gives busy, and nothing starts", async () => {
  const r = rig(["k1"], { busy: () => true });
  const res = await runPass(req(r, { pool: undefined, account: "pi/k1" }), r.deps);
  assert.equal(res.failure?.kind, "busy");
  assert.equal(r.fake.calls().length, 0);
  assert.equal(passes(r)[0]!.outcome, "busy");
});

test("exactly one of pool and account", async () => {
  const r = rig();
  await assert.rejects(() => runPass(req(r, { pool: undefined }), r.deps), /pool.*account/);
  await assert.rejects(() => runPass(req(r, { account: "pi/k1" }), r.deps), /pool.*account/);
});

test("idle: the pass is stopped with the grace time, and the kind is idle", async () => {
  const r = rig();
  r.fake.setModes("hang");
  const res = await runPass(req(r, { idleMs: 300 }), r.deps);
  assert.equal(res.failure?.kind, "idle");
  const stops = r.fake.callsOf("stop");
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0]!.slice(0, 3), ["stop", "-t", "7"]);
  assert.match(stops[0]![3]!, /^squad-/);
  assert.equal(passes(r)[0]!.fail_kind, "idle");
  assert.equal(getHealth(r.store.db, "pi/k1").lastFailKind, "idle");
  assert.deepEqual(readdirSync(r.home.staging), []);
});

test("deadline: the same stop, and the kind is timeout", async () => {
  const r = rig();
  r.fake.setModes("hang");
  const res = await runPass(req(r, { idleMs: 60_000, deadlineMs: 300 }), r.deps);
  assert.equal(res.failure?.kind, "timeout");
  assert.equal(r.fake.callsOf("stop").length, 1);
  assert.equal(getAccount(r.store.db, "pi/k1")!.state, "active");
});

test("a crash without agent_end and exit 3 is a provider failure with code exit:3", async () => {
  const r = rig();
  r.fake.setModes("crash");
  const res = await runPass(req(r), r.deps);
  assert.equal(res.failure?.kind, "provider");
  assert.equal(res.failure?.code, "exit:3");
  assert.equal(passes(r)[0]!.exit_code, 3);
  assert.equal(getHealth(r.store.db, "pi/k1").lastFailCode, "exit:3");
});

test("dead and disabled accounts are never picked", async () => {
  const r = rig(["k1", "k2", "k3"]);
  r.store.db.prepare("UPDATE accounts SET state = 'dead' WHERE id = 'pi/k1'").run();
  r.store.db.prepare("UPDATE accounts SET state = 'disabled' WHERE id = 'pi/k2'").run();
  const res = await runPass(req(r), r.deps);
  assert.equal(res.account, "pi/k3");
  const named = await runPass(req(r, { pool: undefined, account: "pi/k1" }), r.deps);
  assert.equal(named.failure?.kind, "no-account");
  assert.equal(r.fake.callsOf("run").length, 1);
});

test("a cooling account is skipped", async () => {
  const r = rig(["k1", "k2"]);
  putHealth(r.store.db, { ...getHealth(r.store.db, "pi/k1"), coolUntil: "2026-10-24T12:05:00.000Z", coolKind: "rate-limit" });
  const res = await runPass(req(r), r.deps);
  assert.equal(res.account, "pi/k2");
});

test("a login account mounts its real folder and its lock file, and is never copied", async () => {
  const r = rig([], { busy: () => false });
  addAccount(r.store.db, { runner: "pi", name: "l1", kind: "login" }, NOW);
  const dir = join(r.home.accounts, "pi", "l1");
  mkdirSync(dir, { recursive: true });
  const res = await runPass(req(r), r.deps);
  assert.equal(res.account, "pi/l1");
  const lock = join(r.home.locks, "pi", "l1.lock");
  assert.ok(existsSync(lock));
  assert.equal(statSync(lock).mode & 0o777, 0o600);
  const m = mountsOf(r.fake.callsOf("run")[0]!);
  assert.deepEqual(m.filter((x) => x.target === "/pi"), [{ source: dir, target: "/pi" }]);
  assert.deepEqual(m.filter((x) => x.target === "/squad/lock"), [{ source: lock, target: "/squad/lock" }]);
  assert.deepEqual(readdirSync(r.home.staging), []);
});

test("an ok pass writes one usage export: the header names project/flow/action, one message line, mode 0600", async () => {
  const r = rig();
  const res = await runPass(req(r), r.deps);
  assert.deepEqual(readdirSync(r.home.usageExport), [`${res.passId}.jsonl`]);
  const file = join(r.home.usageExport, `${res.passId}.jsonl`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0]!.type, lines[0]!.id, lines[0]!.cwd], ["session", res.passId, "proj/fix/fix:pi"]);
  assert.equal(lines[1]!.type, "message");
  assert.equal(lines[1]!.id, `${res.passId}:6`);
  assert.deepEqual(lines[1]!.message.content, []);
  assert.equal(lines[1]!.message.usage.input, 1493);
});

test("SQUAD_NO_USAGE_EXPORT=1 turns the export off", async () => {
  const r = rig(["k1"], { env: { SQUAD_NO_USAGE_EXPORT: "1" } });
  await runPass(req(r), r.deps);
  assert.deepEqual(readdirSync(r.home.usageExport), []);
});

test("a failing export logs a warning and the pass still succeeds", async () => {
  const lines: string[] = [];
  const r = rig();
  writeFileSync(join(r.home.root, "blocker"), "");
  const deps = { ...r.deps, home: { ...r.home, usageExport: join(r.home.root, "blocker", "pi") }, log: makeLog((l) => lines.push(l)) };
  const res = await runPass(req(r), deps);
  assert.equal(res.failure, undefined);
  assert.ok(lines.some((l) => l.includes("level=warn event=usage-export-failed")));
});

const CATALOG = { "opencode-go": { models: { "hy4-preview": { cost: { input: 0.15, output: 0.5, cache_read: 0.03 } } } } };

test("a key pass with a price has cost_usd and price_src", async () => {
  const r = rig();
  writeFileSync(join(r.home.state, "prices.json"), JSON.stringify({ v: 1, fetchedAt: NOW.getTime(), catalog: CATALOG }));
  await runPass(req(r), r.deps);
  const p = passes(r)[0]!;
  assert.ok(Math.abs((p.cost_usd as number) - (1493 * 0.15 + 71 * 0.5 + 64 * 0.03) / 1e6) < 1e-12);
  assert.equal(p.price_src, "catalog");
});

test("a key pass with an unknown model has no cost and no price_src", async () => {
  const r = rig();
  writeFileSync(join(r.home.state, "prices.json"), JSON.stringify({ v: 1, fetchedAt: NOW.getTime(), catalog: { other: CATALOG["opencode-go"] } }));
  await runPass(req(r), r.deps);
  const p = passes(r)[0]!;
  assert.deepEqual([p.cost_usd, p.price_src], [null, null]);
});

test("a login pass has no cost, even with a price", async () => {
  const r = rig([], { busy: () => false });
  writeFileSync(join(r.home.state, "prices.json"), JSON.stringify({ v: 1, fetchedAt: NOW.getTime(), catalog: CATALOG }));
  addAccount(r.store.db, { runner: "pi", name: "l1", kind: "login" }, NOW);
  mkdirSync(join(r.home.accounts, "pi", "l1"), { recursive: true });
  await runPass(req(r), r.deps);
  const p = passes(r)[0]!;
  assert.deepEqual([p.account, p.cost_usd, p.price_src], ["pi/l1", null, null]);
});

// ---- claude ----

const FAKE_TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

/** A rig with one claude token account `claude/t1` whose file holds a made-up token. */
function claudeRig(more: Partial<RunDeps> = {}): Rig {
  const r = rig([], more);
  addAccount(r.store.db, { runner: "claude", name: "t1", kind: "token" }, NOW);
  const dir = join(r.home.accounts, "claude", "t1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "token"), FAKE_TOKEN, { mode: 0o600 });
  r.fake.setModes("claude-ok");
  return r;
}

const claudeReq = (r: Rig, more: Partial<PassRequest> = {}): PassRequest => req(r, { runner: "claude", model: "claude-opus-5-5", prompt: "say ok", action: undefined, ...more } as Partial<PassRequest>);

test("claude token pass: the prompt goes on stdin, not in the argv; tokens, model and room are recorded", async () => {
  const r = claudeRig();
  const res = await runPass(claudeReq(r, { prompt: "say the word ok" }), r.deps);
  assert.equal(res.failure, undefined);
  assert.equal(res.account, "claude/t1");
  assert.equal(res.model, "claude-opus-5-5");
  const runs = r.fake.callsOf("run");
  assert.equal(runs.length, 1);
  assert.deepEqual(r.fake.stdins(), ["say the word ok"]);
  assert.ok(!runs[0]!.some((a) => a.includes("say the word ok")), "the prompt is not in the argv");
  const p = passes(r)[0]!;
  assert.deepEqual([p.input, p.output, p.cache_read, p.cache_write], [2, 4, 11333, 5672]);
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.outcome, "ok");
  assert.equal(p.cost_usd, null);
  const h = getHealth(r.store.db, "claude/t1");
  assert.deepEqual([h.left5h, h.leftWeek], [92, 70]);
  assert.deepEqual(roomSince(r.store.db, "claude/t1", new Date(0)), [{ at: NOW.toISOString(), source: "pass", left5h: 92, leftWeek: 70 }], "the history keeps the reading");
});

test("claude token pass: the usage export holds exactly one message line from the result tokens", async () => {
  const r = claudeRig();
  const res = await runPass(claudeReq(r), r.deps);
  const lines = readFileSync(join(r.home.usageExport, `${res.passId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.type, "session");
  assert.equal(lines[1]!.type, "message");
  const u = lines[1]!.message.usage;
  assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [2, 4, 11333, 5672]);
  assert.equal(lines[1]!.message.model, "claude-opus-5-5");
});

test("claude token pass: mounts only the token file, no /claude, and no token text in the argv", async () => {
  const r = claudeRig();
  await runPass(claudeReq(r), r.deps);
  const argv = r.fake.callsOf("run")[0]!;
  const m = mountsOf(argv);
  assert.ok(!m.some((x) => x.target === "/claude" || x.target.startsWith("/claude/")), "no mount at /claude");
  assert.deepEqual(m.filter((x) => x.target === "/squad/token"), [{ source: join(r.home.accounts, "claude", "t1", "token"), target: "/squad/token" }]);
  assert.ok(argv.includes("SQUAD_TOKEN_FILE=/squad/token"));
  const text = argv.join("\n");
  assert.ok(!text.includes("sk-ant-oat01"), "no token text");
  assert.ok(!text.includes("FAKEFAKE"));
  assert.equal(findForbidden(text), undefined);
  assert.deepEqual(readdirSync(r.home.staging), [], "a token account is not copied");
});

test("claude login account: the real folder at /claude and the lock, as pi", async () => {
  const r = rig([], { busy: () => false });
  addAccount(r.store.db, { runner: "claude", name: "l1", kind: "login" }, NOW);
  const dir = join(r.home.accounts, "claude", "l1");
  mkdirSync(dir, { recursive: true });
  const res = await runPass(claudeReq(r), { ...r.deps });
  assert.equal(res.account, "claude/l1");
  const m = mountsOf(r.fake.callsOf("run")[0]!);
  assert.deepEqual(m.filter((x) => x.target === "/claude"), [{ source: dir, target: "/claude" }]);
  assert.equal(m.filter((x) => x.target === "/squad/lock").length, 1);
});

test("pi keeps stdin empty: the prompt is the last argument", async () => {
  const r = rig();
  await runPass(req(r), r.deps);
  assert.deepEqual(r.fake.stdins(), [""]);
});

test("a pass with all-zero usage (the pi auth error) writes no usage export", async () => {
  const r = rig();
  r.fake.setModes("auth");
  const res = await runPass(req(r), r.deps);
  assert.equal(res.failure?.kind, "auth");
  assert.deepEqual(readdirSync(r.home.usageExport), []);
});

test("an unsupported runner is refused", async () => {
  const r = rig();
  await assert.rejects(() => runPass(req(r, { runner: "dsh" as never }), r.deps), /not supported/);
});

test("the pass row keeps the model the stream reports, not the one asked for", async () => {
  const r = claudeRig();
  await runPass(claudeReq(r, { model: "claude-sonnet-5-5" }), r.deps);
  assert.equal(passes(r)[0]!.model, "claude-opus-5-5");
});

// --- sessions (pi only) ---

const sessionMount = (argv: string[]) => mountsOf(argv).filter((m) => m.target === "/squad/sessions");

test("session, first pass: its own folder (0700, empty) is mounted, pi gets the session flags, the rows carry the id", async () => {
  const r = rig();
  const res = await runPass(req(r, { session: "s1" }), r.deps);
  assert.equal(res.failure, undefined);
  const dir = join(r.home.sessions, "pi", "k1", "s1");
  const run = r.fake.callsOf("run")[0]!;
  assert.deepEqual(sessionMount(run), [{ source: dir, target: "/squad/sessions" }]);
  const i = run.indexOf("--session-dir");
  assert.deepEqual(run.slice(i, i + 4), ["--session-dir", "/squad/sessions", "--session-id", "s1"]);
  assert.ok(i < run.indexOf("--"), "the flags come before the prompt");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(passes(r)[0]!.session_id, "s1");
  const s = getSession(r.store.db, "pi", "s1")!;
  assert.deepEqual([s.account, s.createdAt, s.lastUsedAt], ["pi/k1", NOW.toISOString(), NOW.toISOString()]);
  assert.ok(!mountsOf(run).some((m) => m.source === r.home.sessions), "never the sessions root");
});

test("a pass without a session has no session mount and no session flags", async () => {
  const r = rig();
  await runPass(req(r), r.deps);
  const run = r.fake.callsOf("run")[0]!;
  assert.deepEqual(sessionMount(run), []);
  assert.ok(!run.includes("--session-dir"));
});

test("session follow-up: same account even when another is less used; the folder is kept; last_used moves", async () => {
  const r = rig(["k1", "k2"]);
  const t = { now: NOW };
  const first = await runPass(req(r, { session: "s1" }), { ...r.deps, now: () => t.now });
  assert.equal(first.account, "pi/k1");
  writeFileSync(join(r.home.sessions, "pi", "k1", "s1", "transcript.jsonl"), "{}\n");
  t.now = new Date("2026-10-24T13:00:00.000Z");
  const second = await runPass(req(r, { session: "s1" }), { ...r.deps, now: () => t.now });
  assert.equal(second.account, "pi/k1", "k2 is less used, but the session is pinned");
  assert.deepEqual(readdirSync(join(r.home.sessions, "pi", "k1", "s1")), ["transcript.jsonl"]);
  const s = getSession(r.store.db, "pi", "s1")!;
  assert.deepEqual([s.createdAt, s.lastUsedAt], [NOW.toISOString(), t.now.toISOString()]);
  assert.equal(passes(r).filter((p) => p.session_id === "s1").length, 2);
});

test("a fresh session empties a leftover folder of that name", async () => {
  const r = rig();
  const dir = join(r.home.sessions, "pi", "k1", "s2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.jsonl"), "old");
  await runPass(req(r, { session: "s2" }), r.deps);
  assert.deepEqual(readdirSync(dir), []);
});

test("a pinned account that cannot run gives no-account that names the reason; the session never moves", async () => {
  const cases: [string, (r: Rig) => Partial<RunDeps> | void, RegExp][] = [
    ["cooling", (r) => putHealth(r.store.db, { ...emptyHealth("pi/k1"), coolUntil: "2026-10-24T12:30:00.000Z", coolKind: "rate-limit" }), /pi\/k1.*cooling/],
    ["dead", (r) => setState(r.store.db, "pi/k1", "dead", "401", NOW), /pi\/k1.*dead/],
    ["busy", (r) => ({ busy: () => true }), /pi\/k1.*busy/],
  ];
  for (const [label, arm, msg] of cases) {
    const r = rig(["k1", "k2"]);
    await runPass(req(r, { session: "s1" }), r.deps);
    const runsBefore = r.fake.callsOf("run").length;
    const more = arm(r) ?? {};
    const res = await runPass(req(r, { session: "s1" }), { ...r.deps, ...more });
    assert.equal(res.failure?.kind, "no-account", label);
    assert.match(res.failure!.message, msg, label);
    assert.match(res.failure!.message, /s1/, label);
    assert.equal(res.account, null);
    assert.equal(r.fake.callsOf("run").length, runsBefore, `${label}: no container`);
    assert.equal(getSession(r.store.db, "pi", "s1")!.account, "pi/k1", label);
    assert.equal(passes(r).at(-1)!.session_id, "s1", `${label}: the refusal row carries the session`);
  }
});

test("a named account other than the pinned one is refused", async () => {
  const r = rig(["k1", "k2"]);
  await runPass(req(r, { session: "s1" }), r.deps);
  const res = await runPass(req(r, { session: "s1", pool: undefined, account: "pi/k2" }), r.deps);
  assert.equal(res.failure?.kind, "no-account");
  assert.match(res.failure!.message, /pinned to pi\/k1/);
});

test("a new session whose first account loses the lock race is pinned to the account that ran it", async () => {
  const r = rig(["k1", "k2"]);
  r.fake.setModes("busy", "ok");
  const res = await runPass(req(r, { session: "s1" }), r.deps);
  assert.equal(res.account, "pi/k2");
  assert.equal(getSession(r.store.db, "pi", "s1")!.account, "pi/k2");
  assert.ok(!existsSync(join(r.home.sessions, "pi", "k1", "s1")), "the folder of the account that did not run is gone");
});

test("a bad session id throws before anything is made", async () => {
  const r = rig();
  for (const bad of ["", "../x", "A", "-a", "a/b", "a".repeat(65)])
    await assert.rejects(runPass(req(r, { session: bad }), r.deps), /session id/, bad);
  assert.equal(passes(r).length, 0);
  assert.equal(r.fake.calls().length, 0);
});

test("claude (and any non-pi runner) refuses a session with a clear error", async () => {
  const r = rig();
  await assert.rejects(runPass(req(r, { runner: "claude", model: "claude-opus-5-5", session: "s1" }), r.deps), /claude.*session|session.*claude/);
  assert.equal(passes(r).length, 0);
  assert.equal(r.fake.calls().length, 0);
});

// ---- codex ----

/** A rig with one codex account of the given kind, holding made-up files only. */
function codexRig(kind: "key" | "login", more: Partial<RunDeps> = {}): Rig {
  const r = rig([], kind === "login" ? { busy: () => false, ...more } : more);
  addAccount(r.store.db, { runner: "codex", name: "c1", kind }, NOW);
  const dir = join(r.home.accounts, "codex", "c1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "auth.json"), '{"fake":"not-a-real-login"}', { mode: 0o600 });
  r.fake.setModes("codex-ok");
  return r;
}

const codexReq = (r: Rig, more: Partial<PassRequest> = {}): PassRequest => req(r, { runner: "codex", model: "gpt-6.1-sol", prompt: "say ok", ...more });

test("codex key pass: prompt on stdin, fresh input and the requested model recorded, usage export written", async () => {
  const r = codexRig("key");
  const res = await runPass(codexReq(r, { prompt: "say the word ok" }), r.deps);
  assert.equal(res.failure, undefined);
  assert.equal(res.account, "codex/c1");
  assert.equal(res.text, "ok");
  assert.deepEqual(res.usage, { input: 14081, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.deepEqual(r.fake.stdins(), ["say the word ok"]);
  assert.ok(!r.fake.callsOf("run")[0]!.includes("say the word ok"));
  const files = readdirSync(r.home.usageExport);
  assert.equal(files.length, 1);
  const lines = readFileSync(join(r.home.usageExport, files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[1].message.provider, "openai");
  assert.equal(lines[1].message.model, "gpt-6.1-sol");
});

test("codex login pass: real folder at /codex, the lock, and a read-only empty config.toml over it, after the account mount", async () => {
  const r = codexRig("login");
  const res = await runPass(codexReq(r), r.deps);
  assert.equal(res.account, "codex/c1");
  const argv = r.fake.callsOf("run")[0]!;
  const m = mountsOf(argv);
  const acct = m.findIndex((x) => x.target === "/codex");
  const over = m.findIndex((x) => x.target === "/codex/config.toml");
  assert.ok(acct >= 0 && over > acct, "the overlay comes after the account mount");
  assert.equal(m[acct]!.source, join(r.home.accounts, "codex", "c1"));
  assert.equal(m[over]!.source, join(r.home.state, "assets", "codex-config.toml"), "the daemon sees the home, not the package");
  assert.ok(argv.some((a) => a.includes("target=/codex/config.toml,readonly")));
  assert.equal(m.filter((x) => x.target === "/squad/lock").length, 1);
  const body = readFileSync(m[over]!.source, "utf8");
  assert.ok(body.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("#")), "only comments");
});

test("codex: the config.toml mount target exists as a user file before the pass, so docker does not make a root-owned one", async () => {
  const r = codexRig("login");
  const target = join(r.home.accounts, "codex", "c1", "config.toml");
  assert.ok(!existsSync(target));
  await runPass(codexReq(r), r.deps);
  assert.ok(existsSync(target));
  assert.equal(statSync(target).uid, process.getuid!());
  assert.equal(statSync(target).mode & 0o777, 0o600);
});

test("codex: the out dir is fresh, outside the home, and gone after the pass", async () => {
  const r = codexRig("key");
  await runPass(codexReq(r), r.deps);
  const out = mountsOf(r.fake.callsOf("run")[0]!).find((x) => x.target === "/squad/out")!;
  assert.ok(!out.source.startsWith(r.home.root) && !out.source.startsWith(r.cwd));
  assert.ok(out.source.startsWith(tmpdir()));
  assert.equal(existsSync(out.source), false);
});

test("codex: the last-message file is used only when the stream has no agent_message", async () => {
  const r = codexRig("key");
  r.fake.setModes("codex-file", "codex-ok");
  const a = await runPass(codexReq(r), r.deps);
  assert.equal(a.text, "from the file");
  assert.deepEqual(a.texts, ["from the file"]);
  const b = await runPass(codexReq(r), r.deps);
  assert.equal(b.text, "ok");
});

test("codex: a token account cannot be added (docker.ts refuses it too)", () => {
  const r = rig([]);
  assert.throws(() => addAccount(r.store.db, { runner: "codex", name: "t", kind: "token" }, NOW), /token/);
});

test("codex: model_not_found is a provider failure, and the account stays alive", async () => {
  const r = codexRig("key");
  r.fake.setModes("codex-model-not-found");
  const res = await runPass(codexReq(r, { model: "no-such-model" }), r.deps);
  assert.equal(res.failure?.kind, "provider");
  assert.equal(res.failure?.code, "model_not_found");
  assert.equal(getAccount(r.store.db, "codex/c1")?.state, "active");
});

test("codex: a refresh_token_reused failure marks the login account dead and writes a dead event", async () => {
  // shape test: the stream is invented (no capture of this failure exists).
  const r = codexRig("login");
  r.fake.setModes("codex-reused");
  const res = await runPass(codexReq(r), r.deps);
  assert.equal(res.failure?.kind, "auth");
  assert.equal(res.failure?.code, "refresh_token_reused");
  assert.equal(getAccount(r.store.db, "codex/c1")?.state, "dead");
  const ev = r.store.db.prepare("SELECT kind, account, code FROM events").all().map((e) => ({ ...e }));
  assert.deepEqual(ev, [{ kind: "dead", account: "codex/c1", code: "refresh_token_reused" }]);
});

test("breaker: a pool whose every account is cooling or dead gets no-account at once, with no container", async () => {
  const r = rig(["k1", "k2"]);
  putHealth(r.store.db, { ...emptyHealth("pi/k1"), coolUntil: new Date(NOW.getTime() + 60_000).toISOString(), coolKind: "rate-limit" });
  setState(r.store.db, "pi/k2", "dead", "x", NOW);
  const res = await runPass(req(r), r.deps);
  assert.equal(res.failure?.kind, "no-account");
  assert.equal(res.failure?.message, "breaker open: every pi account is cooling or dead");
  assert.equal(res.account, null);
  assert.equal(r.fake.callsOf("run").length, 0);
  assert.equal(passes(r).length, 1, "the refusal is a pass row, as any no-account is");
});

test("breaker: closed while one account can run, and a named account is not checked by it", async () => {
  const r = rig(["k1", "k2"]);
  putHealth(r.store.db, { ...emptyHealth("pi/k1"), coolUntil: new Date(NOW.getTime() + 60_000).toISOString(), coolKind: "rate-limit" });
  const res = await runPass(req(r), r.deps);
  assert.equal(res.account, "pi/k2");
  const named = await runPass(req(r, { pool: undefined, account: "pi/k1" }), r.deps);
  assert.ok(!named.failure?.message.startsWith("breaker open"));
});

// ---- standard fields and container options ----

const skillDir = (name = "fix"): string => {
  const d = join(mkdtempSync(join(tmpdir(), "skill-")), name);
  mkdirSync(d);
  writeFileSync(join(d, "SKILL.md"), "---\nname: fix\ndescription: x\n---\n\nStep one.\n");
  return d;
};
const flagValues = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));
const roMount = (argv: string[], target: string): { source: string; ro: boolean } | undefined => {
  const m = flagValues(argv, "--mount").find((x) => x.includes(`target=${target}`));
  return m === undefined ? undefined : { source: m.split(",")[1]!.replace("source=", ""), ro: m.endsWith(",readonly") };
};
const noContainer = (r: Rig): void => {
  assert.equal(r.fake.calls().length, 0, "no docker call");
  assert.equal(passes(r).length, 0, "no pass row");
};

test("pi: system, skill and effort become --append-system-prompt, --skill (a read-only mount) and --thinking", async () => {
  const r = rig();
  const dir = skillDir();
  await runPass(req(r, { system: "be brief", skill: { name: "fix", dir }, effort: "high", prompt: "go" }), r.deps);
  const argv = r.fake.callsOf("run")[0]!;
  assert.deepEqual(flagValues(argv, "--append-system-prompt"), ["be brief"]);
  assert.deepEqual(flagValues(argv, "--skill"), ["/skills/fix"]);
  assert.deepEqual(flagValues(argv, "--thinking"), ["high"]);
  assert.deepEqual(roMount(argv, "/skills/fix"), { source: dir, ro: true });
  assert.equal(argv.at(-1), "/skill:fix go");
});

test("codex: stdin is system, a blank line, the skill text without front matter, a blank line, the message; effort is -c", async () => {
  const r = codexRig("key");
  await runPass(codexReq(r, { system: "SYS", skill: { name: "fix", dir: skillDir() }, effort: "max", prompt: "MSG" }), r.deps);
  assert.deepEqual(r.fake.stdins(), ["SYS\n\nStep one.\n\nMSG"]);
  const argv = r.fake.callsOf("run")[0]!;
  assert.deepEqual(flagValues(argv, "-c"), ["model_reasoning_effort=max"]);
  assert.ok(!argv.includes("--append-system-prompt") && !argv.includes("--skill"));
});

test("codex: with only a message, stdin is the message alone", async () => {
  const r = codexRig("key");
  await runPass(codexReq(r, { prompt: "MSG" }), r.deps);
  assert.deepEqual(r.fake.stdins(), ["MSG"]);
});

test("claude: --append-system-prompt, --effort, the skill mounted read-only under .claude/skills with --add-dir, and the prompt starts /<name>", async () => {
  const r = claudeRig();
  const dir = skillDir();
  await runPass(claudeReq(r, { system: "SYS", skill: { name: "fix", dir }, effort: "xhigh", prompt: "MSG" }), r.deps);
  const argv = r.fake.callsOf("run")[0]!;
  assert.deepEqual(flagValues(argv, "--append-system-prompt"), ["SYS"]);
  assert.deepEqual(flagValues(argv, "--effort"), ["xhigh"]);
  assert.deepEqual(flagValues(argv, "--add-dir"), ["/squad/skills"]);
  assert.deepEqual(roMount(argv, "/squad/skills/.claude/skills/fix"), { source: dir, ro: true });
  assert.deepEqual(r.fake.stdins(), ["/fix MSG"]);
});

test("a bad skill name, a dir without SKILL.md and a bad effort are refused before any account or container", async () => {
  const rigs: [PassRequest["runner"], string, () => Rig][] = [["pi", "opencode-go/hy4-preview", () => rig()], ["codex", "gpt-6.1-sol", () => codexRig("key")], ["claude", "claude-opus-5-5", () => claudeRig()]];
  for (const [runner, model, make] of rigs) {
    const r = make();
    const base: PassRequest = { runner, model, prompt: "x", pool: "all", cwd: r.cwd, caller: { flow: "f", action: "a" } };
    await assert.rejects(runPass({ ...base, skill: { name: "../x", dir: skillDir() } }, r.deps), /skill name/);
    const empty = mkdtempSync(join(tmpdir(), "noskill-"));
    await assert.rejects(runPass({ ...base, skill: { name: "fix", dir: empty } }, r.deps), /SKILL\.md/);
    for (const bad of ["off", "ultra", ""]) await assert.rejects(runPass({ ...base, effort: bad as "low" }, r.deps), /effort/);
    noContainer(r);
  }
});

test("a mount into the home, over a reserved path or a relative path is refused before any container", async () => {
  const r = rig();
  const outside = mkdtempSync(join(tmpdir(), "m-"));
  await assert.rejects(runPass(req(r, { mounts: [{ host: join(r.home.root, "accounts"), container: "/data", ro: true }] }), r.deps), /home/);
  await assert.rejects(runPass(req(r, { mounts: [{ host: r.home.root, container: "/data", ro: true }] }), r.deps), /home/);
  for (const container of ["/pi", "/pi/auth.json", "/squad/lock", "/squad/out", "/squad/skills/x", "/gh", "/codex", "/claude/x", "/skills/fix", "/squad/../pi", "rel"]) {
    await assert.rejects(runPass(req(r, { mounts: [{ host: outside, container, ro: true }] }), r.deps), /reserved|absolute/, container);
  }
  await assert.rejects(runPass(req(r, { mounts: [{ host: "rel/dir", container: "/data", ro: true }] }), r.deps), /absolute/);
  noContainer(r);
});

test("caller mounts are --mount, read-only when asked, and PATH from the caller reaches -e", async () => {
  const r = rig();
  const a = mkdtempSync(join(tmpdir(), "m-"));
  const b = mkdtempSync(join(tmpdir(), "m-"));
  await runPass(req(r, { mounts: [{ host: a, container: "/opt/tools", ro: true }, { host: b, container: "/node_modules", ro: false }], env: { PATH: "/opt/tools/bin:/usr/bin" } }), r.deps);
  const argv = r.fake.callsOf("run")[0]!;
  assert.deepEqual(roMount(argv, "/opt/tools"), { source: a, ro: true });
  assert.deepEqual(roMount(argv, "/node_modules"), { source: b, ro: false });
  assert.ok(!argv.includes("-v"));
  assert.deepEqual(flagValues(argv, "-e").filter((e) => e.startsWith("PATH=")), ["PATH=/opt/tools/bin:/usr/bin"]);
});

test("labels are added as --label; a squad. key, a bad key and a squad- container name are refused", async () => {
  const r = rig();
  await runPass(req(r, { labels: { "doppel.job": "j1" } }), r.deps);
  assert.ok(flagValues(r.fake.callsOf("run")[0]!, "--label").includes("doppel.job=j1"));
  const before = r.fake.calls().length;
  await assert.rejects(runPass(req(r, { labels: { "squad.pass": "x" } }), r.deps), /squad\./);
  await assert.rejects(runPass(req(r, { labels: { "a b": "x" } }), r.deps), /label/);
  await assert.rejects(runPass(req(r, { container: "squad-123" }), r.deps), /container/);
  await assert.rejects(runPass(req(r, { container: "-x" }), r.deps), /container/);
  assert.equal(r.fake.calls().length, before);
});

test("a fixed container name: docker rm -f of that name comes first, then run with that --name", async () => {
  const r = rig();
  await runPass(req(r, { container: "doppel-job-1" }), r.deps);
  const calls = r.fake.calls();
  assert.deepEqual(calls[0], ["rm", "-f", "doppel-job-1"]);
  assert.equal(calls[1]![0], "run");
  assert.deepEqual(flagValues(calls[1]!, "--name"), ["doppel-job-1"]);
});

test("without a container name there is no rm", async () => {
  const r = rig();
  await runPass(req(r), r.deps);
  assert.equal(r.fake.callsOf("rm").length, 0);
});

test("onOutput gets every stdout chunk, in order, and parsing does not change", async () => {
  const r = rig();
  const chunks: string[] = [];
  const res = await runPass(req(r, { onOutput: (c) => chunks.push(c) }), r.deps);
  assert.equal(chunks.join(""), readFileSync(join(import.meta.dirname, "..", "test/fixtures/captures/pi/ok.jsonl"), "utf8"));
  assert.equal(res.text, "ok");
});

test("a throwing onOutput does not break the pass", async () => {
  const r = rig();
  const res = await runPass(req(r, { onOutput: () => { throw new Error("boom"); } }), r.deps);
  assert.equal(res.text, "ok");
});

const inspectOf = (labels: Record<string, string> | null, entrypoint: string[] | null) => () => ({ labels: labels ?? {}, entrypoint });

test("image: a caller image that keeps squad's label and entrypoint is used", async () => {
  const r = rig([], {});
  const r2 = rig(["k1"], { inspectImage: inspectOf({ "squad.entry": "1" }, ["squad-entry", "pi"]) });
  await runPass(req(r2, { image: "doppel-pi:1" }), r2.deps);
  assert.ok(r2.fake.callsOf("run")[0]!.includes("doppel-pi:1"));
  assert.ok(r);
});

test("image: no label, a foreign entrypoint, a missing image or another runner's entrypoint are refused before any container", async () => {
  const cases: [(image: string) => { labels: Record<string, string>; entrypoint: string[] | null } | null, RegExp][] = [
    [inspectOf({}, ["squad-entry", "pi"]), /squad\.entry/],
    [inspectOf({ "squad.entry": "1" }, ["/bin/sh"]), /entrypoint/],
    [inspectOf({ "squad.entry": "1" }, null), /entrypoint/],
    [inspectOf({ "squad.entry": "1" }, ["squad-entry", "codex"]), /entrypoint/],
    [() => null, /not found/],
  ];
  for (const [inspect, re] of cases) {
    const r = rig(["k1"], { inspectImage: inspect });
    await assert.rejects(runPass(req(r, { image: "x:1" }), r.deps), re);
    noContainer(r);
  }
  const r = rig(["k1"], { inspectImage: inspectOf({ "squad.entry": "1" }, ["squad-entry", "pi"]) });
  await assert.rejects(runPass(req(r, { image: "--privileged" }), r.deps), /image/);
});

test("codex: the config guard is a copy in the home, mode 0644, and is restored when changed", async () => {
  const r = codexRig("login");
  await runPass(codexReq(r), r.deps);
  const src = roMount(r.fake.callsOf("run")[0]!, "/codex/config.toml")!;
  const copy = join(r.home.state, "assets", "codex-config.toml");
  assert.equal(src.source, copy);
  assert.equal(src.ro, true);
  assert.equal(statSync(copy).mode & 0o777, 0o644);
  assert.equal(readFileSync(copy, "utf8"), readFileSync(bundledPath("assets/codex-config.toml"), "utf8"));
  writeFileSync(copy, 'model = "evil"\n');
  chmodSync(copy, 0o600);
  await runPass(codexReq(r), r.deps);
  assert.equal(readFileSync(copy, "utf8"), readFileSync(bundledPath("assets/codex-config.toml"), "utf8"));
  assert.equal(statSync(copy).mode & 0o777, 0o644);
});

// ---- the two costs ----

const saveCatalog = (r: Rig, catalog: unknown): void => writeFileSync(join(r.home.state, "prices.json"), JSON.stringify({ v: 2, fetchedAt: NOW.getTime(), catalog }));

test("a pi key pass has the CLI cost, the catalog cost, and cost_usd equal to the catalog cost", async () => {
  const r = rig();
  saveCatalog(r, CATALOG);
  await runPass(req(r), r.deps);
  const p = passes(r)[0]!;
  const want = (1493 * 0.15 + 71 * 0.5 + 64 * 0.03) / 1e6;
  assert.ok(Math.abs((p.cli_cost_usd as number) - 0.001425421) < 1e-12);
  assert.ok(Math.abs((p.catalog_cost_usd as number) - want) < 1e-12);
  assert.equal(p.cost_usd, p.catalog_cost_usd);
  assert.equal(p.price_src, "catalog");
});

test("the catalog cost uses the price in force when the pass started, not today's copy", async () => {
  const r = rig();
  saveCatalog(r, { "opencode-go": { models: { "hy4-preview": { cost: { input: 100, output: 100 } } } } });
  recordPriceHistory(r.store.db, new Map([["opencode-go/hy4-preview", { input: 0.15, output: 0.5, cacheRead: 0.03 }]]), new Date(NOW.getTime() - 1000));
  await runPass(req(r), r.deps);
  assert.ok(Math.abs((passes(r)[0]!.catalog_cost_usd as number) - (1493 * 0.15 + 71 * 0.5 + 64 * 0.03) / 1e6) < 1e-12);
});

test("a pi pass with no catalog price has a CLI cost and no catalog cost", async () => {
  const r = rig();
  await runPass(req(r), r.deps);
  const p = passes(r)[0]!;
  assert.deepEqual([p.catalog_cost_usd, p.cost_usd, p.price_src], [null, null, null]);
  assert.ok((p.cli_cost_usd as number) > 0);
});

test("a login pass has a catalog cost but no cost_usd", async () => {
  const r = rig([], { busy: () => false });
  saveCatalog(r, CATALOG);
  addAccount(r.store.db, { runner: "pi", name: "l1", kind: "login" }, NOW);
  mkdirSync(join(r.home.accounts, "pi", "l1"), { recursive: true });
  await runPass(req(r), r.deps);
  const p = passes(r)[0]!;
  assert.deepEqual([p.account, p.cost_usd, p.price_src], ["pi/l1", null, null]);
  assert.ok((p.catalog_cost_usd as number) > 0);
});

test("claude token pass: the CLI cost is total_cost_usd and the catalog cost is under anthropic/<model>", async () => {
  const r = claudeRig();
  saveCatalog(r, { anthropic: { models: { "claude-opus-5-5": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } } } });
  await runPass(claudeReq(r), r.deps);
  const p = passes(r)[0]!;
  assert.equal(p.cli_cost_usd, 0.0477306);
  assert.ok(Math.abs((p.catalog_cost_usd as number) - (2 * 5 + 4 * 25 + 11333 * 0.5 + 5672 * 6.25) / 1e6) < 1e-12);
  assert.equal(p.cost_usd, null, "a token account has no bill");
});

test("codex login pass: no CLI cost, catalog cost under openai/<model>", async () => {
  const r = codexRig("login");
  saveCatalog(r, { openai: { models: { "gpt-6.1-sol": { cost: { input: 2, output: 10 } } } } });
  await runPass(codexReq(r), r.deps);
  const p = passes(r)[0]!;
  assert.equal(p.cli_cost_usd, null);
  assert.ok(Math.abs((p.catalog_cost_usd as number) - (14081 * 2 + 5 * 10) / 1e6) < 1e-12);
  assert.equal(p.cost_usd, null);
});

// ---- account care ----

test("an account its owner does not share: a named pass, a pinned session and a conversation fail at once with no-consent; no container, no health change", async () => {
  const { setSharing } = await import("./accounts/store.ts");
  const r = rig(["k1", "k2"]);
  await runPass(req(r, { session: "s1", pool: undefined, account: "pi/k1" }), r.deps);
  setSharing(r.store.db, "pi/k1", null, NOW);
  const healthBefore = getHealth(r.store.db, "pi/k1");
  const runsBefore = r.fake.callsOf("run").length;
  for (const more of [{ pool: undefined, account: "pi/k1" }, { session: "s1" }, { session: "s1", conversation: true }] as Partial<PassRequest>[]) {
    const res = await runPass(req(r, more), r.deps);
    assert.equal(res.failure?.kind, "no-account", JSON.stringify(more));
    assert.equal(res.failure?.code, "no-consent", JSON.stringify(more));
    assert.equal(res.account, null);
  }
  assert.equal(r.fake.callsOf("run").length, runsBefore, "no container");
  assert.deepEqual(getHealth(r.store.db, "pi/k1"), healthBefore);
  // The pool takes the other account.
  const pooled = await runPass(req(r), r.deps);
  assert.equal(pooled.account, "pi/k2");
});

test("a named probe runs on a suspect or cooling account; a named pass that is not a probe, or a pool probe, does not", async () => {
  const r = rig(["k1", "k2"]);
  putHealth(r.store.db, { ...emptyHealth("pi/k1"), suspectSince: NOW.toISOString(), authFails: 1 });
  putHealth(r.store.db, { ...emptyHealth("pi/k2"), coolUntil: new Date(NOW.getTime() + 600_000).toISOString(), coolKind: "rate-limit" });
  for (const id of ["pi/k1", "pi/k2"]) {
    assert.equal((await runPass(req(r, { pool: undefined, account: id }), r.deps)).failure?.kind, "no-account", id);
    const probed = await runPass(req(r, { pool: undefined, account: id, probe: true }), r.deps);
    assert.deepEqual([probed.account, probed.failure], [id, undefined], id);
  }
  // A probe names its account; on a pool the flag changes nothing.
  r.store.db.prepare("UPDATE health SET suspect_since = ? WHERE account = 'pi/k1'").run(NOW.toISOString());
  putHealth(r.store.db, { ...emptyHealth("pi/k2"), coolUntil: new Date(NOW.getTime() + 600_000).toISOString() });
  assert.equal((await runPass(req(r, { probe: true }), r.deps)).failure?.kind, "no-account");
});

test("a removed account is unknown to a named pass and never picked by the pool", async () => {
  const { markRemoved } = await import("./accounts/store.ts");
  const r = rig(["k1", "k2"]);
  markRemoved(r.store.db, "pi/k1");
  await assert.rejects(runPass(req(r, { pool: undefined, account: "pi/k1" }), r.deps), /unknown pi account/);
  assert.equal((await runPass(req(r), r.deps)).account, "pi/k2");
});
