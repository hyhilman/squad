import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionOf, countHealth, needsAttention } from "./attention.ts";

const acct = (over: Record<string, unknown>) => ({ account: "codex/a", health: "ok" as const, floor5h: 10, floorWeek: 10, ...over });

test("attentionOf: dead and cooling need attention", () => {
  assert.equal(attentionOf(acct({ health: "dead" })), "Login is dead");
  assert.equal(attentionOf(acct({ health: "cooling" })), "Cooling down");
});

test("attentionOf: room at or under the floor needs attention, the 5-hour window first", () => {
  assert.equal(attentionOf(acct({ left5h: 10 })), "5-hour room at the floor");
  assert.equal(attentionOf(acct({ left5h: 4, leftWeek: 3 })), "5-hour room at the floor");
  assert.equal(attentionOf(acct({ left5h: 50, leftWeek: 9 })), "Week room at the floor");
});

test("attentionOf: a healthy account, an unread one, a disabled or moved one need none", () => {
  assert.equal(attentionOf(acct({ left5h: 11, leftWeek: 90 })), undefined);
  assert.equal(attentionOf(acct({})), undefined);
  assert.equal(attentionOf(acct({ health: "disabled", left5h: 0 })), undefined);
  assert.equal(attentionOf(acct({ health: "moved" })), undefined);
});

test("needsAttention keeps the list order and adds the reason", () => {
  const list = [acct({ account: "codex/a" }), acct({ account: "codex/b", health: "dead" }), acct({ account: "claude/c", leftWeek: 0 })];
  assert.deepEqual(needsAttention(list).map((x) => [x.account.account, x.reason]), [["codex/b", "Login is dead"], ["claude/c", "Week room at the floor"]]);
});

test("countHealth: ok = health ok with no reason; attention = any reason", () => {
  const list = [acct({}), acct({ left5h: 5 }), acct({ health: "dead" }), acct({ health: "disabled" }), acct({ health: "suspect" })];
  assert.deepEqual(countHealth(list), { total: 5, ok: 1, attention: 2 });
});
