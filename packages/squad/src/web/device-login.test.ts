import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeIdToken } from "../../test/fake-jwt.ts";
import { addAccount, getAccount, setState, type AccountRow } from "../accounts/store.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { makeLog } from "../log.ts";
import { openStore } from "../store/db.ts";
import { DeviceLogins, LoginRefused, parseDeviceOutput, type LoginProc } from "./device-login.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const CAPTURE = readFileSync(join(import.meta.dirname, "..", "..", "test", "fixtures", "captures", "codex", "login-device-auth.txt"), "utf8");
const URL_OK = "https://auth.openai.com/codex/device";

test("the real capture gives the exact URL and the code, with the colours stripped", () => {
  assert.deepEqual(parseDeviceOutput(CAPTURE), { kind: "ready", verifyUrl: URL_OK, userCode: "ABCD-EFGHJ" });
});

test("output that came in small pieces waits until the line is whole", () => {
  assert.deepEqual(parseDeviceOutput(CAPTURE.slice(0, CAPTURE.indexOf("openai.com") + 5)), { kind: "wait" });
  const upToCode = CAPTURE.slice(0, CAPTURE.indexOf("ABCD-EF") + 7);
  assert.deepEqual(parseDeviceOutput(upToCode), { kind: "wait" });
  assert.deepEqual(parseDeviceOutput(CAPTURE.slice(0, CAPTURE.indexOf("\n\n\u001b[90mContinue"))), { kind: "wait" });
});

test("any other URL is refused, even a near miss", () => {
  for (const bad of ["https://evil.example/codex/device", "http://auth.openai.com/codex/device", "https://auth.openai.com/codex/device/x", "https://auth.openai.com.evil.example/codex/device", "https://auth.openai.com/codex/device?x=1"]) {
    assert.deepEqual(parseDeviceOutput(CAPTURE.replace(URL_OK, bad)), { kind: "bad" }, bad);
  }
});

test("a code in the wrong shape is never taken", () => {
  for (const bad of ["abcd-efghj", "ABC-EFGHJ", "ABCD-EFG", "ABCD-EFGHJKL", "ABCD EFGHJ"]) {
    assert.deepEqual(parseDeviceOutput(CAPTURE.replace("ABCD-EFGHJ", bad)), { kind: "wait" }, bad);
  }
});

// ---- the manager, with a fake container ----

class FakeProc implements LoginProc {
  readonly name: string;
  readonly argv: string[];
  readonly staging: string;
  private cb: (s: string) => void = () => {};
  private finish: (c: number) => void = () => {};
  readonly exited = new Promise<number>((r) => { this.finish = r; });
  constructor(argv: string[], name: string) {
    this.argv = argv;
    this.name = name;
    this.staging = argv.find((a) => a.endsWith("target=/codex"))!.split(",")[1]!.replace("source=", "");
  }
  onStdout(cb: (s: string) => void): void { this.cb = cb; }
  say(s: string): void { this.cb(s); }
  exit(code: number): void { this.finish(code); }
}

function rig(env: Record<string, string> = {}, over: { stop?: (n: string) => Promise<void> } = {}) {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "devlogin-")), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const procs: FakeProc[] = [];
  const stops: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const logs: string[] = [];
  let clock = NOW.getTime();
  const logins = new DeviceLogins({
    env, home, store, log: makeLog((l) => logs.push(l)), now: () => new Date(clock), user: null, docker: "docker",
    start: (argv, name) => { const p = new FakeProc(argv, name); procs.push(p); return p; },
    stop: over.stop ?? (async (n) => { stops.push(n); procs.find((p) => p.name === n)?.exit(143); }),
    timers: { after: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
  });
  const acct = (name = "alice", owner = "alice@example.test"): AccountRow => {
    addAccount(store.db, { runner: "codex", name, kind: "login", ownerEmail: owner }, NOW);
    setState(store.db, `codex/${name}`, "dead", "refresh_token_reused", NOW);
    return getAccount(store.db, `codex/${name}`)!;
  };
  const fire = (ms: number): void => { const t = timers.find((x) => x.ms === ms && x.live); assert.ok(t, `a live ${ms} ms timer`); t.live = false; t.fn(); };
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  return { home, store, procs, stops, timers, logs, logins, acct, fire, tick, advance: (ms: number) => { clock += ms; } };
}
type Rig = ReturnType<typeof rig>;

