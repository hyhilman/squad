// What a key account used, in dollars, from squad's own pass records only. squad never asks a provider
// for a balance: it sees its own passes and nothing else.

import type { DatabaseSync } from "node:sqlite";

// The CLI cost comes first: pi prices every message itself, also for models the catalog does not list.
// For a plan such as opencode-go it is an estimate from pi's price table, not money spent. A CLI cost of
// 0 means pi had no price, so the catalog cost stands in; with neither, the pass counts 0.
export const USED_COST_SQL = "COALESCE(NULLIF(cli_cost_usd, 0), catalog_cost_usd, 0)";

/** The same rule as USED_COST_SQL, for one pass. */
export const usedCostOf = (cli: number | null, catalog: number | null): number => (cli !== null && cli !== 0 ? cli : (catalog ?? 0));

export interface KeyUsed {
  readonly used5h: number;
  readonly usedWeek: number;
  readonly used30d: number;
}

const HOUR = 3_600_000;
export const WINDOW_MS = { used5h: 5 * HOUR, usedWeek: 7 * 24 * HOUR, used30d: 30 * 24 * HOUR } as const;

/** The used dollars of one account in the rolling windows that end at `now`. A running pass counts 0. */
export function keyUsed(db: DatabaseSync, account: string, now: Date): KeyUsed {
  const t = now.getTime();
  const since = (ms: number): string => new Date(t - ms).toISOString();
  const r = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN started_at >= ? THEN ${USED_COST_SQL} END), 0) AS h5,
       COALESCE(SUM(CASE WHEN started_at >= ? THEN ${USED_COST_SQL} END), 0) AS week,
       COALESCE(SUM(${USED_COST_SQL}), 0) AS d30
     FROM passes WHERE account = ? AND started_at >= ?`,
  ).get(since(WINDOW_MS.used5h), since(WINDOW_MS.usedWeek), account, since(WINDOW_MS.used30d)) as { h5: number; week: number; d30: number };
  return { used5h: r.h5, usedWeek: r.week, used30d: r.d30 };
}
