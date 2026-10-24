import assert from "node:assert/strict";
import { test } from "node:test";
import { RANGES, sinceFor } from "./range.ts";

test("the ranges are 7d, 30d and 90d", () => {
  assert.deepEqual(RANGES, ["7d", "30d", "90d"]);
});

test("sinceFor: days pass through for day buckets", () => {
  for (const r of RANGES) assert.equal(sinceFor(r, "day"), r);
});

test("sinceFor: hour buckets are capped at 7 days", () => {
  assert.equal(sinceFor("7d", "hour"), "7d");
  assert.equal(sinceFor("30d", "hour"), "7d");
  assert.equal(sinceFor("90d", "hour"), "7d");
});
