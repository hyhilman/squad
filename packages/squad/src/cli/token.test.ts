import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addAccount } from "../accounts/store.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { openStore } from "../store/db.ts";
import { authenticate } from "../serve/tokens.ts";
import { main, type Io } from "./squad.ts";

const NOW = new Date("2026-10-25T10:00:00.000Z");

function rig() {
  const root = mkdtempSync(join(tmpdir(), "cli-tok-"));
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { SQUAD_HOME: join(root, "home") }, cwd: root, now: () => NOW };
  const home = layoutOf(join(root, "home"), io.env);
  ensureHome(home);
  const s = openStore({ dbPath: home.db, spoolDir: home.spool });
  addAccount(s.db, { runner: "pi", name: "acct-one", kind: "key" }, NOW);
  s.close();
  const work = join(root, "work");
  mkdirSync(work);
  return { root, home, work, out, err, run: (...argv: string[]) => main(argv, io) };
}

test("token add prints only the token, one line, on stdout; notes go to stderr; the token works", async () => {
  const r = rig();
  assert.equal(await r.run("token", "add", "dg-test", "--accounts", "pi/acct-one", "--roots", r.work), 0);
  const out = r.out.join("");
  assert.match(out, /^sqd_[A-Za-z0-9_-]{43}\n$/);
  assert.match(r.err.join(""), /shown once/);
  const s = openStore({ dbPath: r.home.db, spoolDir: r.home.spool });
  assert.equal(authenticate(s.db, `Bearer ${out.trim()}`, NOW).project, "dg-test");
  s.close();
  assert.ok(!readFileSync(r.home.db).includes(out.trim()), "the database file never holds the token");
});

test("token list shows project, accounts, roots, images and times, never the token; revoke ends it", async () => {
  const r = rig();
  await r.run("token", "add", "dg-test", "--accounts", "pi/acct-one", "--roots", r.work, "--images", "my/pi:1,my/pi:2");
  const token = r.out.join("").trim();
  r.out.length = 0;
  assert.equal(await r.run("token", "list"), 0);
  const listed = r.out.join("");
  assert.match(listed, /PROJECT\s+ACCOUNTS\s+ROOTS\s+IMAGES\s+CREATED\s+LAST USED/);
  assert.match(listed, /dg-test\s+pi\/acct-one\s+\S+work\s+my\/pi:1,my\/pi:2\s+2026-10-25T10:00:00.000Z\s+-/);
  assert.ok(!listed.includes(token));
  r.out.length = 0;
  assert.equal(await r.run("token", "revoke", "dg-test"), 0);
  assert.equal(await r.run("token", "revoke", "dg-test"), 1);
  r.out.length = 0;
  await r.run("token", "list");
  assert.doesNotMatch(r.out.join(""), /dg-test/);
});

test("token add refuses a wrong use (exit 2) and a bad scope (exit 1), and prints no token", async () => {
  const r = rig();
  assert.equal(await r.run("token", "add", "dg-test", "--roots", r.work), 2);
  assert.equal(await r.run("token", "add", "dg-test", "--accounts", "pi/acct-one"), 2);
  assert.equal(await r.run("token", "frob"), 2);
  assert.equal(await r.run("token", "add", "dg-test", "--accounts", "pi/nobody", "--roots", r.work), 1);
  assert.equal(await r.run("token", "add", "dg-test", "--accounts", "pi/acct-one", "--roots", "relative"), 1);
  assert.equal(r.out.join(""), "");
});

test("serve: refuses both flags (exit 2) and SQUAD_NO_SERVE=1 (exit 1); runs on a socket until the signal, then exits 0", async () => {
  const r = rig();
  assert.equal(await r.run("serve", "--socket", join(r.root, "a.sock"), "--port", "0"), 2);
  assert.equal(await r.run("serve", "--port", "nope"), 2);
  const off = await main(["serve"], { stdout: () => {}, stderr: (s) => r.err.push(s), env: { SQUAD_HOME: join(r.root, "home"), SQUAD_NO_SERVE: "1" }, cwd: r.root });
  assert.equal(off, 1);
  assert.match(r.err.join(""), /SQUAD_NO_SERVE=1/);
  const ac = new AbortController();
  const out: string[] = [];
  const running = main(["serve"], { stdout: (s) => { out.push(s); ac.abort(); }, stderr: () => {}, env: { SQUAD_HOME: join(r.root, "home") }, cwd: r.root, signal: ac.signal });
  assert.equal(await running, 0);
  assert.deepEqual(out, [`squad serve: listening on unix:${join(r.root, "home", "serve.sock")}\n`]);
});
