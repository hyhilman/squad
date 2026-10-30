import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountView } from "@squad/contract";
import { accountActions, confirmMatches, pickTestModel, rowActions, splitActions } from "./accountActions.ts";

const base: AccountView = {
  account: "codex/a", runner: "codex", name: "a", kind: "login", ownerEmail: "o@x.test", pools: [], health: "ok",
  floor5h: 10, floorWeek: 10, floorSource: "default", busy: false, sharing: true, canResetHealth: false,
};
const owner = { email: "O@x.test", admin: false };
const admin = { email: "boss@x.test", admin: true };
const other = { email: "eve@x.test", admin: false };
const keys = (a: Partial<AccountView>, me: { email: string; admin: boolean }) => accountActions({ ...base, ...a }, me);

test("the owner of a codex login: share, test, log in again, floors, disable, remove; reset only when it applies", () => {
  assert.deepEqual(keys({}, owner), ["login", "test", "floors", "unshare", "enable", "remove"]);
  assert.deepEqual(keys({ health: "cooling", canResetHealth: true }, owner), ["login", "test", "reset", "floors", "unshare", "enable", "remove"]);
  assert.deepEqual(keys({ sharing: false }, owner), ["share", "login", "test", "floors", "enable", "remove"]);
});

test("an admin who is not the owner: test, reset, floors, disable, remove; never consent, login, key or limit reset", () => {
  assert.deepEqual(keys({ health: "suspect", canResetHealth: true }, admin), ["test", "reset", "floors", "enable", "remove"]);
  assert.deepEqual(keys({ runner: "claude", kind: "token", account: "claude/a" }, admin), ["test", "floors", "enable", "remove"]);
});

test("claude: log in again and use limit reset for the owner; a claude login (config folder) has no web log in", () => {
  assert.deepEqual(keys({ runner: "claude", kind: "token" }, owner), ["login", "test", "limit", "floors", "unshare", "enable", "remove"]);
  assert.deepEqual(keys({ runner: "claude", kind: "login" }, owner), ["test", "limit", "floors", "unshare", "enable", "remove"]);
});

test("pi key: replace key in place of log in again", () => {
  assert.deepEqual(keys({ runner: "pi", kind: "key" }, owner), ["key", "test", "floors", "unshare", "enable", "remove"]);
});

test("a dead account cannot be enabled; a removed or moved one takes no act; a stranger sees none", () => {
  assert.deepEqual(keys({ health: "dead" }, owner), ["login", "test", "floors", "unshare", "remove"]);
  assert.deepEqual(keys({ health: "removed", sharing: false }, owner), []);
  assert.deepEqual(keys({ health: "moved" }, admin), []);
  assert.deepEqual(keys({}, other), []);
  assert.deepEqual(accountActions(base, undefined), []);
});

test("the header shows the urgent acts and Test; the rest go in the menu, Remove last", () => {
  assert.deepEqual(splitActions(["login", "test", "floors", "unshare", "enable", "remove"], { ...base }), { primary: ["test"], menu: ["login", "floors", "unshare", "enable", "remove"] });
  assert.deepEqual(splitActions(["share", "login", "test", "reset", "floors", "enable", "remove"], { ...base, health: "dead", sharing: false }), { primary: ["share", "login", "test", "reset"], menu: ["floors", "enable", "remove"] });
});

test("the typed confirm must equal the id exactly, after trimming", () => {
  assert.equal(confirmMatches(" codex/a ", "codex/a"), true);
  assert.equal(confirmMatches("codex/A", "codex/a"), false);
  assert.equal(confirmMatches("a", "codex/a"), false);
});

test("the test model: the server default if served or none is listed, else the first served", () => {
  assert.equal(pickTestModel({ models: ["m1", "m2"], defaultModel: "m2" }), "m2");
  assert.equal(pickTestModel({ models: ["m1", "m2"], defaultModel: "zz" }), "m1");
  assert.equal(pickTestModel({ models: [], defaultModel: "zz" }), "");
  assert.equal(pickTestModel({ models: ["m1"] }), "m1");
  assert.equal(pickTestModel({ models: [] }), "");
});

test("a table row: Test, floors and Disable inline, in that order; the rest in the menu", () => {
  assert.deepEqual(rowActions(["login", "test", "reset", "floors", "unshare", "enable", "remove"]), {
    inline: ["test", "floors", "enable"],
    menu: ["login", "reset", "unshare", "remove"],
  });
  assert.deepEqual(rowActions(["test", "floors", "remove"]), { inline: ["test", "floors"], menu: ["remove"] });
});
