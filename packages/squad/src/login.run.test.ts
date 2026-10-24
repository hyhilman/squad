// `squad login` end to end with a fake terminal: what it moves, what it refuses, what it prints.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeIdToken } from "../test/fake-jwt.ts";
import { addAccount, getAccount, setState } from "./accounts/store.ts";
import { ensureHome, layoutOf } from "./home.ts";
import { runLogin } from "./login.ts";
import { openStore } from "./store/db.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");

function rig(write: (staging: string) => void, code = 0) {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "login-run-")), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const out: string[] = [];
  const err: string[] = [];
  const params = (name: string, owner?: string) => ({
    store, home, runner: "codex" as const, name, ...(owner === undefined ? {} : { owner }), docker: "docker", dryRun: false, project: "p", user: null, now: NOW,
    interactive: async (_d: string, argv: readonly string[]) => {
      const src = argv.find((a) => a.endsWith("target=/codex"))!.split(",")[1]!.replace("source=", "");
      write(src);
      return code;
    },
    out: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
  });
  return { home, store, out, err, params };
}
const auth = (email: string) => (d: string): void => writeFileSync(join(d, "auth.json"), JSON.stringify({ tokens: { id_token: fakeIdToken({ email }) } }));

test("a good login moves staging into accounts, registers the account and writes a login event", async () => {
  const r = rig(auth("alice@example.test"));
  assert.equal(await runLogin(r.params("alice")), 0);
  assert.ok(existsSync(join(r.home.accounts, "codex", "alice", "auth.json")));
  assert.equal(readdirSync(r.home.staging).length, 0);
  const a = getAccount(r.store.db, "codex/alice")!;
  assert.equal(a.kind, "login");
  assert.equal(a.ownerEmail, "alice@example.test");
  assert.match(r.out.join(""), /logged in codex\/alice \(alice@example.test\)/);
  r.store.close();
});

test("a login for another email than --owner moves nothing and drops staging", async () => {
  const r = rig(auth("mallory@example.test"));
  assert.equal(await runLogin(r.params("alice", "alice@example.test")), 1);
  assert.ok(!existsSync(join(r.home.accounts, "codex", "alice")));
  assert.equal(readdirSync(r.home.staging).length, 0);
  assert.equal(getAccount(r.store.db, "codex/alice"), undefined);
  assert.match(r.err.join(""), /is for mallory@example.test, not alice@example.test; nothing was moved/);
  r.store.close();
});

test("an empty staging folder and a non-zero exit change nothing", async () => {
  const empty = rig(() => {});
  assert.equal(await runLogin(empty.params("alice")), 1);
  assert.match(empty.err.join(""), /wrote no files/);
  const failed = rig(auth("alice@example.test"), 3);
  assert.equal(await runLogin(failed.params("alice")), 1);
  assert.match(failed.err.join(""), /did not finish \(exit 3\)/);
  assert.ok(!existsSync(join(failed.home.accounts, "codex", "alice")));
  empty.store.close();
  failed.store.close();
});

test("a dead login account is revived and its old folder is replaced", async () => {
  const r = rig(auth("alice@example.test"));
  addAccount(r.store.db, { runner: "codex", name: "alice", kind: "login", ownerEmail: "alice@example.test" }, NOW);
  setState(r.store.db, "codex/alice", "dead", "refresh_token_reused", NOW);
  const dest = join(r.home.accounts, "codex", "alice");
  await import("node:fs").then((fs) => { fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(join(dest, "old.txt"), "old"); });
  assert.equal(await runLogin(r.params("alice")), 0);
  assert.ok(!existsSync(join(dest, "old.txt")));
  assert.ok(readFileSync(join(dest, "auth.json"), "utf8").length > 0);
  assert.equal(getAccount(r.store.db, "codex/alice")!.state, "active");
  assert.deepEqual(readdirSync(join(r.home.accounts, "codex")), ["alice"]);
  r.store.close();
});