/** Starts a login and feeds the capture, so start() answers. */
async function begin(r: Rig, email = "alice@example.test", a = r.acct()) {
  const started = r.logins.start(email, a);
  await r.tick();
  r.procs.at(-1)!.say(CAPTURE);
  return { a, ...(await started), proc: r.procs.at(-1)! };
}
const writeAuth = (dir: string, email: string): void => writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: fakeIdToken({ email }), access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH" } }));
const refused = async (p: Promise<unknown>, status: number, code: string): Promise<LoginRefused> => {
  try { await p; } catch (e) { assert.ok(e instanceof LoginRefused, String(e)); assert.equal(e.status, status); assert.equal(e.code, code); return e; }
  throw new assert.AssertionError({ message: "expected a refusal" });
};

test("start runs a non-interactive login container with the staging folder, then answers with the URL, code and expiry", async () => {
  const r = rig();
  const s = await begin(r);
  assert.equal(s.verifyUrl, URL_OK);
  assert.equal(s.userCode, "ABCD-EFGHJ");
  assert.equal(s.expiresAt, new Date(NOW.getTime() + 15 * 60_000).toISOString());
  assert.ok(s.loginId.length >= 16);
  const argv = s.proc.argv;
  assert.equal(argv[0], "run");
  assert.ok(argv.includes("-i") && !argv.includes("-it"), "no tty");
  assert.ok(argv.includes("squad.purpose=login"));
  assert.deepEqual(argv.slice(argv.indexOf("squad-codex:1") === -1 ? argv.length - 2 : argv.indexOf("squad-codex:1") + 1), ["login", "--device-auth"]);
  assert.ok(existsSync(s.proc.staging));
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "pending" });
  await r.logins.close();
  r.store.close();
});

test("a wrong URL fails the start with unexpected-output and stops the container", async () => {
  const r = rig();
  const started = r.logins.start("alice@example.test", r.acct());
  await r.tick();
  r.procs[0]!.say(CAPTURE.replace(URL_OK, "https://evil.example/codex/device"));
  const e = await refused(started, 502, "internal");
  assert.match(e.message, /unexpected-output/);
  assert.equal(r.stops.length, 1);
  assert.ok(!existsSync(r.procs[0]!.staging), "staging removed");
  assert.ok(!e.message.includes("evil"), "raw output is not echoed");
  r.store.close();
});

test("no URL and code within 20 s fails the start, stops the container and removes staging", async () => {
  const r = rig();
  const started = r.logins.start("alice@example.test", r.acct());
  await r.tick();
  r.procs[0]!.say("Welcome to Codex\n");
  r.fire(20_000);
  await refused(started, 502, "internal");
  assert.equal(r.stops.length, 1);
  assert.ok(!existsSync(r.procs[0]!.staging));
  await r.logins.close();
  r.store.close();
});

test("a container that exits before it shows a code fails the start", async () => {
  const r = rig();
  const started = r.logins.start("alice@example.test", r.acct());
  await r.tick();
  r.procs[0]!.exit(1);
  await refused(started, 502, "internal");
  assert.ok(!existsSync(r.procs[0]!.staging));
  r.store.close();
});

test("exit 0 with the right email moves the login into accounts and marks the account", async () => {
  const r = rig();
  const s = await begin(r);
  writeAuth(s.proc.staging, "Alice@Example.test");
  s.proc.exit(0);
  await r.tick(); await r.tick(); await r.tick();
  await waitFor(() => r.logins.status("alice@example.test", s.loginId).state !== "pending");
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "done" });
  assert.ok(existsSync(join(r.home.accounts, "codex", "alice", "auth.json")));
  assert.ok(!existsSync(s.proc.staging));
  assert.equal(getAccount(r.store.db, "codex/alice")!.state, "active");
  await r.logins.close();
  r.store.close();
});

test("a login for another email fails with owner-mismatch and moves nothing", async () => {
  const r = rig();
  const s = await begin(r);
  writeAuth(s.proc.staging, "mallory@example.test");
  s.proc.exit(0);
  await waitFor(() => r.logins.status("alice@example.test", s.loginId).state !== "pending");
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "failed", reason: "owner-mismatch" });
  assert.ok(!existsSync(join(r.home.accounts, "codex", "alice")));
  assert.ok(!existsSync(s.proc.staging));
  const all = r.logs.join("\n") + JSON.stringify(r.logins.status("alice@example.test", s.loginId));
  assert.ok(!all.includes("mallory") && !all.includes("SECRET"), "no email of the other person, no token");
  await r.logins.close();
  r.store.close();
});

