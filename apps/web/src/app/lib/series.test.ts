import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomPoint, UsageSeriesPoint } from "@squad/contract";
import { bucketLabel, pivotPasses, pivotTokens, roomRows } from "./series.ts";

const pt = (bucket: string, account: string, input: number, output: number, passes = 1): UsageSeriesPoint => ({
  bucket, account, passes, input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
});

test("pivotTokens: one row per bucket, one key per account, sorted by time", () => {
  const r = pivotTokens([pt("2026-10-24", "codex/a", 5, 5), pt("2026-10-23", "codex/b", 1, 2), pt("2026-10-23", "codex/a", 3, 0)]);
  assert.deepEqual(r.accounts, ["codex/a", "codex/b"]);
  assert.deepEqual(r.rows, [
    { bucket: "2026-10-23", "codex/a": 3, "codex/b": 3 },
    { bucket: "2026-10-24", "codex/a": 10, "codex/b": 0 },
  ]);
});

test("pivotTokens: empty in, empty out", () => {
  assert.deepEqual(pivotTokens([]), { accounts: [], rows: [] });
});

test("pivotPasses: passes summed per bucket over all accounts", () => {
  assert.deepEqual(pivotPasses([pt("2026-10-23", "a", 1, 1, 2), pt("2026-10-23", "b", 1, 1, 3), pt("2026-10-24", "a", 1, 1, 1)]), [
    { bucket: "2026-10-23", passes: 5 },
    { bucket: "2026-10-24", passes: 1 },
  ]);
});

test("bucketLabel: short day or hour, in UTC", () => {
  assert.equal(bucketLabel("2026-10-24"), "10-24");
  assert.equal(bucketLabel("2026-10-24T13:00:00Z"), "10-24 13:00");
  assert.equal(bucketLabel("odd"), "odd");
});

test("roomRows: oldest first, a time number, unread windows stay undefined", () => {
  const pts: RoomPoint[] = [
    { at: "2026-10-24T02:00:00Z", source: "pass", left5h: 40 },
    { at: "2026-10-24T01:00:00Z", source: "read", left5h: 50, leftWeek: 80 },
    { at: "bad", source: "read", left5h: 1 },
  ];
  const r = roomRows(pts);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.left5h), [50, 40]);
  assert.equal(r[0]!.t, Date.parse("2026-10-24T01:00:00Z"));
  assert.equal(r[1]!.leftWeek, undefined);
});
