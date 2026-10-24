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

export type SeriesBy = "day" | "hour";

export interface SeriesRow {
  readonly bucket: string;
  readonly account: string;
  readonly passes: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly costUsd: number | null;
}

/** The SQL of a bucket's UTC start. Fixed text per case. `started_at` is always an ISO string with a Z. */
const BUCKET: Record<SeriesBy, string> = {
  day: "substr(started_at, 1, 10)",
  hour: "substr(started_at, 1, 13) || ':00:00Z'",
};

/** Token sums per time bucket and account, for a chart. The filters are those of `usageBy`. */
export function usageSeries(db: DatabaseSync, by: SeriesBy, since: Date, accounts?: readonly string[]): SeriesRow[] {
  const only = accounts === undefined ? "" : ` AND account IN (${accounts.map(() => "?").join(", ") || "NULL"})`;
  const rows = db
    .prepare(
      `SELECT ${BUCKET[by]} AS b, COALESCE(account, '-') AS a, COUNT(*) AS passes,
         SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
         SUM(reasoning) AS reasoning, SUM(cost_usd) AS cost
       FROM passes
       WHERE started_at >= ? AND (outcome IS NULL OR outcome <> 'busy')${only}
       GROUP BY b, a ORDER BY b, a`,
    )
    .all(since.toISOString(), ...(accounts ?? [])) as unknown as { b: string; a: string; passes: number; input: number; output: number; cache_read: number; cache_write: number; reasoning: number; cost: number | null }[];
  return rows.map((r) => ({ bucket: r.b, account: r.a, passes: r.passes, input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, reasoning: r.reasoning, costUsd: r.cost }));
}

export interface PassRow {
  readonly id: string;
  readonly account: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly flow: string;
  readonly action: string;
  readonly taskKind: string | null;
  readonly taskId: string | null;
  readonly runner: string;
  readonly model: string;
  readonly outcome: string | null;
  readonly failKind: string | null;
  readonly failCode: string | null;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly costUsd: number | null;
}

const PASS_COLUMNS = "id, account, started_at, ended_at, flow, action, task_kind, task_id, runner, model, outcome, fail_kind, fail_code, input, output, cache_read, cache_write, reasoning, cost_usd";

interface RawPass { id: string; account: string | null; started_at: string; ended_at: string | null; flow: string; action: string; task_kind: string | null; task_id: string | null; runner: string; model: string; outcome: string | null; fail_kind: string | null; fail_code: string | null; input: number; output: number; cache_read: number; cache_write: number; reasoning: number; cost_usd: number | null }

const toPass = (r: RawPass): PassRow => ({
  id: r.id, account: r.account, startedAt: r.started_at, endedAt: r.ended_at, flow: r.flow, action: r.action, taskKind: r.task_kind, taskId: r.task_id, runner: r.runner, model: r.model,
  outcome: r.outcome, failKind: r.fail_kind, failCode: r.fail_code, input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, reasoning: r.reasoning, costUsd: r.cost_usd,
});

/** One pass row by id. */
export function getPassRow(db: DatabaseSync, id: string): PassRow | undefined {
  const r = db.prepare(`SELECT ${PASS_COLUMNS} FROM passes WHERE id = ?`).get(id) as RawPass | undefined;
  return r === undefined ? undefined : toPass(r);
}

export interface PassPage {
  readonly limit: number;
  /** Only these accounts; undefined = all, including a pass that found no account. */
  readonly accounts?: readonly string[];
  readonly since?: Date;
  /** A pass id: only passes older than it. Ids are ULIDs, so the id order is the time order. */
  readonly before?: string;
}

/** Passes newest first. A busy row is a lost race for an account, not a pass, so it is left out. */
export function listPassesPage(db: DatabaseSync, q: PassPage): PassRow[] {
  const where: string[] = ["(outcome IS NULL OR outcome <> 'busy')"];
  const args: (string | number)[] = [];
  if (q.accounts !== undefined) {
    where.push(`account IN (${q.accounts.map(() => "?").join(", ") || "NULL"})`);
    args.push(...q.accounts);
  }
  if (q.since !== undefined) {
    where.push("started_at >= ?");
    args.push(q.since.toISOString());
  }
  if (q.before !== undefined) {
    where.push("id < ?");
    args.push(q.before);
  }
  const rows = db.prepare(`SELECT ${PASS_COLUMNS} FROM passes${` WHERE ${where.join(" AND ")}`} ORDER BY id DESC LIMIT ?`).all(...args, q.limit) as unknown as RawPass[];
  return rows.map(toPass);
}
