import type { UsageSeriesPoint } from "@squad/contract";

/** `2026-10-24`: the UTC day, the same form as a day bucket. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export interface Totals {
  readonly passes: number;
  readonly tokens: number;
  readonly cliCostUsd?: number;
  readonly catalogCostUsd?: number;
}

/** The sums over a series, or over the buckets of one UTC day. A cost stays unset when no point has it. */
export function seriesTotals(points: readonly UsageSeriesPoint[], day?: string): Totals {
  let passes = 0;
  let tokens = 0;
  let cli: number | undefined;
  let cat: number | undefined;
  for (const p of points) {
    if (day !== undefined && !p.bucket.startsWith(day)) continue;
    passes += p.passes;
    tokens += p.input + p.output + p.cacheRead + p.cacheWrite + p.reasoning;
    if (p.cliCostUsd !== undefined) cli = (cli ?? 0) + p.cliCostUsd;
    if (p.catalogCostUsd !== undefined) cat = (cat ?? 0) + p.catalogCostUsd;
  }
  return { passes, tokens, ...(cli === undefined ? {} : { cliCostUsd: cli }), ...(cat === undefined ? {} : { catalogCostUsd: cat }) };
}
