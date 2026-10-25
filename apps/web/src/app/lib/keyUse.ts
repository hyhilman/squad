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
  /** Set only with a cap: the bar's legend, fill and colour. */
  readonly capText?: string;
  readonly pct?: number;
  readonly tone?: CapTone;
}

export function keyCell(used: number | undefined, cap: number | undefined): KeyCell {
  const u = used ?? 0;
  const usedText = `${usdText(u)} used`;
  if (cap === undefined) return { usedText };
  return { usedText, capText: `Cap ${usdText(cap)}`, pct: Math.min(100, Math.max(0, (u / cap) * 100)), tone: capTone(u, cap) };
}

export const thirtyDayText = (a: Pick<AccountView, "used30d" | "cap30d">): string =>
  a.cap30d === undefined ? `${usdText(a.used30d ?? 0)} in 30 d` : `${usdText(a.used30d ?? 0)} of ${usdText(a.cap30d)} cap in 30 d`;

export const CAP_HINT = "squad stops picking this key when its own passes reach the cap. squad cannot see use outside squad.";
export const NO_CAP_HINT = "No cap: squad picks this key whatever it used. The owner can set one with Caps. squad cannot see use outside squad.";

type CapFacts = Partial<Pick<AccountView, "kind" | "used5h" | "usedWeek" | "used30d" | "cap5h" | "capWeek" | "cap30d">>;

/** The first cap a key's own passes reached, 5 hours first; undefined for none. */
export function capReachedText(a: CapFacts): string | undefined {
  if (a.kind !== "key") return undefined;
  const hit = (used: number | undefined, cap: number | undefined): boolean => cap !== undefined && (used ?? 0) >= cap;
  if (hit(a.used5h, a.cap5h)) return "5-hour cap reached";
  if (hit(a.usedWeek, a.capWeek)) return "Week cap reached";
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
  if (!b.ok) errors.push(`Week cap: ${b.error}`);
  if (!c.ok) errors.push(`30-day cap: ${c.error}`);
  return { ok: false, errors };
}

/** The text a caps box starts with: the cap, or empty for none. */
export const capInput = (cap: number | undefined): string => (cap === undefined ? "" : String(cap));

/** The caps that are set, for a fact list: "5 h $2 · 30 d $50", or "None". */
export function capsText(a: Partial<Pick<AccountView, "cap5h" | "capWeek" | "cap30d">>): string {
  const parts = [["5 h", a.cap5h], ["week", a.capWeek], ["30 d", a.cap30d]] as const;
  const set = parts.flatMap(([k, v]) => (v === undefined ? [] : [`${k} ${usdText(v)}`]));
  return set.length === 0 ? "None" : set.join(" · ");
}
