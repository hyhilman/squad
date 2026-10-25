import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceFact, balanceLine, balanceRunway, balanceTone, perCycle, balanceUsedUp, capReachedText, capsBody, capsText, capTone, centsText, keyCell, parseBalance, parseCap, thirtyDayText, usdText } from "./keyUse.ts";

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

test("keyCell: no cap is the same bar, empty and blue, with Cap ∞; a cap gives its fill, tone and text", () => {
  assert.deepEqual(keyCell(0.42, undefined), { usedText: "$0.42 used", capText: "Cap ∞", pct: 0, tone: "blue" });
  assert.deepEqual(keyCell(undefined, undefined), { usedText: "$0.00 used", capText: "Cap ∞", pct: 0, tone: "blue" });
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
  assert.equal(capReachedText({ kind: "key", used5h: 1, cap5h: 2, usedWeek: 9, capWeek: 5 }), "7-day cap reached");
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
  assert.equal(capsText({ cap5h: 0.5, capWeek: 9, cap30d: 30 }), "5 h $0.50 · 7 d $9 · 30 d $30");
});

test("centsText: always two decimals, a minus sign before the dollar, no minus zero", () => {
  assert.equal(centsText(12.4), "$12.40");
  assert.equal(centsText(20), "$20.00");
  assert.equal(centsText(-0.4), "-$0.40");
  assert.equal(centsText(-0.001), "$0.00");
  assert.equal(centsText(1234.5), "$1,234.50");
});

test("perCycle: the higher of the last 5 hours and the 7-day average per 5 hours", () => {
  assert.equal(perCycle({ used5h: 0.53, usedWeek: 2.53 }), 0.53);
  assert.equal(perCycle({ used5h: 0, usedWeek: 33.6 }), 1);
  assert.equal(perCycle({}), 0);
});

test("balanceTone: red under 1 cycle, orange under 2, yellow up to the window's limit, grey after", () => {
  assert.equal(balanceTone(0, 1, 5), "red", "used up");
  assert.equal(balanceTone(-1, 0, 5), "red");
  assert.equal(balanceTone(0.9, 1, 5), "red", "will not last the next cycle");
  assert.equal(balanceTone(1, 1, 5), "orange", "lasts the next cycle only");
  assert.equal(balanceTone(1.9, 1, 5), "orange");
  assert.equal(balanceTone(2, 1, 5), "yellow");
  assert.equal(balanceTone(5, 1, 5), "yellow", "5 hours: gone within the next 5 cycles");
  assert.equal(balanceTone(5.1, 1, 5), "grey");
  assert.equal(balanceTone(4, 1, 4), "yellow", "7 days: gone within the next 4 weeks");
  assert.equal(balanceTone(4.1, 1, 4), "grey");
  assert.equal(balanceTone(3, 0, 5), "grey", "no use: it lasts");
});

const UTC = "UTC";
const AT = "2026-10-25T14:02:00.000Z";

test("balanceLine: the estimate, its tone and a hover that says what squad cannot see", () => {
  assert.deepEqual(balanceLine({ kind: "key", balanceUsd: 20, balanceAt: AT, balanceLeft: 12.4 }, UTC), {
    text: "≈ $12.40 balance",
    tone: "grey",
    hint: "Entered $20.00 on Oct 25, 14:02, minus $7.60 squad used since. squad used nothing in the last 7 days. squad cannot see use outside squad.",
  });
  assert.deepEqual(balanceLine({ kind: "key", balanceUsd: 5, balanceAt: AT, balanceLeft: -0.4 }, UTC)?.text, "≈ -$0.40 balance");
  assert.equal(balanceLine({ kind: "key", balanceUsd: 5, balanceAt: AT, balanceLeft: -0.4 }, UTC)?.tone, "red");
  // Rounded to cents first: a tiny minus reads $0.00 and is still red.
  assert.deepEqual(balanceLine({ kind: "key", balanceUsd: 5, balanceAt: AT, balanceLeft: -0.001 }, UTC), { text: "≈ $0.00 balance", tone: "red", hint: "Entered $5.00 on Oct 25, 14:02, minus $5.00 squad used since. squad used nothing in the last 7 days. squad cannot see use outside squad." });
  assert.equal(balanceLine({ kind: "key" }, UTC), undefined);
  assert.equal(balanceLine({ kind: "login", balanceUsd: 5, balanceAt: AT, balanceLeft: 5 }, UTC), undefined);
});

