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

test("needsAttention also lists an account whose week resets within 3 days, with that reason; countHealth does not change", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const soon = acct({ account: "codex/s", resetsWeek: "2026-10-25T06:00:00.000Z" });
  const later = acct({ account: "codex/l", resetsWeek: "2026-10-30T06:00:00.000Z" });
  assert.deepEqual(needsAttention([soon, later], now).map((x) => [x.account.account, x.reason]), [["codex/s", "Week resets soon"]]);
  assert.deepEqual(needsAttention([acct({ account: "codex/d", health: "dead", resetsWeek: "2026-10-25T06:00:00.000Z" })], now).map((x) => x.reason), ["Login is dead"]);
  assert.deepEqual(countHealth([soon, later]), { total: 2, ok: 2, attention: 0 });
});

test("an account its owner does not share needs attention: the pool refuses every pass on it", () => {
  assert.equal(attentionOf(acct({ sharing: false })), "Not shared");
  assert.equal(attentionOf(acct({ sharing: false, health: "dead" })), "Login is dead");
  assert.equal(attentionOf(acct({ sharing: true })), undefined);
});

test("attentionOf: a key whose own passes reached a cap needs attention; one with no cap does not", () => {
  assert.equal(attentionOf(acct({ account: "pi/dev", kind: "key", used5h: 3, cap5h: 2 })), "5-hour cap reached");
  assert.equal(attentionOf(acct({ account: "pi/dev", kind: "key", used5h: 3 })), undefined);
});

test("needsAttention: a key whose balance estimate is used up; the pool still uses it, so countHealth does not count it", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const up = acct({ account: "pi/dev", kind: "key", balanceUsd: 5, balanceAt: "2026-10-22T12:00:00.000Z", balanceLeft: -0.4 });
  const fine = acct({ account: "pi/spare", kind: "key", balanceUsd: 40, balanceAt: "2026-10-23T12:00:00.000Z", balanceLeft: 39 });
  assert.deepEqual(needsAttention([up, fine], now).map((x) => [x.account.account, x.reason]), [["pi/dev", "Balance used up"]]);
  assert.equal(attentionOf(up), undefined);
  assert.deepEqual(countHealth([up, fine]), { total: 2, ok: 2, attention: 0 });
});
