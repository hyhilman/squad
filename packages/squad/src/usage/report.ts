// Token use grouped for a person to read. Pure queries over the pass table.

import type { DatabaseSync } from "node:sqlite";

export type UsageBy = "account" | "task" | "flow" | "day" | "model";
export const USAGE_BYS: readonly UsageBy[] = ["account", "task", "flow", "day", "model"];

export interface UsageRow {
  readonly key: string;
  readonly passes: number;
  readonly ok: number;
  readonly fail: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  /** null when no pass in the group has a price: a seat has no bill. */
  readonly costUsd: number | null;
}

/** The SQL that makes the group key. Fixed text per case, never built from input. */
const KEY: Record<UsageBy, string> = {
  account: "COALESCE(account, '-')",
  task: "COALESCE(task_kind || ':' || task_id, '-')",
  flow: "flow",
  day: "substr(started_at, 1, 10)",
  model: "model",
};

/**
 * Passes that started at or after `since`, of the named `accounts` only when given (the web app
 * passes a person's own). A busy row is a lost race for an account, not a pass, so
 * it is left out. A pass still open counts in `passes` only.
 */
export function usageBy(db: DatabaseSync, by: UsageBy, since: Date, accounts?: readonly string[]): UsageRow[] {
  const only = accounts === undefined ? "" : ` AND account IN (${accounts.map(() => "?").join(", ") || "NULL"})`;
  const rows = db
    .prepare(
      `SELECT ${KEY[by]} AS k, COUNT(*) AS passes,
         SUM(outcome = 'ok') AS ok, SUM(outcome IS NOT NULL AND outcome NOT IN ('ok', 'busy')) AS fail,
         SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
         SUM(reasoning) AS reasoning, SUM(cost_usd) AS cost
       FROM passes
       WHERE started_at >= ? AND (outcome IS NULL OR outcome <> 'busy')${only}
       GROUP BY k ORDER BY k`,
    )
    .all(since.toISOString(), ...(accounts ?? [])) as unknown as { k: string; passes: number; ok: number; fail: number; input: number; output: number; cache_read: number; cache_write: number; reasoning: number; cost: number | null }[];
  return rows.map((r) => ({ key: r.k, passes: r.passes, ok: r.ok, fail: r.fail, input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, reasoning: r.reasoning, costUsd: r.cost }));
}
