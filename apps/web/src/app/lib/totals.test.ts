import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSeriesPoint } from "@squad/contract";
import { seriesTotals, utcDay } from "./totals.ts";

const pt = (bucket: string, over: Partial<UsageSeriesPoint> = {}): UsageSeriesPoint => ({
  bucket, account: "codex/a", passes: 1, input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 2, ...over,
});

test("utcDay: the UTC date of a time", () => {
  assert.equal(utcDay(new Date("2026-10-24T23:30:00-02:00")), "2026-10-25");
  assert.equal(utcDay(new Date("2026-10-24T00:00:00Z")), "2026-10-24");
});

test("seriesTotals: sums passes, tokens and both costs", () => {
  const t = seriesTotals([pt("2026-10-23", { cliCostUsd: 1, catalogCostUsd: 2 }), pt("2026-10-24", { passes: 3, catalogCostUsd: 0.5 })]);
  assert.deepEqual(t, { passes: 4, tokens: 40, cliCostUsd: 1, catalogCostUsd: 2.5 });
});

test("seriesTotals: a cost stays unset when no point has it", () => {
  assert.deepEqual(seriesTotals([pt("2026-10-24")]), { passes: 1, tokens: 20 });
  assert.deepEqual(seriesTotals([]), { passes: 0, tokens: 0 });
});

test("seriesTotals: only the buckets of one day, for an hour series too", () => {
  const pts = [pt("2026-10-23"), pt("2026-10-24"), pt("2026-10-24T13:00:00Z", { passes: 2 })];
  assert.equal(seriesTotals(pts, "2026-10-24").passes, 3);
});
