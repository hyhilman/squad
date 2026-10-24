import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";
import { addAccount, getAccount } from "../accounts/store.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { makeLog } from "../log.ts";
import { openStore } from "../store/db.ts";
import { LoginRefused } from "./device-login.ts";
import { SetupTokenLogins, codeShapeError, findToken, parseSetupOutput, ptyCommand, type PtyProc } from "./setup-token.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const ESC = "\u001b";
// Fakes. The query has the shape of the real URL captured from squad-claude:2.1.310; the values are made up.
const AUTH_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE000&code_challenge_method=S256&state=FAKESTATEFAKESTATE000";
const TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE_-FAKE";

/**
 * Shaped like the real capture, which was taken under a pseudo-terminal: colours, an OSC title, cursor
 * moves in place of spaces (so the stripped prose loses its spaces), the URL on one line, the prompt.
 */
const BANNER =
  `${ESC}]0;Claude Code\u0007${ESC}[?25l${ESC}[1mWelcome${ESC}[1Cto${ESC}[1CClaude${ESC}[1CCode${ESC}[22m\r\n` +
  `${ESC}[90mBrowser${ESC}[1Cdidn't${ESC}[1Copen?${ESC}[1CUse${ESC}[1Cthe${ESC}[1Curl${ESC}[1Cbelow${ESC}[1Cto${ESC}[1Csign${ESC}[1Cin${ESC}[1C(c${ESC}[1Cto${ESC}[1Ccopy)${ESC}[39m\r\n`;
const URL_LINE = `${ESC}[2K${AUTH_URL}\r\n`;
const PROMPT = `${ESC}[1CPaste${ESC}[1Ccode${ESC}[1Chere${ESC}[1Cif${ESC}[1Cprompted${ESC}[1C>${ESC}[?25h`;
const SHOWN = BANNER + URL_LINE + PROMPT;
/** NOT a capture: the post-code output needs a real sign-in. This is the strictest guess: the token on a line of its own. */
const AFTER_CODE = `\r\n${ESC}[32m✓${ESC}[39m Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n${TOKEN}\r\n\r\nStore this token securely.\r\n`;

// ---- the parser ----

test("the URL is found in output with colours, an OSC title and cursor moves; the prose may have lost its spaces", () => {
  assert.deepEqual(parseSetupOutput(SHOWN), { kind: "ready", url: AUTH_URL });
});

test("output that is not a whole line yet waits; no URL waits", () => {
  assert.deepEqual(parseSetupOutput(BANNER), { kind: "wait" });
  assert.deepEqual(parseSetupOutput(BANNER + AUTH_URL.slice(0, 60)), { kind: "wait" });
  assert.deepEqual(parseSetupOutput(BANNER + AUTH_URL), { kind: "wait" }, "the line is not finished");
  assert.deepEqual(parseSetupOutput(""), { kind: "wait" });
});

test("a URL that is not exactly https://claude.com/cai/oauth/authorize is refused, also a near miss", () => {
  const q = AUTH_URL.slice(AUTH_URL.indexOf("?"));
  for (const bad of [
    "https://claude.com.evil.example/cai/oauth/authorize", "https://evilclaude.com/cai/oauth/authorize", "https://www.claude.com/cai/oauth/authorize",
    "http://claude.com/cai/oauth/authorize", "https://claude.com/cai/oauth/authorize/x", "https://claude.com/cai/oauth/authorizex", "https://claude.com/other",
    "https://claude.com@evil.example/cai/oauth/authorize", "https://user:pw@claude.com/cai/oauth/authorize", "https://claude.com:8443/cai/oauth/authorize",
    "https://claude.com/CAI/oauth/authorize", "https://claude.com/cai/oauth/../oauth/authorize/x", "javascript://claude.com/cai/oauth/authorize", "https://claude.com\\@evil.example/cai/oauth/authorize",
  ]) {
    assert.deepEqual(parseSetupOutput(`${BANNER}${bad}${q}\r\n${PROMPT}`), { kind: "bad" }, bad);
  }
  assert.deepEqual(parseSetupOutput(`${URL_LINE}https://evil.example/x\r\n`), { kind: "bad" }, "any other link in the output is refused");
  assert.deepEqual(parseSetupOutput(`${AUTH_URL}#frag\r\n`), { kind: "bad" }, "no fragment");
});

