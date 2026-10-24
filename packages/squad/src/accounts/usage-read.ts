// The usage read of a codex login: how much of the 5-hour and weekly window is left.
//
// It is a GET with the access token already in `auth.json`. It never writes that file and never
// refreshes the token: a login has one writer (the pass container), and a refresh here would race it.
// A token that has gone stale is a 401, which marks the account suspect. A clean pass then fixes it,
// because the CLI refreshes in its own container.
//
// Nothing here returns or logs a token, an account id, a header or the auth file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Log } from "../log.ts";
import type { HomeLayout } from "../home.ts";
import { IMAGES } from "../images.ts";
import { envNum, envOn, SQUAD_NO_USAGE_READ_ENV, SQUAD_USAGE_READ_S_ENV } from "../settings.ts";
import { isBusy, type Store } from "../store/db.ts";
import type { Room } from "../types.ts";
import { applyRead, emptyHealth, type HealthRow, type UsageReadResult } from "./health.ts";
import { getHealth, healthOf, putHealth, recordRoom, type AccountRow } from "./store.ts";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const READ_TIMEOUT_MS = 15_000;
const WINDOW_5H_S = 18_000;
const WINDOW_WEEK_S = 604_800;

export interface CodexUsage {
  readonly room: Room;
  readonly plan: string | null;
  readonly limitReached: boolean;
}

type FetchFn = typeof globalThis.fetch;

interface Win { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown }

const left = (used: number): number => Math.min(100, Math.max(0, 100 - used));

/** Windows are found by their length, not by primary or secondary: the position is not a promise. */
export function parseCodexUsage(json: unknown): CodexUsage {
  const body = (json ?? {}) as { plan_type?: unknown; rate_limit?: { limit_reached?: unknown; primary_window?: Win | null; secondary_window?: Win | null } | null };
  const wins = [body.rate_limit?.primary_window, body.rate_limit?.secondary_window].filter((w): w is Win => typeof w === "object" && w !== null);
  let room: Room = {};
  for (const w of wins) {
    if (typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) continue;
    const resets = typeof w.reset_at === "number" && Number.isFinite(w.reset_at) ? new Date(w.reset_at * 1000).toISOString() : undefined;
    if (w.limit_window_seconds === WINDOW_5H_S) room = { ...room, left5h: left(w.used_percent), ...(resets === undefined ? {} : { resets5h: resets }) };
    else if (w.limit_window_seconds === WINDOW_WEEK_S) room = { ...room, leftWeek: left(w.used_percent), ...(resets === undefined ? {} : { resetsWeek: resets }) };
  }
  if (room.left5h === undefined && room.leftWeek === undefined) throw new Error("usage answer has no known window");
  return { room, plan: typeof body.plan_type === "string" ? body.plan_type : null, limitReached: body.rate_limit?.limit_reached === true };
}

/** The two fields the read needs. Everything else in the file is left alone and unread. */
function credentials(accountDir: string): { token: string; accountId: string | undefined } | undefined {
  try {
    const t = (JSON.parse(readFileSync(join(accountDir, "auth.json"), "utf8")) as { tokens?: { access_token?: unknown; account_id?: unknown } }).tokens;
    if (typeof t?.access_token !== "string" || t.access_token === "") return undefined;
    return { token: t.access_token, accountId: typeof t.account_id === "string" && t.account_id !== "" ? t.account_id : undefined };
  } catch {
    return undefined;
  }
}

/** One read. It never throws and never writes. The reasons are fixed short words. */
export async function readCodexUsage(accountDir: string, fetchFn: FetchFn = globalThis.fetch): Promise<UsageReadResult> {
  const cred = credentials(accountDir);
  if (cred === undefined) return { error: "no login" };
  let res: Response;
  try {
    res = await fetchFn(USAGE_URL, {
      // The Codex CLI's own headers: the endpoint serves the CLI, so the read looks like one.
      headers: {
        authorization: `Bearer ${cred.token}`,
        ...(cred.accountId === undefined ? {} : { "chatgpt-account-id": cred.accountId }),
        originator: "codex_cli_rs",
        "user-agent": `codex_cli_rs/${IMAGES.codex.version}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: (e as { name?: unknown } | null)?.name === "TimeoutError" ? "timeout" : "network error" };
  }
  if (res.status === 401 || res.status === 403) return { suspect: true };
  if (!res.ok) return { error: `http ${res.status}` };
  try {
    return { ok: parseCodexUsage(await res.json()) };
  } catch {
    return { error: "bad answer" };
  }
}

/** Reads one account and writes the result to its health. A busy database loses the update; the next read fixes it. */
export async function refreshUsage(store: Store, home: HomeLayout, account: AccountRow, fetchFn: FetchFn, now: Date, log?: Log): Promise<UsageReadResult> {
  const read = await readCodexUsage(join(home.accounts, account.runner, account.name), fetchFn);
  const change = applyRead(getHealth(store.db, account.id), read, now);
  try {
    putHealth(store.db, change.health);
    if ("ok" in read) recordRoom(store.db, account.id, now, "read", read.ok.room.left5h, read.ok.room.leftWeek);
  } catch (e) {
    if (!isBusy(e)) throw e;
    log?.warn("usage-write-busy", { account: account.id });
  }
  if (change.event !== undefined) store.event({ at: now.toISOString(), kind: change.event.kind, account: account.id, code: change.event.code });
  log?.info("usage-read", { account: account.id, result: "ok" in read ? "ok" : "suspect" in read ? "suspect" : "error", ...("error" in read ? { reason: read.error } : {}) });
  return read;
}

/**
 * The schedule is a budget per call. A caller runs `dueReads` once a minute. Each call gives at most
 * ceil(n / minutes-in-interval) accounts, oldest read first (never read first of all), and only those
 * whose last read is at least one interval old. So n accounts spread over the interval: no burst.
 */
export function readBudget(n: number, intervalMs: number): number {
  return n === 0 ? 0 : Math.ceil(n / Math.max(1, intervalMs / 60_000));
}

/**
 * The codex login accounts to read now. A suspect account is left out: its token is already known
 * bad, and a probe pass (not a read) is what tests it. A dead, disabled or moved account is left out too.
 * A read that failed with an error leaves `read_at` as it was, so that account is due again next call.
 */
export function dueReads(
  accounts: readonly AccountRow[],
  health: ReadonlyMap<string, HealthRow>,
  now: Date,
  intervalMs: number,
  env?: Readonly<Record<string, string | undefined>>,
  limit?: number,
): AccountRow[] {
  if (envOn(SQUAD_NO_USAGE_READ_ENV, env)) return [];
  const h = (a: AccountRow): HealthRow => health.get(a.id) ?? emptyHealth(a.id);
  const eligible = accounts.filter((a) => a.runner === "codex" && a.kind === "login" && a.state === "active" && healthOf(a, h(a), now) !== "suspect");
  const at = (a: AccountRow): number => {
    const t = h(a).readAt === null ? NaN : Date.parse(h(a).readAt!);
    return Number.isFinite(t) ? t : -Infinity;
  };
  return eligible
    .filter((a) => now.getTime() - at(a) >= intervalMs)
    .sort((a, b) => (at(a) !== at(b) ? at(a) - at(b) : a.id < b.id ? -1 : 1))
    .slice(0, limit ?? readBudget(eligible.length, intervalMs));
}

/** The interval setting, in ms. */
export const readIntervalMs = (env?: Readonly<Record<string, string | undefined>>): number => envNum(SQUAD_USAGE_READ_S_ENV, env) * 1000;
