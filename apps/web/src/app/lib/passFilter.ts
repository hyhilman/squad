// The pass filters that the API has no query for (runner, outcome). They run on the page that is
// loaded, so the page says so.
export type OutcomeGroup = "ok" | "failed" | "running" | "lost";

export const runnerOf = (account: string | undefined): string | undefined => account?.split("/")[0];

export function outcomeGroup(outcome: string | undefined): OutcomeGroup {
  if (outcome === undefined) return "running";
  if (outcome === "ok" || outcome === "lost") return outcome;
  return "failed";
}

interface PassLike {
  readonly account?: string;
  readonly outcome?: string;
  readonly startedAt: string;
}

export function filterPasses<P extends PassLike>(list: readonly P[], f: { runner?: string; outcome?: OutcomeGroup }): P[] {
  return list.filter((p) => (f.runner === undefined || runnerOf(p.account) === f.runner) && (f.outcome === undefined || outcomeGroup(p.outcome) === f.outcome));
}

/** The latest start time per account among the passes given. */
export function lastPassByAccount(list: readonly PassLike[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of list) {
    if (p.account === undefined) continue;
    const seen = out[p.account];
    if (seen === undefined || Date.parse(p.startedAt) > Date.parse(seen)) out[p.account] = p.startedAt;
  }
  return out;
}

/** "3 failed" for the passes given, or "" when none failed. A full page means there may be more. */
export function failedText(list: readonly PassLike[], pageSize: number): string {
  const n = list.filter((p) => p.outcome !== "busy" && outcomeGroup(p.outcome) === "failed").length;
  if (n === 0) return "";
  return `${n}${list.length >= pageSize ? "+" : ""} failed`;
}

const OUTCOMES: readonly OutcomeGroup[] = ["ok", "failed", "running", "lost"];

/** The outcome filter from a link (?outcome=failed); anything else is no filter. */
export const outcomeFromParam = (v: string | null): OutcomeGroup | "" => (OUTCOMES as readonly string[]).includes(v ?? "") ? (v as OutcomeGroup) : "";