test("a token is found only by its exact shape, and only once it is whole", () => {
  assert.equal(findToken(AFTER_CODE, false), TOKEN);
  assert.equal(findToken(`${ESC}[1m${TOKEN}${ESC}[22m`, false), TOKEN);
  assert.equal(findToken(`token: ${TOKEN.slice(0, 40)}`, false), undefined, "not ended yet");
  assert.equal(findToken(TOKEN, false), undefined, "no terminator yet");
  assert.equal(findToken(TOKEN, true), TOKEN, "the program ended: the end is the end");
  for (const bad of ["sk-ant-oat01-short", "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE ", "sk-ant-oat02-FAKEFAKEFAKEFAKEFAKEFAKEFAKE ", "Authentication failed. Invalid code.\r\n", "SK-ANT-OAT01-FAKEFAKEFAKEFAKEFAKEFAKEFAKE "]) {
    assert.equal(findToken(bad, false), undefined, bad);
  }
});

test("a code is printable ASCII with no space, 1 to 512 characters", () => {
  for (const ok of ["abc", "AbC-123_x#state", "x".repeat(512)]) assert.equal(codeShapeError(ok), undefined, ok);
  for (const bad of ["", "a b", " a", "a\n", "a\rb", "a\u001b[2J", "a\u0000", "é", "x".repeat(513), undefined, 7]) assert.notEqual(codeShapeError(bad), undefined, String(bad));
});

test("the host command sets the terminal size before docker, and quotes every word", () => {
  assert.equal(ptyCommand("docker", ["run", "-it", "--name", "a b", "it's"]), `stty cols 400 rows 50; exec 'docker' 'run' '-it' '--name' 'a b' 'it'\\''s'`);
});

// ---- the manager, with a fake terminal ----

class FakePty implements PtyProc {
  readonly name: string;
  readonly argv: string[];
  readonly staging: string;
  readonly writes: string[] = [];
  private cb: (s: string) => void = () => {};
  private finish: (c: number) => void = () => {};
  readonly exited = new Promise<number>((r) => { this.finish = r; });
  constructor(argv: string[], name: string) {
    this.argv = argv;
    this.name = name;
    this.staging = argv.find((a) => a.endsWith("target=/claude"))!.split(",")[1]!.replace("source=", "");
  }
  onOutput(cb: (s: string) => void): void { this.cb = cb; }
  write(s: string): void { this.writes.push(s); }
  say(s: string): void { this.cb(s); }
  exit(code: number): void { this.finish(code); }
}

function rig(env: Record<string, string> = {}) {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "setuptok-")), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const procs: FakePty[] = [];
  const stops: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const logs: string[] = [];
  const logins = new SetupTokenLogins({
    env, home, store, log: makeLog((l) => logs.push(l)), now: () => NOW, user: null, docker: "docker",
    start: (argv, name) => { const p = new FakePty(argv, name); procs.push(p); return p; },
    stop: async (n) => { stops.push(n); procs.find((p) => p.name === n)?.exit(143); },
    timers: { after: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
  });
  const fire = (ms: number): void => { const t = timers.find((x) => x.ms === ms && x.live); assert.ok(t, `a live ${ms} ms timer`); t.live = false; t.fn(); };
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await tick(); };
  return { home, store, procs, stops, logs, logins, fire, tick, settle };
}
type Rig = ReturnType<typeof rig>;

