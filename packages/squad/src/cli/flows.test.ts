// Tests for `squad login`, `import`, `shell` and `log`. Every home is a fresh temp folder and docker is the fake.
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { makeFakeDocker } from "../../test/fake-docker.ts";
import { fakeIdToken } from "../../test/fake-jwt.ts";
import { addAccount, candidates, getAccount, getHealth, putHealth, setState, type AccountRow } from "../accounts/store.ts";
import { emptyHealth } from "../accounts/health.ts";
import { ensureHome, layoutOf, type HomeLayout } from "../home.ts";
import { ulid } from "../ids.ts";
import { pick } from "../pool/pick.ts";
import { flockBusy } from "../run.ts";
import { openStore } from "../store/db.ts";
import { main, type Io } from "./squad.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const AUTH_NEW = JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: fakeIdToken(), access_token: "fake-a", refresh_token: "fake-r" } });

/** Runs the fake docker with stdin closed, as a stand-in for an interactive terminal. */
const quiet: Io["interactive"] = (docker, argv) => new Promise((resolve) => spawn(docker, [...argv], { stdio: "ignore" }).on("close", (c) => resolve(c ?? 1)));

function rig() {
  const root = mkdtempSync(join(tmpdir(), "flows-"));
  const fake = makeFakeDocker(join(root, "bin"));
  const out: string[] = [];
  const err: string[] = [];
  const env = { SQUAD_HOME: join(root, "home"), SQUAD_DOCKER: fake.path };
  const io: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env, cwd: root, now: () => NOW, interactive: quiet };
  const home = layoutOf(join(root, "home"), env);
  ensureHome(home);
  return { root, fake, io, home, out, err, text: () => out.join("") + err.join(""), run: (...argv: string[]) => main(argv, io) };
}
type Rig = ReturnType<typeof rig>;

function withStore<T>(home: HomeLayout, fn: (s: ReturnType<typeof openStore>) => T): T {
  const s = openStore({ dbPath: home.db, spoolDir: home.spool });
  try {
    return fn(s);
  } finally {
    s.close();
  }
}
const rowOf = (home: HomeLayout, id: string): AccountRow | undefined => withStore(home, (s) => getAccount(s.db, id));

/** A fixture account folder with a fake auth file. Made by hand, not copied from a login. */
function seedAccount(home: HomeLayout, runner: "codex" | "pi" | "claude", name: string, kind: "login" | "key" | "token", files: Record<string, string>, owner?: string): void {
  withStore(home, (s) => addAccount(s.db, { runner, name, kind, ...(owner === undefined ? {} : { ownerEmail: owner }) }, NOW));
  const dir = join(home.accounts, runner, name);
  mkdirSync(join(dir, "sub"), { recursive: true, mode: 0o700 });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
}