test("exit 0 with no files fails with login-failed; another non-zero exit fails with login-failed", async () => {
  const r = rig();
  const s = await begin(r);
  s.proc.exit(0);
  await waitFor(() => r.logins.status("alice@example.test", s.loginId).state !== "pending");
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "failed", reason: "login-failed" });
  const b = await begin(r, "bob@example.test", r.acct("bob", "bob@example.test"));
  writeAuth(b.proc.staging, "bob@example.test");
  b.proc.exit(2);
  await waitFor(() => r.logins.status("bob@example.test", b.loginId).state !== "pending");
  assert.deepEqual(r.logins.status("bob@example.test", b.loginId), { loginId: b.loginId, state: "failed", reason: "login-failed" });
  assert.ok(!existsSync(join(r.home.accounts, "codex", "bob")));
  assert.ok(!existsSync(b.proc.staging));
  await r.logins.close();
  r.store.close();
});

test("exit 0 with only log/ and tmp/ (a stopped codex) fails with no-login and moves nothing", async () => {
  const r = rig();
  const s = await begin(r);
  mkdirSync(join(s.proc.staging, "log"));
  mkdirSync(join(s.proc.staging, "tmp"));
  s.proc.exit(0);
  await waitFor(() => r.logins.status("alice@example.test", s.loginId).state !== "pending");
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "failed", reason: "no-login" });
  assert.ok(!existsSync(join(r.home.accounts, "codex", "alice")));
  assert.ok(!existsSync(s.proc.staging));
  assert.equal(getAccount(r.store.db, "codex/alice")!.state, "dead");
  await r.logins.close();
  r.store.close();
});

test("a pass holding the account lock fails the login with busy and keeps the old folder", async () => {
  const r = rig();
  const s = await begin(r);
  const old = join(r.home.accounts, "codex", "alice");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "old.txt"), "old");
  writeAuth(s.proc.staging, "alice@example.test");
  const { spawn } = await import("node:child_process");
  const lock = join(r.home.locks, "codex", "alice.lock");
  mkdirSync(join(r.home.locks, "codex"), { recursive: true });
  writeFileSync(lock, "");
  const holder = spawn("flock", ["-n", lock, "sh", "-c", "echo held; read x"], { stdio: ["pipe", "pipe", "ignore"] });
  await new Promise<void>((res) => holder.stdout.once("data", () => res()));
  try {
    s.proc.exit(0);
    await waitFor(() => r.logins.status("alice@example.test", s.loginId).state !== "pending");
    assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "failed", reason: "busy" });
    assert.ok(existsSync(join(old, "old.txt")));
    assert.ok(!existsSync(s.proc.staging));
  } finally {
    holder.stdin.end();
  }
  await r.logins.close();
  r.store.close();
});

test("after 15 minutes the container is stopped, staging is removed and the state is expired", async () => {
  const r = rig();
  const s = await begin(r);
  r.fire(15 * 60_000);
  await waitFor(() => r.stops.length === 1);
  assert.equal(r.stops[0], s.proc.name);
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "expired" });
  await waitFor(() => !existsSync(s.proc.staging));
  // The exit that follows the stop must not turn expired into something else.
  await r.tick();
  assert.equal(r.logins.status("alice@example.test", s.loginId).state, "expired");
  assert.ok(!existsSync(join(r.home.accounts, "codex", "alice")));
  await r.logins.close();
  r.store.close();
});

test("a second login on the same account is a 409 while the first runs; it is free again after", async () => {
  const r = rig();
  const a = r.acct();
  const s = await begin(r, "alice@example.test", a);
  await refused(r.logins.start("alice@example.test", a), 409, "conflict");
  s.proc.exit(1);
  await waitFor(() => r.logins.status("alice@example.test", s.loginId).state === "failed");
  const again = await begin(r, "alice@example.test", a);
  assert.notEqual(again.loginId, s.loginId);
  await r.logins.close();
  r.store.close();
});

