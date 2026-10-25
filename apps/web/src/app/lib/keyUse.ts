// A key account has no window from its provider. squad shows what its own passes used, in dollars,
// and the owner's caps. The pool stops picking a key whose used sum reached a cap
// (packages/squad/src/accounts/store.ts). squad cannot see use outside squad.
import { CAP_MAX_USD, type AccountView, type SetCapsBody } from "@squad/contract";
import { moneyText } from "./format.ts";

export type CapTone = "blue" | "yellow" | "red";

/** Whole dollars drop the cents ("$12"); everything else is moneyText. */
export const usdText = (v: number): string => (Number.isInteger(v) && v !== 0 ? `$${v}` : moneyText(v));

export function capTone(used: number, cap: number): CapTone {
  if (used >= cap) return "red";
  if (used > cap * 0.8) return "yellow";
  return "blue";
}

export interface KeyCell {
  readonly usedText: string;
  /** The bar's right legend, fill and colour. With no cap the bar stays empty and blue, and reads "Cap ∞". */
  readonly capText: string;
  readonly pct: number;
  readonly tone: CapTone;
}

export function keyCell(used: number | undefined, cap: number | undefined): KeyCell {
  const u = used ?? 0;
  const usedText = `${usdText(u)} used`;
  if (cap === undefined) return { usedText, capText: "Cap ∞", pct: 0, tone: "blue" };
  return { usedText, capText: `Cap ${usdText(cap)}`, pct: Math.min(100, Math.max(0, (u / cap) * 100)), tone: capTone(u, cap) };
}

export const thirtyDayText = (a: Pick<AccountView, "used30d" | "cap30d">): string =>
  a.cap30d === undefined ? `${usdText(a.used30d ?? 0)} in 30 d` : `${usdText(a.used30d ?? 0)} of ${usdText(a.cap30d)} cap in 30 d`;

export const CAP_HINT = "squad stops picking this key when its own passes reach the cap. squad cannot see use outside squad.";
export const NO_CAP_HINT = "No cap: squad picks this key whatever it used. The owner can set one with Caps & balance. squad cannot see use outside squad.";

type CapFacts = Partial<Pick<AccountView, "kind" | "used5h" | "usedWeek" | "used30d" | "cap5h" | "capWeek" | "cap30d">>;

/** The first cap a key's own passes reached, 5 hours first; undefined for none. */
export function capReachedText(a: CapFacts): string | undefined {
  if (a.kind !== "key") return undefined;
  const hit = (used: number | undefined, cap: number | undefined): boolean => cap !== undefined && (used ?? 0) >= cap;
  if (hit(a.used5h, a.cap5h)) return "5-hour cap reached";
  if (hit(a.usedWeek, a.capWeek)) return "7-day cap reached";
  if (hit(a.used30d, a.cap30d)) return "30-day cap reached";
  return undefined;
}

export type CapParse = { ok: true; value: number | null } | { ok: false; error: string };

const CAP_ERROR = `Use dollars above 0 (at most two decimals, up to ${CAP_MAX_USD}), or leave it empty for no cap.`;

/** Empty = no cap (null). A leading "$" is fine. */
export function parseCap(text: string): CapParse {
  const t = text.trim().replace(/^\$/, "");
  if (t === "") return { ok: true, value: null };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return { ok: false, error: CAP_ERROR };
  const n = Number(t);
  if (!(n > 0 && n <= CAP_MAX_USD)) return { ok: false, error: CAP_ERROR };
  return { ok: true, value: n };
}

export function capsBody(text5h: string, textWeek: string, text30d: string): { ok: true; body: SetCapsBody } | { ok: false; errors: string[] } {
  const a = parseCap(text5h);
  const b = parseCap(textWeek);
  const c = parseCap(text30d);
  if (a.ok && b.ok && c.ok) return { ok: true, body: { cap5h: a.value, capWeek: b.value, cap30d: c.value } };
  const errors: string[] = [];
  if (!a.ok) errors.push(`5-hour cap: ${a.error}`);
  if (!b.ok) errors.push(`7-day cap: ${b.error}`);
  if (!c.ok) errors.push(`30-day cap: ${c.error}`);
  return { ok: false, errors };
}

/** The text a caps box starts with: the cap, or empty for none. */
export const capInput = (cap: number | undefined): string => (cap === undefined ? "" : String(cap));

/** The caps that are set, for a fact list: "5 h $2 · 30 d $50", or "None". */
export function capsText(a: Partial<Pick<AccountView, "cap5h" | "capWeek" | "cap30d">>): string {
  const parts = [["5 h", a.cap5h], ["7 d", a.capWeek], ["30 d", a.cap30d]] as const;
  const set = parts.flatMap(([k, v]) => (v === undefined ? [] : [`${k} ${usdText(v)}`]));
  return set.length === 0 ? "None" : set.join(" · ");
}

// ---- the balance the owner typed, and squad's estimate (display only: the pool never reads it) ----

type BalanceFacts = Partial<Pick<AccountView, "kind" | "balanceUsd" | "balanceAt" | "balanceLeft" | "used5h" | "usedWeek">>;

const round = (v: number): number => Math.round(v * 100) / 100;