test("balanceLine: the pace picks the tone and the hover says how long it lasts", () => {
  const l = balanceLine({ kind: "key", balanceUsd: 20, balanceAt: AT, balanceLeft: 1.5, used5h: 1, usedWeek: 2 }, UTC)!;
  assert.equal(l.tone, "orange");
  assert.equal(l.hint, "Entered $20.00 on Oct 25, 14:02, minus $18.50 squad used since. At about $1.00 per 5 hours, it lasts about 1.5 more 5-hour cycles. squad cannot see use outside squad.");
  assert.equal(balanceLine({ kind: "key", balanceUsd: 20, balanceAt: AT, balanceLeft: 12, used5h: 1, usedWeek: 2 }, UTC)!.hint.includes("about 12 more 5-hour cycles"), true);
});

test("balanceRunway: one badge per window, in 5-hour cycles or in weeks", () => {
  const a = { kind: "key", balanceUsd: 20, balanceAt: AT, balanceLeft: 1.5, used5h: 0.5, usedWeek: 2.5 } as const;
  const h = balanceRunway(a, "5h", UTC)!;
  assert.deepEqual([h.text, h.tone], ["≈ $1.50 · 3 cycles", "yellow"]);
  assert.equal(h.title, "Entered $20.00 on Oct 25, 14:02, minus $18.50 squad used since. At about $0.50 per 5 hours, it lasts about 3 more 5-hour cycles. squad cannot see use outside squad.");
  const w = balanceRunway(a, "week", UTC)!;
  assert.deepEqual([w.text, w.tone], ["≈ $1.50 · 0.6 weeks", "red"]);
  assert.match(w.title, /At about \$2\.50 per 7 days, it lasts about 0\.6 more weeks\./);
  assert.equal(balanceRunway({ ...a, balanceLeft: 40 }, "week", UTC)!.text, "≈ $40.00 · 16 weeks");
  assert.equal(balanceRunway({ ...a, used5h: 0, usedWeek: 0 }, "5h", UTC)!.text, "≈ $1.50 · no use yet");
  assert.equal(balanceRunway({ ...a, balanceLeft: -0.4 }, "week", UTC)!.text, "≈ -$0.40 · used up");
  assert.equal(balanceRunway({ kind: "key" }, "5h", UTC), undefined);
});

test("balanceFact: the estimate and what was entered, or None", () => {
  assert.equal(balanceFact({ kind: "key", balanceUsd: 20, balanceAt: AT, balanceLeft: 12.4 }, UTC), "≈ $12.40 (entered $20.00 on Oct 25)");
  assert.equal(balanceFact({ kind: "key" }, UTC), "None");
});

test("balanceUsedUp: a key whose estimate is at or below $0", () => {
  assert.equal(balanceUsedUp({ kind: "key", balanceUsd: 5, balanceAt: AT, balanceLeft: 0 }), true);
  assert.equal(balanceUsedUp({ kind: "key", balanceUsd: 5, balanceAt: AT, balanceLeft: -2 }), true);
  assert.equal(balanceUsedUp({ kind: "key", balanceUsd: 5, balanceAt: AT, balanceLeft: 0.01 }), false);
  assert.equal(balanceUsedUp({ kind: "key" }), false);
});

test("parseBalance: empty is no balance; dollars from 0 with at most two decimals", () => {
  assert.deepEqual(parseBalance(""), { ok: true, value: null });
  assert.deepEqual(parseBalance("0"), { ok: true, value: 0 });
  assert.deepEqual(parseBalance(" $25.5 "), { ok: true, value: 25.5 });
  for (const bad of ["-1", "abc", "1.234", "1e3", "1000001"]) assert.equal(parseBalance(bad).ok, false, bad);
});