async function begin(r: Rig, email = "alice@example.test", name = "claude1") {
  const started = r.logins.start(email, name);
  await r.tick();
  const proc = r.procs.at(-1)!;
  // The terminal gives the output in small pieces; the URL line is cut in the middle.
  const cut = SHOWN.indexOf("response_type");
  proc.say(SHOWN.slice(0, cut));
  proc.say(SHOWN.slice(cut));
  return { ...(await started), proc };
}
const refused = async (p: Promise<unknown> | (() => unknown), status: number, code: string): Promise<LoginRefused> => {
  try { await (typeof p === "function" ? p() : p); } catch (e) { assert.ok(e instanceof LoginRefused, String(e)); assert.equal(e.status, status); assert.equal(e.code, code); return e; }
  throw new assert.AssertionError({ message: "expected a refusal" });
};
/** Nothing that left the server may hold the token or the code. */
const clean = (r: Rig, ...answers: unknown[]): void => {
  const all = r.logs.join("\n") + JSON.stringify(answers);
  assert.ok(!all.includes("oat01") && !all.includes(TOKEN.slice(13)) && !all.includes("CODE-FROM-PAGE"), "a secret reached an answer or a log line");
  assert.equal(findForbidden(answers), undefined);
};

test("start runs claude setup-token under a terminal, mounts only a throwaway /claude, and answers with the link and needsCode", async () => {
  const r = rig();
  const s = await begin(r);
  assert.equal(s.verifyUrl, AUTH_URL);
  assert.equal(s.needsCode, true);
  assert.equal(s.userCode, undefined);
  assert.equal(s.expiresAt, new Date(NOW.getTime() + 15 * 60_000).toISOString());
  const argv = s.proc.argv;
  assert.ok(argv.includes("-it"), "a terminal");
  assert.ok(argv.includes("squad.purpose=login"));
  assert.ok(argv.includes("COLUMNS=400") && argv.includes("LINES=50"));
  assert.deepEqual(argv.slice(argv.indexOf("squad-claude:2.1.310") + 1), ["setup-token"]);
  const mounts = argv.filter((_, i) => argv[i - 1] === "--mount");
  assert.equal(mounts.length, 2, "the cwd and /claude, nothing else");
  assert.ok(!argv.join(" ").replaceAll(s.proc.staging, "").includes(r.home.root), "no path of the home except the staging folder");
  assert.ok(!argv.some((a) => a.includes("/squad/lock") || a.includes("/squad/token")));
  assert.ok(existsSync(s.proc.staging));
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "pending" });
  await r.logins.close();
  clean(r, { ...s, proc: undefined });
  r.store.close();
});

test("a link that is not the allowed one fails the start with unexpected-output, stops the container and removes the folder", async () => {
  const r = rig();
  const started = r.logins.start("alice@example.test", "c1");
  await r.tick();
  r.procs[0]!.say(SHOWN.replace("https://claude.com/", "https://claude.com.evil.example/"));
  const e = await refused(started, 502, "internal");
  assert.match(e.message, /unexpected-output/);
  assert.ok(!e.message.includes("evil"));
  assert.equal(r.stops.length, 1);
  assert.ok(!existsSync(r.procs[0]!.staging));
  r.store.close();
});

test("no link in 30 s, or an early exit, fails the start", async () => {
  const r = rig();
  const a = r.logins.start("alice@example.test", "c1");
  await r.tick();
  r.procs[0]!.say(BANNER);
  r.fire(30_000);
  await refused(a, 502, "internal");
  assert.equal(r.stops.length, 1);
  const b = r.logins.start("alice@example.test", "c2");
  await r.tick();
  r.procs[1]!.exit(1);
  await refused(b, 502, "internal");
  assert.ok(!existsSync(r.procs[1]!.staging));
  r.store.close();
});

test("start refuses a bad name, an existing account, a second login for a name, a dry run and the kill switch", async () => {
  const r = rig();
  await refused(r.logins.start("alice@example.test", "Bad Name"), 400, "bad-request");
  addAccount(r.store.db, { runner: "claude", name: "taken", kind: "token", ownerEmail: "x@example.test" }, NOW);
  await refused(r.logins.start("alice@example.test", "taken"), 409, "conflict");
  const s = await begin(r, "alice@example.test", "twice");
  await refused(r.logins.start("alice@example.test", "twice"), 409, "conflict");
  await r.logins.close();
  await refused(r.logins.start("alice@example.test", "late"), 501, "disabled");
  for (const env of [{ SQUAD_DRY_RUN: "1" }, { SQUAD_NO_WEB_LOGIN: "1" }] as Record<string, string>[]) {
    const q = rig(env);
    await refused(q.logins.start("alice@example.test", "c1"), 501, "disabled");
    assert.equal(q.procs.length, 0);
    q.store.close();
  }
  void s;
  r.store.close();
});

