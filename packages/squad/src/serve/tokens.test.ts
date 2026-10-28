import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addAccount, markRemoved } from "../accounts/store.ts";
import { openStore, type Store } from "../store/db.ts";
import { Refusal } from "./scope.ts";
import { addToken, authenticate, hashToken, listTokens, revokeToken, tokenAccounts } from "./tokens.ts";

const NOW = new Date("2026-10-25T10:00:00.000Z");
const mk = (): { s: Store; root: string } => {
  const d = mkdtempSync(join(tmpdir(), "tok-"));
  const s = openStore({ dbPath: join(d, "squad.db"), spoolDir: join(d, "spool") });
  addAccount(s.db, { runner: "pi", name: "one", kind: "key" }, NOW);
  addAccount(s.db, { runner: "pi", name: "two", kind: "key" }, NOW);
  const root = join(d, "work");
  mkdirSync(root);
  return { s, root };
};

test("a token is 256 random bits; only its hash is stored, and list never shows it", () => {
  const { s, root } = mk();
  const { token } = addToken(s.db, "dg-test", { accounts: ["pi/one"], roots: [root], images: [] }, NOW);
  assert.match(token, /^sqd_[A-Za-z0-9_-]{43}$/);
  const raw = JSON.stringify(s.db.prepare("SELECT * FROM serve_tokens").all());
  assert.ok(!raw.includes(token.slice(4)), "the token is not in the table");
  assert.ok(raw.includes(hashToken(token)), "its sha256 is");
  const [row] = listTokens(s.db);
  assert.deepEqual({ ...row, id: "" }, { id: "", project: "dg-test", accounts: ["pi/one"], roots: [root], images: [], createdAt: NOW.toISOString(), lastUsedAt: null });
  assert.ok(!JSON.stringify(listTokens(s.db)).includes(token));
});

test("add refuses: a bad project name, an unknown account, a relative or missing root, a bad image, a second live token", () => {
  const { s, root } = mk();
  const ok = { accounts: ["pi/one"], roots: [root], images: [] };
  assert.throws(() => addToken(s.db, "../x", ok, NOW), /project/);
  assert.throws(() => addToken(s.db, "p", { ...ok, accounts: ["pi/none"] }, NOW), /unknown account pi\/none/);
  assert.throws(() => addToken(s.db, "p", { ...ok, accounts: [] }, NOW), /at least one account/);
  assert.throws(() => addToken(s.db, "p", { ...ok, roots: ["rel/path"] }, NOW), /absolute/);
  assert.throws(() => addToken(s.db, "p", { ...ok, roots: [join(root, "missing")] }, NOW), /does not exist/);
  assert.throws(() => addToken(s.db, "p", { ...ok, images: ["bad image"] }, NOW), /image/);
  addToken(s.db, "p", ok, NOW);
  assert.throws(() => addToken(s.db, "p", ok, NOW), /already has a live token/);
});

test("authenticate: the right bearer token passes and stamps last use; anything else is a 401 with no detail", () => {
  const { s, root } = mk();
  const { token } = addToken(s.db, "p", { accounts: ["pi/one"], roots: [root], images: [] }, NOW);
  const later = new Date(NOW.getTime() + 60_000);
  assert.equal(authenticate(s.db, `Bearer ${token}`, later).project, "p");
  assert.equal(listTokens(s.db)[0]!.lastUsedAt, later.toISOString());
  for (const h of [undefined, "", token, `Basic ${token}`, `Bearer ${token}x`, "Bearer sqd_nope", `Bearer  ${token}`]) {
    assert.throws(() => authenticate(s.db, h, later), (e: unknown) => e instanceof Refusal && e.status === 401 && e.error === "unauthorized", String(h));
  }
});

test("a revoked token is a 401; a new token for the project is a different one", () => {
  const { s, root } = mk();
  const first = addToken(s.db, "p", { accounts: ["pi/one"], roots: [root], images: [] }, NOW);
  assert.equal(revokeToken(s.db, "p", NOW), true);
  assert.equal(revokeToken(s.db, "p", NOW), false);
  assert.throws(() => authenticate(s.db, `Bearer ${first.token}`, NOW), (e: unknown) => e instanceof Refusal && e.status === 401);
  assert.deepEqual(listTokens(s.db), []);
  const second = addToken(s.db, "p", { accounts: ["pi/one"], roots: [root], images: [] }, NOW);
  assert.notEqual(second.token, first.token);
  assert.notEqual(second.row.id, first.row.id);
});

test("a pattern needs no account to exist; list keeps it as given; a bad pattern is refused", () => {
  const { s, root } = mk();
  const ok = { roots: [root], images: [] };
  for (const bad of ["**", "codex/a*", "*/one", "nope/*", "pi/*/x", "pi*"]) {
    assert.throws(() => addToken(s.db, "p", { ...ok, accounts: [bad] }, NOW), /must be \* or <runner>\/\*/, bad);
  }
  // No codex or claude account exists yet: a pattern is not checked against the accounts.
  addToken(s.db, "p", { ...ok, accounts: ["codex/*", "claude/*", "pi/one"] }, NOW);
  addToken(s.db, "q", { ...ok, accounts: ["*"] }, NOW);
  assert.deepEqual(Object.fromEntries(listTokens(s.db).map((t) => [t.project, t.accounts])), { p: ["codex/*", "claude/*", "pi/one"], q: ["*"] });
  // A plain id still must exist, also next to a pattern.
  assert.throws(() => addToken(s.db, "r", { ...ok, accounts: ["*", "pi/none"] }, NOW), /unknown account pi\/none/);
});

test("tokenAccounts: named ids as stored, then the live accounts each pattern matches, now and later, never a removed one", () => {
  const { s, root } = mk();
  const all = addToken(s.db, "all", { accounts: ["*"], roots: [root], images: [] }, NOW).row;
  const codex = addToken(s.db, "codex", { accounts: ["pi/two", "codex/*"], roots: [root], images: [] }, NOW).row;
  const named = addToken(s.db, "named", { accounts: ["pi/two", "pi/one"], roots: [root], images: [] }, NOW).row;
  assert.deepEqual(tokenAccounts(s.db, all), ["pi/one", "pi/two"]);
  assert.deepEqual(tokenAccounts(s.db, codex), ["pi/two"]);
  addAccount(s.db, { runner: "codex", name: "later", kind: "login" }, NOW);
  addAccount(s.db, { runner: "claude", name: "seat", kind: "token" }, NOW);
  assert.deepEqual(tokenAccounts(s.db, all), ["claude/seat", "codex/later", "pi/one", "pi/two"]);
  assert.deepEqual(tokenAccounts(s.db, codex), ["pi/two", "codex/later"]);
  markRemoved(s.db, "codex/later");
  markRemoved(s.db, "pi/one");
  assert.deepEqual(tokenAccounts(s.db, all), ["claude/seat", "pi/two"]);
  assert.deepEqual(tokenAccounts(s.db, codex), ["pi/two"]);
  // A token with no pattern reads exactly as stored, as before: order kept, nothing dropped.
  assert.deepEqual(tokenAccounts(s.db, named), ["pi/two", "pi/one"]);
});