/** Always two decimals, with the minus before the dollar ("-$0.40"). A value that rounds to 0 reads "$0.00". */
export function centsText(v: number): string {
  const r = round(v);
  const t = `$${Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return r < 0 ? `-${t}` : t;
}

export type BalanceTone = "grey" | "yellow" | "orange" | "red";

/** 5-hour windows in 7 days. */
const CYCLES_PER_WEEK = (7 * 24) / 5;

/**
 * What a key uses per 5 hours: the higher of the last 5 hours and the 7-day average, so a busy hour
 * counts at once and a quiet hour does not hide a busy week.
 */
export const perCycle = (a: Partial<Pick<AccountView, "used5h" | "usedWeek">>): number => Math.max(a.used5h ?? 0, (a.usedWeek ?? 0) / CYCLES_PER_WEEK);

/**
 * By how many cycles the balance lasts at `pace` dollars per cycle: red when it will not last the next
 * one, orange when it lasts only the next one, yellow when it is gone within `yellowUpTo`, grey after.
 */
export function balanceTone(left: number, pace: number, yellowUpTo: number): BalanceTone {
  if (left <= 0) return "red";
  if (pace <= 0) return "grey";
  const cycles = left / pace;
  if (cycles < 1) return "red";
  if (cycles < 2) return "orange";
  if (cycles <= yellowUpTo) return "yellow";
  return "grey";
}

const countText = (n: number): string => (n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n)));

/**
 * The two windows a balance is measured in. 5 hours: the pace is `perCycle`, yellow within 5 cycles.
 * 7 days: the pace is the last 7 days' use, yellow within 4 weeks.
 */
const WINDOWS = {
  "5h": { pace: perCycle, yellowUpTo: 5, unit: "cycles", per: "per 5 hours", more: "more 5-hour cycles" },
  week: { pace: (a: BalanceFacts) => a.usedWeek ?? 0, yellowUpTo: 4, unit: "weeks", per: "per 7 days", more: "more weeks" },
} as const;

const paceText = (left: number, pace: number, w: (typeof WINDOWS)[keyof typeof WINDOWS]): string =>
  pace <= 0 ? "squad used nothing in the last 7 days." : `At about ${centsText(pace)} ${w.per}, it lasts about ${countText(Math.max(0, left / pace))} ${w.more}.`;

const whenText = (iso: string, timeZone: string | undefined, time: boolean): string =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}), ...(timeZone === undefined ? {} : { timeZone }) }).format(Date.parse(iso));

const entered = (a: BalanceFacts): { usd: number; at: string; left: number } | undefined =>
  a.kind === "key" && a.balanceUsd !== undefined && a.balanceAt !== undefined && a.balanceLeft !== undefined ? { usd: a.balanceUsd, at: a.balanceAt, left: round(a.balanceLeft) } : undefined;

export interface BalanceLine {
  readonly text: string;
  readonly tone: BalanceTone;
  readonly hint: string;
}

/** The line under a key's use: "≈ $12.40 balance". Undefined when no balance is entered. */
export function balanceLine(a: BalanceFacts, timeZone?: string): BalanceLine | undefined {
  const b = entered(a);
  if (b === undefined) return undefined;
  return {
    text: `≈ ${centsText(b.left)} balance`,
    tone: balanceTone(b.left, perCycle(a), WINDOWS["5h"].yellowUpTo),
    hint: enteredHint(b, timeZone, paceText(b.left, perCycle(a), WINDOWS["5h"])),
  };
}

const enteredHint = (b: { usd: number; at: string; left: number }, timeZone: string | undefined, pace: string): string =>
  `Entered ${centsText(b.usd)} on ${whenText(b.at, timeZone, true)}, minus ${centsText(b.usd - b.left)} squad used since. ${pace} squad cannot see use outside squad.`;

export interface RunwayBadge {
  readonly text: string;
  readonly tone: BalanceTone;
  /** The hover: what was entered, the pace and how long it lasts. */
  readonly title: string;
}

/** The badge under a key's bar in one window: "≈ $1.50 · 3 cycles" or "≈ $1.50 · 0.6 weeks". */
export function balanceRunway(a: BalanceFacts, window: keyof typeof WINDOWS, timeZone?: string): RunwayBadge | undefined {
  const b = entered(a);
  if (b === undefined) return undefined;
  const w = WINDOWS[window];
  const pace = w.pace(a);
  const howLong = b.left <= 0 ? "used up" : pace <= 0 ? "no use yet" : `${countText(b.left / pace)} ${w.unit}`;
  return { text: `≈ ${centsText(b.left)} · ${howLong}`, tone: balanceTone(b.left, pace, w.yellowUpTo), title: enteredHint(b, timeZone, paceText(b.left, pace, w)) };
}

/** The Balance fact: "≈ $12.40 (entered $20.00 on Oct 25)", or "None". */
export function balanceFact(a: BalanceFacts, timeZone?: string): string {
  const b = entered(a);
  return b === undefined ? "None" : `≈ ${centsText(b.left)} (entered ${centsText(b.usd)} on ${whenText(b.at, timeZone, false)})`;
}

/** The estimate is at or below $0. The pool still picks the key: squad cannot see the real balance. */
export const balanceUsedUp = (a: BalanceFacts): boolean => {
  const b = entered(a);
  return b !== undefined && b.left <= 0;
};

const BALANCE_ERROR = `Use dollars from 0 (at most two decimals, up to ${CAP_MAX_USD}), or leave it empty for no balance.`;

/** Empty = no balance (null). A leading "$" is fine. Unlike a cap, 0 is a real balance. */
export function parseBalance(text: string): CapParse {
  const t = text.trim().replace(/^\$/, "");
  if (t === "") return { ok: true, value: null };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return { ok: false, error: BALANCE_ERROR };
  const n = Number(t);
  if (!(n >= 0 && n <= CAP_MAX_USD)) return { ok: false, error: BALANCE_ERROR };
  return { ok: true, value: n };
}

export const BALANCE_HELP = "Type the balance your provider's console shows. squad takes off what its own passes use from now on.";