test("at most 4 logins run at once", async () => {
  const r = rig();
  for (let i = 0; i < 4; i++) await begin(r, "alice@example.test", `c${i}`);
  await refused(r.logins.start("alice@example.test", "c9"), 409, "conflict");
  await r.logins.close();
  r.store.close();
});

test("the code: only the owner (others get 404), a wrong shape is 400, a good one is written to the terminal with \\r, and only once", async () => {
  const r = rig();
  const s = await begin(r);
  await refused(() => r.logins.submitCode("bob@example.test", s.loginId, "CODE-FROM-PAGE"), 404, "not-found");
  await refused(() => r.logins.submitCode("alice@example.test", "nope", "CODE-FROM-PAGE"), 404, "not-found");
  for (const bad of ["", "a b", "x".repeat(513), "a\nb"]) await refused(() => r.logins.submitCode("alice@example.test", s.loginId, bad), 400, "bad-request");
  assert.deepEqual(s.proc.writes, [], "nothing reached the terminal yet");
  assert.deepEqual(r.logins.submitCode("ALICE@example.test", s.loginId, "CODE-FROM-PAGE"), { loginId: s.loginId, state: "pending" });
  assert.deepEqual(s.proc.writes, ["CODE-FROM-PAGE\r"]);
  await refused(() => r.logins.submitCode("alice@example.test", s.loginId, "CODE-FROM-PAGE"), 409, "conflict");
  assert.equal(s.proc.writes.length, 1);
  await r.logins.close();
  clean(r, { ...s, proc: undefined });
  r.store.close();
});

test("a code cannot be sent before the link is shown or after the login ended", async () => {
  const r = rig();
  const s = await begin(r);
  await r.logins.close();
  await refused(() => r.logins.submitCode("alice@example.test", s.loginId, "CODE-FROM-PAGE"), 409, "conflict");
  r.store.close();
});

