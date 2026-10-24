import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "../home.ts";
import { openStore } from "../store/db.ts";
import { AccountExists, createFileAccount, secretShapeError } from "./add.ts";
import { getAccount } from "./store.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");

function rig() {
  const home = layoutOf(join(mkdtempSync(join(tmpdir(), "add-")), "home"), {});
  ensureHome(home);
  return { home, store: openStore({ dbPath: home.db, spoolDir: home.spool }) };
}

test("the secret shape: non-empty, no space or line break, at most 4096 characters; the text never holds the value", () => {
  assert.equal(secretShapeError("FAKE-key_1.2"), undefined);
  for (const bad of ["", " ", "a b", "a\nb", "a\tb", "x".repeat(4097), 5, undefined, null]) assert.ok(secretShapeError(bad) !== undefined);
  assert.ok(!(secretShapeError("a b-SECRETPART") ?? "").includes("SECRETPART"));
  assert.equal(secretShapeError("x".repeat(4096)), undefined);
});

test("createFileAccount writes the row and the files (0600 in a 0700 folder), with no tmp file left", () => {
  const { home, store } = rig();
  const row = createFileAccount(store.db, home, { runner: "pi", name: "k1", kind: "key", ownerEmail: "a@b.co" }, [{ name: "auth.json", body: "{}" }, { name: "models.json", body: "{}" }], NOW);
  assert.deepEqual([row.id, row.kind, row.ownerEmail], ["pi/k1", "key", "a@b.co"]);
  const dir = join(home.accounts, "pi", "k1");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "auth.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ["auth.json", "models.json"]);
  store.close();
});

test("createFileAccount refuses an existing row or folder with AccountExists, and leaves the first one alone", () => {
  const { home, store } = rig();
  createFileAccount(store.db, home, { runner: "claude", name: "t1", kind: "token" }, [{ name: "token", body: "one" }], NOW);
  assert.throws(() => createFileAccount(store.db, home, { runner: "claude", name: "t1", kind: "token" }, [{ name: "token", body: "two" }], NOW), AccountExists);
  assert.equal(readFileSync(join(home.accounts, "claude", "t1", "token"), "utf8"), "one");
  mkdirSync(join(home.accounts, "pi", "orphan"), { recursive: true });
  assert.throws(() => createFileAccount(store.db, home, { runner: "pi", name: "orphan", kind: "key" }, [{ name: "auth.json", body: "{}" }], NOW), AccountExists);
  assert.equal(getAccount(store.db, "pi/orphan"), undefined, "no row is left behind");
  store.close();
});

test("createFileAccount undoes the row when the folder cannot be written; the error holds no secret", () => {
  const { home, store } = rig();
  writeFileSync(join(home.accounts, "pi"), "a file where the runner folder should be");
  assert.throws(() => createFileAccount(store.db, home, { runner: "pi", name: "k1", kind: "key" }, [{ name: "auth.json", body: "SECRETBODY" }], NOW), (e: Error) => !e.message.includes("SECRETBODY"));
  assert.equal(getAccount(store.db, "pi/k1"), undefined);
  assert.ok(existsSync(join(home.accounts, "pi")), "the stray file stays");
  store.close();
});

test("a bad name or kind is refused by the row check before any file is made", () => {
  const { home, store } = rig();
  assert.throws(() => createFileAccount(store.db, home, { runner: "pi", name: "../x", kind: "key" }, [], NOW), /not safe/);
  assert.throws(() => createFileAccount(store.db, home, { runner: "pi", name: "t", kind: "token" }, [], NOW), /claude only/);
  store.close();
});
