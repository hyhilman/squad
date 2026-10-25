// The auto-probe planner: which suspect accounts a probe pass should test now. Pure; the web ticker calls it.
// A probe is a real pass, so an account that ran a pass in the last hour already had its test.

import { envOn, SQUAD_NO_AUTO_PROBE_ENV } from "../settings.ts";
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
