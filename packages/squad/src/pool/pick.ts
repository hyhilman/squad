// The pool pick: which account runs the next pass. It never waits. A busy account is a refusal, so
// the pass goes to the next account, and with none left the answer is `no-account` at once.
//
// This is pure: the caller reads health, usage, locks and live containers, and passes them in.

export type Health = "ok" | "suspect" | "cooling" | "dead" | "disabled" | "moved" | "removed";

/** One account as the pick sees it. */
export interface Candidate {
  /** `<runner>/<name>`, such as `codex/alice`. */
  readonly account: string;
  readonly health: Health;
  /** ISO time a cool-down ends; in the past or unset = not cooling. */
  readonly coolUntil?: string;
  /** Percent left in the 5-hour and weekly windows, from the latest usage read. Unset = no read. */
  readonly left5h?: number;
  readonly leftWeek?: number;
  /** When that read was taken. A read older than `maxReadAgeMs` counts as no read. */
  readonly readAt?: string;
  /** The floors: the share of each window left for the owner. The pass needs more than this. */
  readonly floor5h: number;
  readonly floorWeek: number;
  /** A live container holds the account, or a host-side `flock -n` probe failed. */
  readonly busy: boolean;
  /** ISO time of the last pass; unset = never used. */
  readonly lastUsedAt?: string;
  /** False: the owner stopped sharing it, so squad refuses every pass on it. Unset = shared. */
  readonly sharing?: boolean;
  /** A key account whose own passes reached an owner's dollar cap in that cap's window. */
  readonly capReached?: boolean;
}

export type Skip = "dead" | "disabled" | "moved" | "removed" | "no-consent" | "cooling" | "suspect" | "under-floor" | "busy";

export interface PickResult {
  /** Accounts to try in order. The caller starts the first; on exit 75 (lost the lock race) the next. */
  readonly order: readonly string[];
  /** Why each other account was left out. */
  readonly skipped: Readonly<Record<string, Skip>>;
}

export const MAX_READ_AGE_MS = 60_000;

const time = (iso: string | undefined): number => (iso === undefined ? NaN : Date.parse(iso));

/** The room on the tighter window, as percent points above the floor. No read = the most room. */
function room(c: Candidate, fresh: boolean): number {
  if (!fresh || c.left5h === undefined || c.leftWeek === undefined) return Infinity;
  return Math.min(c.left5h - c.floor5h, c.leftWeek - c.floorWeek);
}

export interface PickOptions {
  /**
   * A probe of one named account. It may run on a suspect or cooling account: the probe is how such
   * an account gets its test. Every other refusal stays.
   */
  readonly probe?: boolean;
}

export function pick(candidates: readonly Candidate[], now: number = Date.now(), maxReadAgeMs: number = MAX_READ_AGE_MS, opts: PickOptions = {}): PickResult {
  const probe = opts.probe === true;
  const skipped: Record<string, Skip> = {};
  const left: { c: Candidate; room: number }[] = [];
  for (const c of candidates) {
    if (c.health === "dead" || c.health === "disabled" || c.health === "moved" || c.health === "removed") {
      skipped[c.account] = c.health;
      continue;
    }
    if (c.sharing === false) {
      skipped[c.account] = "no-consent";
      continue;
    }
    // A suspect account waits for a probe; a real pass must not be its test.
    if (c.health === "suspect" && !probe) {
      skipped[c.account] = "suspect";
      continue;
    }
    // Cooling until a time in the future. A cool-down that ran out counts as ok; `cooling` with no
    // end time stays cooling until something clears it.
    const until = time(c.coolUntil);
    const coolEnded = Number.isFinite(until) && until <= now;
    if (!probe && ((Number.isFinite(until) && until > now) || (c.health === "cooling" && !coolEnded))) {
      skipped[c.account] = "cooling";
      continue;
    }
    const readAge = now - time(c.readAt);
    const fresh = Number.isFinite(readAge) && readAge <= maxReadAgeMs;
    // A reached dollar cap is the key's floor: the room the owner keeps is gone.
    if (c.capReached === true || (fresh && c.left5h !== undefined && c.leftWeek !== undefined && (c.left5h <= c.floor5h || c.leftWeek <= c.floorWeek))) {
      skipped[c.account] = "under-floor";
      continue;
    }
    if (c.busy) {
      skipped[c.account] = "busy";
      continue;
    }
    left.push({ c, room: room(c, fresh) });
  }
  left.sort((a, b) => {
    if (a.room !== b.room) return b.room - a.room;
    // Least recently used first; never used is the oldest.
    const ua = time(a.c.lastUsedAt);
    const ub = time(b.c.lastUsedAt);
    const na = Number.isFinite(ua) ? ua : -Infinity;
    const nb = Number.isFinite(ub) ? ub : -Infinity;
    if (na !== nb) return na - nb;
    return a.c.account < b.c.account ? -1 : a.c.account > b.c.account ? 1 : 0;
  });
  return { order: left.map((x) => x.c.account), skipped };
}
