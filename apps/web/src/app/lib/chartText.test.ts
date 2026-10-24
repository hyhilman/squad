import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketTick, bucketTitle, dayTicks, timeTick } from "./chartText.ts";

test("bucketTick: a day as `Oct 24`, an hour as `13:00` (UTC, the bucket's own zone)", () => {
  assert.equal(bucketTick("2026-10-24"), "Oct 24");
  assert.equal(bucketTick("2026-10-24T13:00:00Z"), "13:00");
  assert.equal(bucketTick("junk"), "junk");
});

test("bucketTitle: the full day, and the hour with its day", () => {
  assert.equal(bucketTitle("2026-10-24"), "Sat, Oct 24");
  assert.equal(bucketTitle("2026-10-24T13:00:00Z"), "Sat, Oct 24, 13:00 UTC");
});

test("timeTick: epoch ms as a short UTC day", () => {
  assert.equal(timeTick(Date.parse("2026-10-24T13:00:00Z")), "Oct 24");
});

test("dayTicks: one tick per UTC midnight inside the range, no repeats", () => {
  const a = Date.parse("2026-10-21T13:00:00Z");
  const b = Date.parse("2026-10-24T02:00:00Z");
  assert.deepEqual(dayTicks(a, b).map((t) => new Date(t).toISOString().slice(0, 10)), ["2026-10-22", "2026-10-23", "2026-10-24"]);
  assert.deepEqual(dayTicks(b, a), []);
});