test("at most 4 logins run at once", async () => {
  const r = rig();
  for (let i = 0; i < 4; i++) await begin(r, `u${i}@example.test`, r.acct(`a${i}`, `u${i}@example.test`));
  await refused(r.logins.start("u9@example.test", r.acct("a9", "u9@example.test")), 409, "conflict");
  await r.logins.close();
  r.store.close();
});

test("only codex, only a login account: other runners get 400 and say to use the host", async () => {
  const r = rig();
  const pi = addAccount(r.store.db, { runner: "pi", name: "p", kind: "login", ownerEmail: "alice@example.test" }, NOW);
  const e = await refused(r.logins.start("alice@example.test", pi), 400, "bad-request");
  assert.match(e.message, /squad login/);
  const key = addAccount(r.store.db, { runner: "codex", name: "k", kind: "key", ownerEmail: "alice@example.test" }, NOW);
  await refused(r.logins.start("alice@example.test", key), 400, "bad-request");
  assert.equal(r.procs.length, 0);
  r.store.close();
});

test("a live account is a 409: a login is for a dead account, as with `squad login`", async () => {
  const r = rig();
  const live = addAccount(r.store.db, { runner: "codex", name: "live", kind: "login", ownerEmail: "alice@example.test" }, NOW);
  const e = await refused(r.logins.start("alice@example.test", live), 409, "conflict");
  assert.match(e.message, /dead/);
  assert.equal(r.procs.length, 0);
  r.store.close();
});

test("only the person who started a login can ask about it; others and unknown ids get 404", async () => {
  const r = rig();
  const s = await begin(r);
  for (const [email, id] of [["bob@example.test", s.loginId], ["alice@example.test", "nope"]] as const) {
    assert.throws(() => r.logins.status(email, id), (e: unknown) => e instanceof LoginRefused && e.status === 404 && e.code === "not-found");
  }
  assert.equal(r.logins.status("ALICE@example.test", s.loginId).state, "pending");
  await r.logins.close();
  r.store.close();
});

test("finished entries are dropped after 30 minutes", async () => {
  const r = rig();
  const s = await begin(r);
  s.proc.exit(1);
  await waitFor(() => r.logins.status("alice@example.test", s.loginId).state === "failed");
  r.advance(29 * 60_000);
  assert.equal(r.logins.status("alice@example.test", s.loginId).state, "failed");
  r.advance(2 * 60_000);
  assert.throws(() => r.logins.status("alice@example.test", s.loginId), LoginRefused);
  r.store.close();
});

test("close stops every running container, removes staging and clears the timers", async () => {
  const r = rig();
  const a = await begin(r, "alice@example.test", r.acct("a1"));
  const b = await begin(r, "alice@example.test", r.acct("a2"));
  await r.logins.close();
  assert.deepEqual([...r.stops].sort(), [a.proc.name, b.proc.name].sort());
  assert.ok(!existsSync(a.proc.staging) && !existsSync(b.proc.staging));
  assert.ok(r.timers.every((t) => !t.live), "no live timer");
  assert.deepEqual(readdirSync(r.home.staging), []);
  r.store.close();
});

test("SQUAD_NO_WEB_LOGIN=1 and SQUAD_DRY_RUN=1 start nothing", async () => {
  for (const [key, text] of [["SQUAD_NO_WEB_LOGIN", /SQUAD_NO_WEB_LOGIN/], ["SQUAD_DRY_RUN", /SQUAD_DRY_RUN/]] as const) {
    const r = rig({ [key]: "1" });
    const e = await refused(r.logins.start("alice@example.test", r.acct()), 501, "disabled");
    assert.match(e.message, text);
    assert.equal(r.procs.length, 0);
    assert.deepEqual(readdirSync(r.home.staging), []);
    r.store.close();
  }
});

test("logs hold fixed event names with the account and login id only", async () => {
  const r = rig();
  const s = await begin(r);
  s.proc.exit(1);
  await waitFor(() => r.logins.status("alice@example.test", s.loginId).state === "failed");
  const all = r.logs.join("\n");
  assert.match(all, /event=web_login_started/);
  assert.match(all, /event=web_login_failed/);
  assert.ok(!/ABCD|openai|alice@|auth\.json/.test(all), all);
  await r.logins.close();
  r.store.close();
});

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("timed out waiting");
}
