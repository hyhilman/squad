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