test("the token after the code makes the account (token file 0600), stops the container, and shows nowhere", async () => {
  const r = rig();
  const s = await begin(r);
  const st = r.logins.submitCode("alice@example.test", s.loginId, "CODE-FROM-PAGE");
  // The token arrives in pieces; the first piece is not a token yet.
  s.proc.say(AFTER_CODE.slice(0, AFTER_CODE.indexOf(TOKEN) + 30));
  await r.settle();
  assert.equal(r.logins.status("alice@example.test", s.loginId).state, "pending");
  assert.equal(getAccount(r.store.db, "claude/claude1"), undefined, "a cut token makes no account");
  s.proc.say(AFTER_CODE.slice(AFTER_CODE.indexOf(TOKEN) + 30));
  await r.settle();
  const done = r.logins.status("alice@example.test", s.loginId);
  assert.deepEqual(done, { loginId: s.loginId, state: "done" });
  const dir = join(r.home.accounts, "claude", "claude1");
  assert.equal(readFileSync(join(dir, "token"), "utf8"), TOKEN);
  assert.equal(statSync(join(dir, "token")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const row = getAccount(r.store.db, "claude/claude1")!;
  assert.equal(row.kind, "token");
  assert.equal(row.ownerEmail, "alice@example.test");
  assert.deepEqual(r.stops, [s.proc.name]);
  assert.ok(!existsSync(s.proc.staging), "the throwaway folder is gone");
  await r.logins.close();
  clean(r, st, done, row, { ...s, proc: undefined });
  r.store.close();
});

test("a token-shaped text before any code is sent is ignored", async () => {
  const r = rig();
  const s = await begin(r);
  s.proc.say(`${TOKEN}\r\n`);
  await r.settle();
  assert.equal(getAccount(r.store.db, "claude/claude1"), undefined);
  assert.equal(r.logins.status("alice@example.test", s.loginId).state, "pending");
  await r.logins.close();
  r.store.close();
});

test("a token that ends the output at exit 0 is taken; at another exit code it is not", async () => {
  const r = rig();
  const a = await begin(r, "alice@example.test", "a1");
  r.logins.submitCode("alice@example.test", a.loginId, "CODE-FROM-PAGE");
  a.proc.say(TOKEN);
  await r.settle();
  assert.equal(r.logins.status("alice@example.test", a.loginId).state, "pending");
  a.proc.exit(0);
  await r.settle();
  assert.equal(r.logins.status("alice@example.test", a.loginId).state, "done");
  const b = await begin(r, "alice@example.test", "b1");
  r.logins.submitCode("alice@example.test", b.loginId, "CODE-FROM-PAGE");
  b.proc.say(TOKEN);
  b.proc.exit(1);
  await r.settle();
  assert.deepEqual(r.logins.status("alice@example.test", b.loginId), { loginId: b.loginId, state: "failed", reason: "login-failed" });
  assert.equal(getAccount(r.store.db, "claude/b1"), undefined);
  clean(r);
  await r.logins.close();
  r.store.close();
});

test("a wrong code (the CLI ends with no token) fails with login-failed and makes no account", async () => {
  const r = rig();
  const s = await begin(r);
  r.logins.submitCode("alice@example.test", s.loginId, "CODE-FROM-PAGE");
  s.proc.say("Authentication failed. Invalid code.\r\n");
  s.proc.exit(1);
  await r.settle();
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "failed", reason: "login-failed" });
  assert.equal(getAccount(r.store.db, "claude/claude1"), undefined);
  assert.ok(!existsSync(s.proc.staging));
  clean(r);
  r.store.close();
});

test("no token within 60 s of the code fails with login-failed and stops the container", async () => {
  const r = rig();
  const s = await begin(r);
  r.logins.submitCode("alice@example.test", s.loginId, "CODE-FROM-PAGE");
  r.fire(60_000);
  await r.settle();
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "failed", reason: "login-failed" });
  assert.deepEqual(r.stops, [s.proc.name]);
  assert.ok(!existsSync(s.proc.staging));
  await r.logins.close();
  r.store.close();
});

test("a login that is not finished in 15 minutes expires and its container is stopped", async () => {
  const r = rig();
  const s = await begin(r);
  r.fire(15 * 60_000);
  await r.settle();
  assert.equal(r.logins.status("alice@example.test", s.loginId).state, "expired");
  assert.deepEqual(r.stops, [s.proc.name]);
  assert.ok(!existsSync(s.proc.staging));
  r.store.close();
});

test("close stops every running login and removes its folders", async () => {
  const r = rig();
  const a = await begin(r, "alice@example.test", "a1");
  const b = await begin(r, "bob@example.test", "b1");
  await r.logins.close();
  assert.deepEqual(r.stops.sort(), [a.proc.name, b.proc.name].sort());
  assert.ok(!existsSync(a.proc.staging) && !existsSync(b.proc.staging));
  r.store.close();
});

test("an account made while the login ran makes the login fail, and the token is dropped", async () => {
  const r = rig();
  const s = await begin(r);
  r.logins.submitCode("alice@example.test", s.loginId, "CODE-FROM-PAGE");
  addAccount(r.store.db, { runner: "claude", name: "claude1", kind: "token", ownerEmail: "x@example.test" }, NOW);
  s.proc.say(AFTER_CODE);
  await r.settle();
  assert.deepEqual(r.logins.status("alice@example.test", s.loginId), { loginId: s.loginId, state: "failed", reason: "login-failed" });
  assert.ok(!existsSync(join(r.home.accounts, "claude", "claude1", "token")));
  clean(r);
  r.store.close();
});