async function holdLock(lock: string): Promise<ChildProcess> {
  mkdirSync(dirname(lock), { recursive: true });
  closeSync(openSync(lock, "a"));
  const p = spawn("flock", [lock, "sleep", "5"], { stdio: "ignore" });
  for (let i = 0; i < 200 && !flockBusy(lock); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(flockBusy(lock), "the test holds the lock");
  return p;
}

// --- login ---

test("login: a live account is refused with exit 2 and docker never runs", async () => {
  const r = rig();
  seedAccount(r.home, "codex", "alice", "login", { "auth.json": "OLD" });
  assert.equal(await r.run("login", "codex/alice"), 2);
  assert.match(r.text(), /use a new name or wait until it is dead/);
  assert.deepEqual(r.fake.calls(), []);
  assert.equal(readFileSync(join(r.home.accounts, "codex", "alice", "auth.json"), "utf8"), "OLD");
});

test("login codex: runs the CLI in staging with -it and no lock, then moves the folder into place and registers it", async () => {
  const r = rig();
  r.fake.setModes("login-codex");
  r.fake.setLoginAuth(AUTH_NEW);
  assert.equal(await r.run("login", "codex/alice"), 0);
  const argv = r.fake.callsOf("run")[0]!;
  assert.equal(argv[2], "-it");
  assert.deepEqual(argv.slice(-2), ["login", "--device-auth"]);
  assert.ok(!argv.some((a) => a.includes("SQUAD_LOCK")));
  const dest = join(r.home.accounts, "codex", "alice");
  assert.equal(readFileSync(join(dest, "auth.json"), "utf8"), AUTH_NEW);
  const row = rowOf(r.home, "codex/alice")!;
  assert.equal(row.kind, "login");
  assert.equal(row.state, "active");
  assert.equal(row.ownerEmail, "alice@example.test");
  assert.deepEqual(readdirSync(r.home.staging), [], "staging is empty");
  const ev = withStore(r.home, (s) => s.db.prepare("SELECT kind, account FROM events").all());
  assert.deepEqual(ev.map((e) => ({ ...e })), [{ kind: "login", account: "codex/alice" }]);
  assert.ok(!r.text().includes("eyJ"), "no token printed");
});

test("login: the owner check fails on another email, removes staging and moves nothing", async () => {
  const r = rig();
  r.fake.setModes("login-codex");
  r.fake.setLoginAuth(AUTH_NEW);
  assert.equal(await r.run("login", "codex/alice", "--owner", "bob@example.test"), 1);
  assert.equal(existsSync(join(r.home.accounts, "codex", "alice")), false);
  assert.equal(rowOf(r.home, "codex/alice"), undefined);
  assert.deepEqual(readdirSync(r.home.staging), []);
  // A matching --owner is fine, with any letter case.
  assert.equal(await r.run("login", "codex/alice", "--owner", "ALICE@example.test"), 0);
});

test("login pi: no identity in the files, so --owner is kept as the owner", async () => {
  const r = rig();
  r.fake.setModes("login-pi");
  r.fake.setLoginAuth('{"fake":"pi login"}');
  assert.equal(await r.run("login", "pi/p1", "--owner", "carol@example.test"), 0);
  assert.equal(rowOf(r.home, "pi/p1")?.ownerEmail, "carol@example.test");
  assert.equal(r.fake.callsOf("run")[0]!.at(-1), "squad-pi:1.1.0");
});

test("login: a dead account is re-logged and revived; the old folder is gone", async () => {
  const r = rig();
  seedAccount(r.home, "codex", "alice", "login", { "auth.json": "OLD" });
  withStore(r.home, (s) => {
    setState(s.db, "codex/alice", "dead", "token_revoked", NOW);
    putHealth(s.db, { ...emptyHealth("codex/alice"), authFails: 2, suspectSince: NOW.toISOString() });
  });
  r.fake.setModes("login-codex");
  r.fake.setLoginAuth(AUTH_NEW);
  assert.equal(await r.run("login", "codex/alice"), 0);
  assert.equal(readFileSync(join(r.home.accounts, "codex", "alice", "auth.json"), "utf8"), AUTH_NEW);
  assert.deepEqual(readdirSync(join(r.home.accounts, "codex")), ["alice"], "no .old- folder left");
  const row = rowOf(r.home, "codex/alice")!;
  assert.equal(row.state, "active");
  assert.equal(row.deadCode, null);
  withStore(r.home, (s) => assert.equal(getHealth(s.db, "codex/alice").authFails, 0));
});

test("login: a held account lock is a refusal, exit 1; the old folder and the row stay, staging is cleared", async () => {
  const r = rig();
  seedAccount(r.home, "codex", "alice", "login", { "auth.json": "OLD" });
  withStore(r.home, (s) => setState(s.db, "codex/alice", "dead", "x", NOW));
  r.fake.setModes("login-codex");
  r.fake.setLoginAuth(AUTH_NEW);
  const holder = await holdLock(join(r.home.locks, "codex", "alice.lock"));
  try {
    assert.equal(await r.run("login", "codex/alice"), 1);
  } finally {
    holder.kill();
  }
  assert.match(r.text(), /account busy/);
  assert.equal(readFileSync(join(r.home.accounts, "codex", "alice", "auth.json"), "utf8"), "OLD");
  assert.equal(rowOf(r.home, "codex/alice")?.state, "dead");
  assert.deepEqual(readdirSync(r.home.staging), []);
});

test("login: a CLI that fails, or writes nothing, leaves nothing behind", async () => {
  const r = rig();
  r.fake.setModes("crash");
  assert.equal(await r.run("login", "codex/alice"), 1);
  r.fake.setModes("ok");
  assert.equal(await r.run("login", "codex/alice"), 1, "exit 0 but an empty folder is no login");
  assert.equal(rowOf(r.home, "codex/alice"), undefined);
  assert.equal(existsSync(join(r.home.accounts, "codex", "alice")), false);
  assert.deepEqual(readdirSync(r.home.staging), []);
});

test("login: claude is refused for now and points to add-token; a bad shape is a usage error", async () => {
  const r = rig();
  assert.equal(await r.run("login", "claude/c1"), 2);
  assert.match(r.text(), /add-token/);
  assert.equal(await r.run("login", "nope"), 2);
  assert.equal(await r.run("login", "dsh/x"), 2);
  assert.equal(await r.run("login", "codex/../x"), 2);
  assert.deepEqual(r.fake.calls(), []);
});

test("login: SQUAD_DRY_RUN=1 prints the argv and runs nothing", async () => {
  const r = rig();
  const io: Io = { ...r.io, env: { ...r.io.env, SQUAD_DRY_RUN: "1" } };
  assert.equal(await main(["login", "codex/alice"], io), 0);
  assert.match(r.out.join(""), /run --rm -it .*login --device-auth/);
  assert.deepEqual(r.fake.calls(), []);
  assert.deepEqual(readdirSync(r.home.staging), []);
  assert.equal(rowOf(r.home, "codex/alice"), undefined);
});

// --- import ---

/** A second home (the source) with its own folders and database. */
function otherHome(r: Rig): HomeLayout {
  const root = join(r.root, "other");
  const h = layoutOf(root, {});
  ensureHome(h);
  return h;
}
const LOGIN_FILES = { "auth.json": AUTH_NEW, "sub/deep.txt": "deep" };

test("import moves a login: the source holds only MOVED-TO, its row is moved, the target is login/active with equal files", async () => {
  const r = rig();
  const src = otherHome(r);
  seedAccount(src, "codex", "alice", "login", LOGIN_FILES, "alice@example.test");
  assert.equal(await r.run("import", src.root, "codex/alice"), 0);
  assert.deepEqual(readdirSync(join(src.accounts, "codex", "alice")), ["MOVED-TO"]);
  assert.equal(readFileSync(join(src.accounts, "codex", "alice", "MOVED-TO"), "utf8").trim(), r.home.root);
  assert.equal(rowOf(src, "codex/alice")?.state, "moved");
  const row = rowOf(r.home, "codex/alice")!;
  assert.deepEqual([row.kind, row.state, row.ownerEmail], ["login", "active", "alice@example.test"]);
  const dest = join(r.home.accounts, "codex", "alice");
  assert.equal(readFileSync(join(dest, "auth.json"), "utf8"), AUTH_NEW);
  assert.equal(readFileSync(join(dest, "sub", "deep.txt"), "utf8"), "deep");
  assert.deepEqual(readdirSync(r.home.staging), []);
  // The source's pool skips the moved account.
  const cands = withStore(src, (s) => candidates(s.db, "codex", NOW, () => false));
  assert.deepEqual(pick(cands, NOW.getTime()).skipped, { "codex/alice": "moved" });
  assert.equal(pick(cands, NOW.getTime()).order.length, 0);
});

test("import: a busy source lock refuses that login, the rest go on, exit 1", async () => {
  const r = rig();
  const src = otherHome(r);
  seedAccount(src, "codex", "alice", "login", LOGIN_FILES);
  seedAccount(src, "pi", "k1", "key", { "auth.json": '{"fake":"key"}' });
  const holder = await holdLock(join(src.locks, "codex", "alice.lock"));
  try {
    assert.equal(await r.run("import", src.root), 1);
  } finally {
    holder.kill();
  }
  assert.match(r.text(), /codex\/alice.*busy/);
  assert.equal(rowOf(r.home, "codex/alice"), undefined);
  assert.equal(existsSync(join(r.home.accounts, "codex", "alice")), false);
  assert.equal(readFileSync(join(src.accounts, "codex", "alice", "auth.json"), "utf8"), AUTH_NEW);
  assert.equal(rowOf(src, "codex/alice")?.state, "active");
  assert.equal(rowOf(r.home, "pi/k1")?.kind, "key");
});

test("import: a key account is copied hot, the source stays", async () => {
  const r = rig();
  const src = otherHome(r);
  seedAccount(src, "pi", "k1", "key", { "auth.json": '{"fake":"key"}' });
  seedAccount(src, "claude", "t1", "token", { token: "fake-token" });
  assert.equal(await r.run("import", src.root, "pi/k1", "claude/t1"), 0);
  assert.equal(readFileSync(join(r.home.accounts, "pi", "k1", "auth.json"), "utf8"), '{"fake":"key"}');
  assert.equal(readFileSync(join(r.home.accounts, "claude", "t1", "token"), "utf8"), "fake-token");
  assert.equal(rowOf(r.home, "claude/t1")?.kind, "token");
  assert.equal(readFileSync(join(src.accounts, "pi", "k1", "auth.json"), "utf8"), '{"fake":"key"}');
  assert.equal(rowOf(src, "pi/k1")?.state, "active");
  assert.ok(!r.text().includes("fake-token"));
});

test("import: a name that exists here, a dead account or an unknown name is refused for that account only", async () => {
  const r = rig();
  const src = otherHome(r);
  seedAccount(src, "codex", "alice", "login", LOGIN_FILES);
  seedAccount(src, "codex", "bob", "login", { "auth.json": "BOB" });
  seedAccount(src, "pi", "k1", "key", { "auth.json": "{}" });
  withStore(src, (s) => setState(s.db, "codex/bob", "dead", "x", NOW));
  seedAccount(r.home, "codex", "alice", "login", { "auth.json": "HERE" });
  assert.equal(await r.run("import", src.root, "codex/alice", "codex/bob", "codex/nope", "pi/k1"), 1);
  assert.equal(readFileSync(join(r.home.accounts, "codex", "alice", "auth.json"), "utf8"), "HERE");
  assert.equal(readFileSync(join(src.accounts, "codex", "alice", "auth.json"), "utf8"), AUTH_NEW, "source login untouched");
  assert.equal(rowOf(r.home, "codex/bob"), undefined);
  assert.equal(rowOf(r.home, "pi/k1")?.kind, "key");
});

test("import --back moves a login to the other home; a round trip works", async () => {
  const r = rig();
  const other = otherHome(r);
  seedAccount(r.home, "codex", "alice", "login", LOGIN_FILES, "alice@example.test");
  assert.equal(await r.run("import", "--back", "codex/alice", other.root), 0);
  assert.deepEqual(readdirSync(join(r.home.accounts, "codex", "alice")), ["MOVED-TO"]);
  assert.equal(readFileSync(join(r.home.accounts, "codex", "alice", "MOVED-TO"), "utf8").trim(), other.root);
  assert.equal(rowOf(r.home, "codex/alice")?.state, "moved");
  assert.deepEqual([rowOf(other, "codex/alice")?.kind, rowOf(other, "codex/alice")?.state], ["login", "active"]);
  assert.equal(readFileSync(join(other.accounts, "codex", "alice", "auth.json"), "utf8"), AUTH_NEW);
  // And it comes home again: the `moved` row here is replaced.
  assert.equal(await r.run("import", other.root, "codex/alice"), 0);
  assert.deepEqual(readdirSync(join(r.home.accounts, "codex", "alice")).sort(), ["auth.json", "sub"]);
  assert.equal(rowOf(r.home, "codex/alice")?.state, "active");
  assert.equal(rowOf(other, "codex/alice")?.state, "moved");
});

test("import: a usage mistake, this home as the source, or a missing home is refused", async () => {
  const r = rig();
  assert.equal(await r.run("import"), 2);
  assert.equal(await r.run("import", "--back", "codex/alice"), 2);
  assert.equal(await r.run("import", r.home.root), 1);
  assert.equal(await r.run("import", join(r.root, "nowhere")), 1);
});

test("import: SQUAD_DRY_RUN=1 says what it would do and changes nothing", async () => {
  const r = rig();
  const src = otherHome(r);
  seedAccount(src, "codex", "alice", "login", LOGIN_FILES);
  const io: Io = { ...r.io, env: { ...r.io.env, SQUAD_DRY_RUN: "1" } };
  assert.equal(await main(["import", src.root], io), 0);
  assert.match(r.out.join(""), /would move codex\/alice/);
  assert.equal(readFileSync(join(src.accounts, "codex", "alice", "auth.json"), "utf8"), AUTH_NEW);
  assert.equal(rowOf(r.home, "codex/alice"), undefined);
});

// --- shell ---

test("shell: a dry run prints the argv with -it, bash and the lock for a login, and no account path", async () => {
  const r = rig();
  seedAccount(r.home, "codex", "alice", "login", { "auth.json": "A" });
  const io: Io = { ...r.io, env: { ...r.io.env, SQUAD_DRY_RUN: "1" } };
  assert.equal(await main(["shell", "codex/alice"], io), 0);
  const text = r.out.join("");
  assert.match(text, / -it /);
  assert.match(text, /--entrypoint squad-entry \S+ bash\n$/);
  assert.match(text, /SQUAD_LOCK=1/);
  assert.match(text, /squad\.caller=[^ /]+\/cli/);
  assert.ok(!text.includes(join(r.home.accounts, "codex", "alice")), "no path inside an account folder");
  assert.deepEqual(r.fake.calls(), []);
  assert.deepEqual(readdirSync(r.home.staging), []);
});

test("shell on a key account: a dry run has no lock; a real run uses a key copy and removes it", async () => {
  const r = rig();
  seedAccount(r.home, "pi", "k1", "key", { "auth.json": "{}" });
  const dry: Io = { ...r.io, env: { ...r.io.env, SQUAD_DRY_RUN: "1" } };
  assert.equal(await main(["shell", "pi/k1"], dry), 0);
  assert.ok(!r.out.join("").includes("SQUAD_LOCK"));
  r.out.length = 0;
  assert.equal(await r.run("shell", "pi/k1"), 0);
  const argv = r.fake.callsOf("run")[0]!;
  assert.equal(argv[2], "-it");
  assert.equal(argv.at(-1), "bash");
  assert.ok(argv.some((a) => a.includes(`source=${r.home.staging}/`)), "the key copy is in staging");
  assert.deepEqual(readdirSync(r.home.staging), []);
});

test("shell: a busy login prints a busy line and exits 1; an unknown account is exit 2", async () => {
  const r = rig();
  seedAccount(r.home, "codex", "alice", "login", { "auth.json": "A" });
  r.fake.setModes("busy");
  assert.equal(await r.run("shell", "codex/alice"), 1);
  assert.match(r.text(), /busy/);
  assert.equal(await r.run("shell", "codex/nope"), 2);
  assert.equal(await r.run("shell"), 2);
});

// --- log ---

test("log: prints the path and the last 50 lines, minus any line findForbidden flags", async () => {
  const r = rig();
  const id = ulid(NOW.getTime());
  const dir = join(r.home.passLogs, "2026-10-24");
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 70 }, (_, i) => `line ${i + 1}`);
  lines[68] = `{"type":"x","access_token":"fake-not-real"}`;
  lines[67] = fakeIdToken();
  lines[66] = `value ${fakeIdToken()}`;
  writeFileSync(join(dir, `${id}.log`), `${lines.join("\n")}\n`);
  assert.equal(await r.run("log", id), 0);
  const out = r.out.join("").split("\n");
  assert.equal(out[0], join(dir, `${id}.log`));
  assert.ok(!r.out.join("").includes("access_token"));
  assert.ok(!r.out.join("").includes("eyJ"));
  const shown = out.slice(1).filter((l) => l !== "");
  assert.equal(shown[0], "line 21", "the last 50 lines are taken before the bad ones are dropped");
  assert.equal(shown.at(-1), "line 70");
  assert.equal(shown.length, 50 - 3);
});

test("log: an unknown or malformed id is exit 2", async () => {
  const r = rig();
  assert.equal(await r.run("log", ulid(NOW.getTime())), 2);
  assert.equal(await r.run("log", "../etc/passwd"), 2);
  assert.equal(await r.run("log"), 2);
});

