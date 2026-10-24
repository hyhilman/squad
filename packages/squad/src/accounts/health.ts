// The pure step from one pass outcome to a health change. It reads no clock and no database.
// `busy` and `no-account` are not about the account's health, so they change nothing.

import { PERMANENT_AUTH_CODES } from "../classify.ts";
import { envNum, SQUAD_COOL_QUOTA_S_ENV, SQUAD_COOL_RATE_LIMIT_S_ENV } from "../settings.ts";
import type { Failure, Room } from "../types.ts";

export interface HealthRow {
  readonly account: string;
  readonly coolUntil: string | null;
  readonly coolKind: string | null;
  readonly suspectSince: string | null;
  readonly authFails: number;
  readonly lastOkAt: string | null;
  readonly lastFailAt: string | null;
  readonly lastFailKind: string | null;
  readonly lastFailCode: string | null;
  readonly lastUsedAt: string | null;
  readonly left5h: number | null;
  readonly leftWeek: number | null;
  readonly readAt: string | null;
}

export const emptyHealth = (account: string): HealthRow => ({
  account,
  coolUntil: null,
  coolKind: null,
  suspectSince: null,
  authFails: 0,
  lastOkAt: null,
  lastFailAt: null,
  lastFailKind: null,
  lastFailCode: null,
  lastUsedAt: null,
  left5h: null,
  leftWeek: null,
  readAt: null,
});

export interface HealthChange {
  readonly health: HealthRow;
  readonly accountState?: "dead";
  readonly event?: { readonly kind: "dead" | "auth-fail"; readonly code: string };
}

/** Two auth fails in a row (no success between) kill the account. */
export const AUTH_FAILS_TO_DIE = 2;

const plus = (now: Date, s: number): string => new Date(now.getTime() + s * 1000).toISOString();

/** The reset time of the window that ran out. Falls back to the later future reset, then to null. */
function quotaReset(room: Room | undefined, now: Date): string | null {
  if (room === undefined) return null;
  const later = (t: string | undefined): number => (t === undefined ? NaN : Date.parse(t));
  const empty: (string | undefined)[] = [];
  if (room.left5h !== undefined && room.left5h <= 0) empty.push(room.resets5h);
  if (room.leftWeek !== undefined && room.leftWeek <= 0) empty.push(room.resetsWeek);
  const pool = empty.some((t) => Number.isFinite(later(t))) ? empty : [room.resets5h, room.resetsWeek];
  const future = pool.map(later).filter((t) => Number.isFinite(t) && t > now.getTime());
  return future.length === 0 ? null : new Date(Math.max(...future)).toISOString();
}

export function applyOutcome(
  prev: HealthRow,
  outcome: { readonly failure?: Failure; readonly room?: Room },
  now: Date,
  env?: Readonly<Record<string, string | undefined>>,
): HealthChange {
  const { failure, room } = outcome;
  if (failure?.kind === "busy" || failure?.kind === "no-account") return { health: prev };

  const at = now.toISOString();
  let h: HealthRow = { ...prev, lastUsedAt: at };
  if (room !== undefined && (room.left5h !== undefined || room.leftWeek !== undefined)) {
    h = { ...h, left5h: room.left5h ?? h.left5h, leftWeek: room.leftWeek ?? h.leftWeek, readAt: at };
  }

  if (failure === undefined) {
    return { health: { ...h, authFails: 0, lastOkAt: at, coolUntil: null, coolKind: null, suspectSince: null } };
  }

  h = { ...h, lastFailAt: at, lastFailKind: failure.kind, lastFailCode: failure.code };
  switch (failure.kind) {
    case "rate-limit":
      return { health: { ...h, coolKind: "rate-limit", coolUntil: plus(now, envNum(SQUAD_COOL_RATE_LIMIT_S_ENV, env)) } };
    case "quota":
      return { health: { ...h, coolKind: "quota", coolUntil: quotaReset(room, now) ?? plus(now, envNum(SQUAD_COOL_QUOTA_S_ENV, env)) } };
    case "auth": {
      if (PERMANENT_AUTH_CODES.has(failure.code)) return { health: h, accountState: "dead", event: { kind: "dead", code: failure.code } };
      const fails = prev.authFails + 1;
      h = { ...h, authFails: fails, suspectSince: prev.suspectSince ?? at };
      if (fails >= AUTH_FAILS_TO_DIE) return { health: h, accountState: "dead", event: { kind: "dead", code: failure.code } };
      return { health: h, event: { kind: "auth-fail", code: failure.code } };
    }
    default:
      return { health: h };
  }
}

/** What one usage read found. A 401 or 403 is `suspect`; `error` carries a short reason and no secret. */
export type UsageReadResult =
  | { readonly ok: { readonly room: Room; readonly plan: string | null; readonly limitReached: boolean } }
  | { readonly suspect: true }
  | { readonly error: string };

export interface ReadChange {
  readonly health: HealthRow;
  readonly event?: { readonly kind: "usage-401"; readonly code: string };
}

/**
 * The pure step from one usage read to a health change. A read never clears a suspicion: only a clean
 * pass does, because a read proves the token is accepted but not that the login still refreshes.
 */
export function applyRead(prev: HealthRow, read: UsageReadResult, now: Date): ReadChange {
  const at = now.toISOString();
  if ("ok" in read) {
    const { room } = read.ok;
    return { health: { ...prev, left5h: room.left5h ?? prev.left5h, leftWeek: room.leftWeek ?? prev.leftWeek, readAt: at } };
  }
  if ("suspect" in read) {
    if (prev.suspectSince !== null) return { health: prev };
    return { health: { ...prev, suspectSince: at }, event: { kind: "usage-401", code: "401" } };
  }
  return { health: prev };
}
