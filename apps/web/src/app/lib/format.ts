// Pure helpers for the pages: no React, no fetch, so `node --test` can run them.

export const pctText = (n: number | undefined): string => (n === undefined ? "unknown" : `${n}%`);

export function agoText(iso: string | undefined, now: Date): string {
  if (iso === undefined) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const sec = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86_400)} d ago`;
}

export interface RoomInput {
  readonly runner: string;
  readonly left5h?: number;
  readonly leftWeek?: number;
}

export interface RunnerRoom {
  readonly runner: string;
  readonly accounts: number;
  /** How many accounts had a usage read. */
  readonly read: number;
  /** Average percent left over the accounts that had a read; undefined when none had. */
  readonly left5h?: number;
  readonly leftWeek?: number;
}

const avg = (xs: number[]): number | undefined => (xs.length === 0 ? undefined : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));

export function roomByRunner(accounts: readonly RoomInput[]): RunnerRoom[] {
  const runners = [...new Set(accounts.map((a) => a.runner))].sort();
  return runners.map((runner) => {
    const mine = accounts.filter((a) => a.runner === runner);
    const five = mine.flatMap((a) => (a.left5h === undefined ? [] : [a.left5h]));
    const week = mine.flatMap((a) => (a.leftWeek === undefined ? [] : [a.leftWeek]));
    const l5 = avg(five);
    const lw = avg(week);
    return {
      runner,
      accounts: mine.length,
      read: mine.filter((a) => a.left5h !== undefined || a.leftWeek !== undefined).length,
      ...(l5 === undefined ? {} : { left5h: l5 }),
      ...(lw === undefined ? {} : { leftWeek: lw }),
    };
  });
}

export const totalTokens = (r: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }): number =>
  r.input + r.output + r.cacheRead + r.cacheWrite + r.reasoning;

export const hasCost = (rows: readonly { costUsd?: number }[]): boolean => rows.some((r) => r.costUsd !== undefined);

export const costText = (usd: number | undefined): string => (usd === undefined ? "" : `$${usd.toFixed(2)}`);

const nf = new Intl.NumberFormat("en-US");
export const tokensText = (n: number): string => nf.format(n);

/** 1500 -> 1.5k. Short numbers for chart axes. */
export function compactNumber(n: number): string {
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of units) if (Math.abs(n) >= size) return `${Math.round((n / size) * 10) / 10}${suffix}`;
  return String(n);
}

export function durationText(startIso: string, endIso: string | undefined): string {
  if (endIso === undefined) return "running";
  const sec = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000));
  if (Number.isNaN(sec)) return "unknown";
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const rest = min % 60;
  return rest === 0 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 60)} h ${rest} min`;
}

/** Money for a pass or a model: cents when it is a cent or more, else four decimals (a pass often costs a fraction of a cent). */
export const moneyText = (usd: number | undefined): string => (usd === undefined ? "" : usd === 0 || usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);

/** How far the catalog cost is from the CLI cost, in percent of the CLI cost. Unset unless both exist and the CLI cost is above zero. */
export function gapPercent(cli: number | undefined, catalog: number | undefined): number | undefined {
  if (cli === undefined || catalog === undefined || !(cli > 0)) return undefined;
  return ((catalog - cli) / cli) * 100;
}

export const gapText = (gap: number | undefined): string => (gap === undefined ? "-" : `${gap > 0 ? "+" : ""}${gap.toFixed(1)}%`);

export interface CostCompareRow {
  readonly key: string;
  readonly passes: number;
  readonly cliCostUsd?: number;
  readonly catalogCostUsd?: number;
  readonly gap?: number;
}

/** Rows of usage by model that have either cost, with the gap. Biggest catalog cost first. */
export function costCompare(rows: readonly { key: string; passes: number; cliCostUsd?: number; catalogCostUsd?: number }[]): CostCompareRow[] {
  return rows
    .filter((r) => r.cliCostUsd !== undefined || r.catalogCostUsd !== undefined)
    .map((r) => {
      const gap = gapPercent(r.cliCostUsd, r.catalogCostUsd);
      return { key: r.key, passes: r.passes, ...(r.cliCostUsd === undefined ? {} : { cliCostUsd: r.cliCostUsd }), ...(r.catalogCostUsd === undefined ? {} : { catalogCostUsd: r.catalogCostUsd }), ...(gap === undefined ? {} : { gap }) };
    })
    .sort((a, b) => (b.catalogCostUsd ?? b.cliCostUsd ?? 0) - (a.catalogCostUsd ?? a.cliCostUsd ?? 0) || a.key.localeCompare(b.key));
}
