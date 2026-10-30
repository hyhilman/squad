// The auto-probe planner: which suspect accounts a probe pass should test now. Pure; the web ticker calls it.
// A probe is a real pass, so an account that ran a pass in the last hour already had its test.

import { catalogKey, type Price, type Prices } from "../prices.ts";
import { envNum, envOn, SQUAD_FLOOR_DEFAULT_ENV, SQUAD_NO_AUTO_PROBE_ENV, SQUAD_NO_RESET_PROBE_ENV } from "../settings.ts";
import { emptyHealth, type HealthRow } from "./health.ts";
import { healthOf, type AccountRow } from "./store.ts";

export const PROBE_AFTER_MS = 60 * 60_000;

export function dueProbes(accounts: readonly AccountRow[], health: ReadonlyMap<string, HealthRow>, now: Date, env?: Readonly<Record<string, string | undefined>>): AccountRow[] {
  if (envOn(SQUAD_NO_AUTO_PROBE_ENV, env)) return [];
  return accounts.filter((a) => {
    const h = health.get(a.id) ?? emptyHealth(a.id);
    if (a.consentAt === null || healthOf(a, h, now) !== "suspect") return false;
    const used = h.lastUsedAt === null ? NaN : Date.parse(h.lastUsedAt);
    return !Number.isFinite(used) || now.getTime() - used >= PROBE_AFTER_MS;
  });
}

// ---- the reset probe ----
// A claude account learns its room only from a pass, so after a used-up window resets the page keeps
// the old numbers until someone runs one. The reset probe runs that pass, on the cheapest model.

/** Failure codes that mean the provider refused this model. A pricier model may still answer. */
export const MODEL_REFUSED_CODES: ReadonlySet<string> = new Set(["404", "model_not_found", "403:FreeTierError"]);

/** The most models one reset probe tries. Each one is a real pass. */
export const LADDER_MAX = 3;

export interface ResetProbe {
  readonly account: AccountRow;
  /** The reset this probe answers. A second probe for the same reset is not due. */
  readonly reset: string;
}

/**
 * The latest reset that has passed since the last read, of a window that was at or under its floor.
 * A window with room above the floor is left alone: the probe itself opens a new 5-hour window, so
 * probing every passed reset would run a pass on every idle account every 5 hours.
 */
function passedReset(a: AccountRow, h: HealthRow, now: Date, floor: number): string | undefined {
  const read = h.readAt === null ? -Infinity : Date.parse(h.readAt);
  const low = (left: number | null, own: number | null): boolean => left !== null && left <= (own ?? floor);
  const passed = [low(h.left5h, a.floor5h) ? h.resets5h : null, low(h.leftWeek, a.floorWeek) ? h.resetsWeek : null]
    .map((r) => ({ r, t: r === null ? NaN : Date.parse(r) }))
    .filter(({ t }) => Number.isFinite(t) && t <= now.getTime() && t > read)
    .sort((x, y) => y.t - x.t);
  return passed[0]?.r ?? undefined;
}

export function dueResetProbes(accounts: readonly AccountRow[], health: ReadonlyMap<string, HealthRow>, now: Date, env?: Readonly<Record<string, string | undefined>>): ResetProbe[] {
  if (envOn(SQUAD_NO_AUTO_PROBE_ENV, env) || envOn(SQUAD_NO_RESET_PROBE_ENV, env)) return [];
  const floor = envNum(SQUAD_FLOOR_DEFAULT_ENV, env);
  return accounts.flatMap((a) => {
    // A codex login has its own usage read, which costs no tokens. A key has no window.
    if (a.kind === "key" || (a.runner === "codex" && a.kind === "login")) return [];
    const h = health.get(a.id) ?? emptyHealth(a.id);
    // A suspect account gets the auto probe instead; a cooling one is not ready yet.
    if (a.consentAt === null || healthOf(a, h, now) !== "ok") return [];
    const reset = passedReset(a, h, now, floor);
    return reset === undefined ? [] : [{ account: a, reset }];
  });
}

/**
 * The models to try, cheapest first, one per price, at most LADDER_MAX. One per price: aliases and
 * dated ids of one model share its price, and a step to the same model is no escalation. Among equal
 * prices the id last in sort order wins, which is the newer one for ids that end in a version.
 * A model with no price is left out: there is no way to know it is cheap. With no priced model, the
 * runner's probe model setting is the only step.
 */
export function probeLadder(runner: string, served: readonly string[], prices: Prices, fallback: string | undefined): string[] {
  const priced = served
    .map((m) => ({ m, p: prices.get(catalogKey(runner, m) ?? "") }))
    .filter((x): x is { m: string; p: Price } => x.p !== undefined)
    .sort((a, b) => a.p.input - b.p.input || a.p.output - b.p.output || (a.m < b.m ? 1 : a.m > b.m ? -1 : 0))
    .filter((x, i, all) => i === 0 || x.p.input !== all[i - 1]!.p.input || x.p.output !== all[i - 1]!.p.output)
    .map((x) => x.m);
  if (priced.length > 0) return priced.slice(0, LADDER_MAX);
  return fallback === undefined || fallback === "" ? [] : [fallback];
}
