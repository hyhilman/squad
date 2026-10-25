import assert from "node:assert/strict";
import { test } from "node:test";
import { capReachedText, capsBody, capsText, capTone, keyCell, parseCap, thirtyDayText, usdText } from "./keyUse.ts";

test("usdText: whole dollars drop the cents; small sums keep four places", () => {
  assert.equal(usdText(12), "$12");
  assert.equal(usdText(0.42), "$0.42");
  assert.equal(usdText(3.1), "$3.10");
  assert.equal(usdText(0), "$0.00");
  assert.equal(usdText(0.0014), "$0.0014");
});

test("capTone: red when reached, yellow above 80%, blue under", () => {
  assert.equal(capTone(12, 12), "red");
  assert.equal(capTone(13, 12), "red");
  assert.equal(capTone(9.7, 12), "yellow");
  assert.equal(capTone(9.6, 12), "blue");
  assert.equal(capTone(0, 12), "blue");
});

test("keyCell: no cap gives text only; a cap gives a bar part, its tone and the cap text", () => {
  assert.deepEqual(keyCell(0.42, undefined), { usedText: "$0.42 used" });
  assert.deepEqual(keyCell(undefined, undefined), { usedText: "$0.00 used" });
  assert.deepEqual(keyCell(3, 12), { usedText: "$3 used", capText: "Cap $12", pct: 25, tone: "blue" });
  assert.deepEqual(keyCell(20, 12), { usedText: "$20 used", capText: "Cap $12", pct: 100, tone: "red" });
});

test("thirtyDayText: the 30-day use, and its cap when set", () => {
  assert.equal(thirtyDayText({ used30d: 9.8 }), "$9.80 in 30 d");
  assert.equal(thirtyDayText({ used30d: 9.8, cap30d: 30 }), "$9.80 of $30 cap in 30 d");
  assert.equal(thirtyDayText({}), "$0.00 in 30 d");
});

test("capReachedText: the first reached cap, 5 hours first; none without a cap or under it", () => {
  assert.equal(capReachedText({ kind: "key", used5h: 2, cap5h: 2, usedWeek: 9, capWeek: 5 }), "5-hour cap reached");
  assert.equal(capReachedText({ kind: "key", used5h: 1, cap5h: 2, usedWeek: 9, capWeek: 5 }), "Week cap reached");
  assert.equal(capReachedText({ kind: "key", used30d: 30, cap30d: 30 }), "30-day cap reached");
  assert.equal(capReachedText({ kind: "key", used5h: 100 }), undefined);
  assert.equal(capReachedText({ kind: "key", used5h: 1, cap5h: 2 }), undefined);
  assert.equal(capReachedText({ kind: "login", used5h: 5, cap5h: 2 }), undefined);
});

test("parseCap: empty is no cap; dollars above 0 with at most two decimals", () => {
  assert.deepEqual(parseCap(""), { ok: true, value: null });
  assert.deepEqual(parseCap(" 12 "), { ok: true, value: 12 });
  assert.deepEqual(parseCap("0.5"), { ok: true, value: 0.5 });
  assert.deepEqual(parseCap("$12"), { ok: true, value: 12 });
  for (const bad of ["0", "-1", "abc", "1.234", "1e3", "1000001"]) assert.equal(parseCap(bad).ok, false, bad);
});

test("capsBody: all three, or every error named by its window", () => {
  assert.deepEqual(capsBody("12", "", "40"), { ok: true, body: { cap5h: 12, capWeek: null, cap30d: 40 } });
  const r = capsBody("x", "", "0");
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.split(":")[0]), ["5-hour cap", "30-day cap"]);
});

test("capsText: only the caps that are set, or None", () => {
  assert.equal(capsText({}), "None");
  assert.equal(capsText({ cap5h: 2, cap30d: 50 }), "5 h $2 · 30 d $50");
  assert.equal(capsText({ cap5h: 0.5, capWeek: 9, cap30d: 30 }), "5 h $0.50 · week $9 · 30 d $30");
});
