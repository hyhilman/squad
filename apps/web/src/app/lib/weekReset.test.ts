import assert from "node:assert/strict";
import { test } from "node:test";
import { weekResetBadge, weekSoon } from "./weekReset.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z"); // a Saturday
const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

test("red under 24 h, with whole hours", () => {
  const b = weekResetBadge(at(18), NOW, "UTC")!;
  assert.deepEqual([b.tone, b.text], ["red", "Week resets in 18 h"]);
  assert.equal(weekResetBadge(at(0.5), NOW, "UTC")!.text, "Week resets in 1 h", "under an hour still says 1 h");
  assert.equal(weekResetBadge(at(23.9), NOW, "UTC")!.tone, "red");
});

test("yellow from 24 h up to 3 days, in days and hours", () => {
  const b = weekResetBadge(at(52), NOW, "UTC")!;
  assert.deepEqual([b.tone, b.text], ["yellow", "Week resets in 2 d 4 h"]);
  assert.equal(weekResetBadge(at(24), NOW, "UTC")!.text, "Week resets in 1 d");
  assert.equal(weekResetBadge(at(71.9), NOW, "UTC")!.tone, "yellow");
});

test("grey from 3 days on: the weekday and time in the given zone", () => {
  const b = weekResetBadge("2026-10-27T14:00:00.000Z", NOW, "UTC")!;
  assert.deepEqual([b.tone, b.text], ["grey", "resets Tue 14:00"]);
  assert.equal(weekResetBadge("2026-10-27T14:00:00.000Z", NOW, "Asia/Jakarta")!.text, "resets Tue 21:00");
});

test("the hover text is the exact local time", () => {
  assert.equal(weekResetBadge(at(18), NOW, "UTC")!.title, "Resets Sun, Oct 25, 2026, 06:00 UTC");
});

test("no time, a bad time or one in the past gives no badge", () => {
  assert.equal(weekResetBadge(undefined, NOW, "UTC"), undefined);
  assert.equal(weekResetBadge("nope", NOW, "UTC"), undefined);
  assert.equal(weekResetBadge(at(-1), NOW, "UTC"), undefined);
});

test("weekSoon: red or yellow only", () => {
  assert.equal(weekSoon(at(18), NOW), true);
  assert.equal(weekSoon(at(52), NOW), true);
  assert.equal(weekSoon(at(100), NOW), false);
  assert.equal(weekSoon(undefined, NOW), false);
});
