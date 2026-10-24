import { test } from "node:test";
import assert from "node:assert/strict";
import { agoText, costText, hasCost, pctText, roomByRunner, totalTokens } from "./format.ts";

test("pctText shows unknown when there is no read", () => {
  assert.equal(pctText(undefined), "unknown");
  assert.equal(pctText(42), "42%");
  assert.equal(pctText(0), "0%");
});

test("agoText reads a time in plain words", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  assert.equal(agoText(undefined, now), "never");
  assert.equal(agoText("2026-10-24T11:59:40Z", now), "just now");
  assert.equal(agoText("2026-10-24T11:30:00Z", now), "30 min ago");
  assert.equal(agoText("2026-10-24T09:00:00Z", now), "3 h ago");
  assert.equal(agoText("2026-10-20T12:00:00Z", now), "4 d ago");
  assert.equal(agoText("not a date", now), "unknown");
});

test("roomByRunner sums room per runner and skips accounts with no read", () => {
  const rows = roomByRunner([
    { runner: "codex", left5h: 80, leftWeek: 50 },
    { runner: "codex", left5h: 40, leftWeek: 10 },
    { runner: "codex" },
    { runner: "claude", left5h: 100, leftWeek: 100 },
  ]);
  assert.deepEqual(rows, [
    { runner: "claude", accounts: 1, read: 1, left5h: 100, leftWeek: 100 },
    { runner: "codex", accounts: 3, read: 2, left5h: 60, leftWeek: 30 },
  ]);
});

test("totalTokens adds every token kind", () => {
  assert.equal(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 }), 15);
});

test("hasCost is true only when some row has a cost", () => {
  assert.equal(hasCost([{}, {}]), false);
  assert.equal(hasCost([{}, { costUsd: 0 }]), true);
  assert.equal(costText(undefined), "");
  assert.equal(costText(1.5), "$1.50");
});
