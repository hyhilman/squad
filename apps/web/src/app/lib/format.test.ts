import { diffText, diffTone, gapTone } from "./format.ts";
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

import { compactNumber, tokensText, durationText } from "./format.ts";

test("compactNumber: short numbers for chart axes", () => {
  assert.equal(compactNumber(0), "0");
  assert.equal(compactNumber(950), "950");
  assert.equal(compactNumber(1500), "1.5k");
  assert.equal(compactNumber(2_000_000), "2M");
  assert.equal(compactNumber(3_400_000_000), "3.4B");
});

test("tokensText: grouped digits", () => {
  assert.equal(tokensText(1234567), "1,234,567");
});

test("durationText: seconds, minutes, hours; unknown when unset", () => {
  assert.equal(durationText("2026-10-24T10:00:00Z", "2026-10-24T10:00:42Z"), "42 s");
  assert.equal(durationText("2026-10-24T10:00:00Z", "2026-10-24T10:05:30Z"), "5 min");
  assert.equal(durationText("2026-10-24T10:00:00Z", "2026-10-24T12:10:00Z"), "2 h 10 min");
  assert.equal(durationText("2026-10-24T10:00:00Z", undefined), "running");
});

test("moneyText: cents for a cent or more, four decimals below, nothing when unknown", async () => {
  const { moneyText } = await import("./format.ts");
  assert.equal(moneyText(undefined), "");
  assert.equal(moneyText(0), "$0.00");
  assert.equal(moneyText(1.5), "$1.50");
  assert.equal(moneyText(0.001425421), "$0.0014");
});

test("gapPercent and gapText need both costs and a CLI cost above zero", async () => {
  const { gapPercent, gapText } = await import("./format.ts");
  assert.equal(gapPercent(2, 3), 50);
  assert.equal(gapPercent(4, 3), -25);
  assert.equal(gapPercent(undefined, 3), undefined);
  assert.equal(gapPercent(2, undefined), undefined);
  assert.equal(gapPercent(0, 3), undefined);
  assert.equal(gapText(50), "+50.0%");
  assert.equal(gapText(-25), "-25.0%");
  assert.equal(gapText(undefined), "-");
});

test("costCompare keeps rows with either cost, adds the gap, biggest first", async () => {
  const { costCompare } = await import("./format.ts");
  const rows = costCompare([
    { key: "a", passes: 1 },
    { key: "p/x", passes: 2, cliCostUsd: 1, catalogCostUsd: 1.1 },
    { key: "p/y", passes: 1, catalogCostUsd: 5 },
    { key: "p/z", passes: 1, cliCostUsd: 0.5 },
  ]);
  assert.deepEqual(rows.map((r) => r.key), ["p/y", "p/x", "p/z"]);
  assert.ok(Math.abs(rows[1]!.gap! - 10) < 1e-9);
  assert.equal(rows[0]!.gap, undefined);
});

test("diffText is catalog minus CLI, in dollars and as a share of the CLI cost", () => {
  assert.equal(diffText(0.004071, 0), "-$0.0041 (-100.0%)");
  assert.equal(diffText(0.01, 0.012), "+$0.0020 (+20.0%)");
  assert.equal(diffText(0.01, 0.01), "$0.00 (0.0%)");
  assert.equal(diffText(undefined, 0.5), "");
  assert.equal(diffText(0.5, undefined), "");
  assert.equal(diffText(0, 0.5), "+$0.50", "no share of a zero CLI cost");
});

test("gapTone: green when the catalog is cheaper, red when pricier, grey when equal or unknown", () => {
  assert.equal(gapTone(-12.5), "green");
  assert.equal(gapTone(50.7), "red");
  assert.equal(gapTone(0), "grey");
  assert.equal(gapTone(undefined), "grey");
  assert.equal(diffTone(0.01, 0.012), "red");
  assert.equal(diffTone(0.004, 0), "green");
  assert.equal(diffTone(undefined, 0.5), "grey");
});
