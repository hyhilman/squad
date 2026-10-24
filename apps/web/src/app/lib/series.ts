import type { RoomPoint, UsageSeriesPoint } from "@squad/contract";

export type TokenRow = { bucket: string } & Record<string, number | string>;

const tokens = (p: UsageSeriesPoint): number => p.input + p.output + p.cacheRead + p.cacheWrite + p.reasoning;

/** One row per bucket (oldest first) with one number per account, for a stacked bar chart. */
export function pivotTokens(points: readonly UsageSeriesPoint[]): { accounts: string[]; rows: TokenRow[] } {
  const accounts = [...new Set(points.map((p) => p.account))].sort();
  const buckets = [...new Set(points.map((p) => p.bucket))].sort();
  const rows = buckets.map((bucket): TokenRow => {
    const row: TokenRow = { bucket };
    for (const a of accounts) row[a] = 0;
    for (const p of points) if (p.bucket === bucket) row[p.account] = (row[p.account] as number) + tokens(p);
    return row;
  });
  return { accounts, rows };
}

export function pivotPasses(points: readonly UsageSeriesPoint[]): { bucket: string; passes: number }[] {
  const by = new Map<string, number>();
  for (const p of points) by.set(p.bucket, (by.get(p.bucket) ?? 0) + p.passes);
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([bucket, passes]) => ({ bucket, passes }));
}

/** `2026-10-24` -> `10-24`; `2026-10-24T13:00:00Z` -> `10-24 13:00` (UTC). */
export function bucketLabel(bucket: string): string {
  const m = /^\d{4}-(\d\d-\d\d)(?:T(\d\d:\d\d))?/.exec(bucket);
  if (m === null) return bucket;
  return m[2] === undefined ? m[1]! : `${m[1]} ${m[2]}`;
}

export interface RoomRow {
  /** Epoch ms, for a time axis. */
  readonly t: number;
  readonly left5h: number | undefined;
  readonly leftWeek: number | undefined;
}

export function roomRows(points: readonly RoomPoint[]): RoomRow[] {
  return points
    .flatMap((p) => {
      const t = Date.parse(p.at);
      return Number.isNaN(t) ? [] : [{ t, left5h: p.left5h, leftWeek: p.leftWeek }];
    })
    .sort((a, b) => a.t - b.t);
}
