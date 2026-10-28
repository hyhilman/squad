// Accounts and their health in the database. The state machine has one rule worth a name: a dead
// account is alive again only through `reviveByLogin`, which a person's fresh login calls, or
// `resetHealth`, which a person asks for and which refuses a permanent code. Nothing else, no retry
// and no timer, can bring it back.
//
// A removed account keeps its row, so its passes still name it; it leaves every list and the pool.

import type { DatabaseSync } from "node:sqlite";
import { PERMANENT_AUTH_CODES } from "../classify.ts";
import type { AccountKind, Runner } from "../docker.ts";
import type { Candidate, Health } from "../pool/pick.ts";
import { envNum, envOn, SQUAD_FLOOR_DEFAULT_ENV, SQUAD_NO_KEY_CAPS_ENV } from "../settings.ts";
import { keyUsed } from "../usage/key-used.ts";
import { emptyHealth, type HealthRow } from "./health.ts";

export type AccountState = "active" | "dead" | "disabled" | "moved" | "removed";

export interface AccountRow {
  readonly id: string;
  readonly runner: Runner;
  readonly name: string;
  readonly kind: AccountKind;
  readonly ownerEmail: string | null;
  readonly state: AccountState;
  readonly deadCode: string | null;
  readonly deadAt: string | null;
  readonly floor5h: number | null;
  readonly floorWeek: number | null;
  readonly createdAt: string;
  /** When the owner agreed (in the web app) that the pool may use the account; null = not yet. */
  readonly consentAt: string | null;
  /** The email of the seat that is logged in; it can differ from the owner. null = unknown. */
  readonly loginEmail: string | null;
  /** Who consented: an email, `cli`, or `migration`. null while not shared. */
  readonly consentBy: string | null;
  /** The owner's dollar caps on a key account per window; null = no cap. */
  readonly cap5h: number | null;
  readonly capWeek: number | null;
  readonly cap30d: number | null;
  /** The balance the owner typed from the provider's console, and when. Display only: the pool never reads it. */
  readonly balanceUsd: number | null;
  readonly balanceAt: string | null;
}

export interface NewAccount {
  readonly runner: Runner;
  readonly name: string;
  readonly kind: AccountKind;
  readonly ownerEmail?: string;
  readonly loginEmail?: string;
  /**
   * Who shares it from the start. Unset = `cli`: a person on the host made it for themselves. false =
   * not shared until the owner agrees (`--owner`: an admin may add an account for someone else).
   */
  readonly consent?: { readonly by: string } | false;
}

const RUNNERS: readonly string[] = ["claude", "codex", "pi"];
const KINDS: readonly string[] = ["login", "key", "token"];
/** The name becomes a folder name, so it can hold no slash or dot-dot. */
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const NAME = ACCOUNT_NAME;

export const accountId = (runner: string, name: string): string => `${runner}/${name}`;

interface Raw {
  id: string; runner: string; name: string; kind: string; owner_email: string | null; state: string;
  dead_code: string | null; dead_at: string | null; floor_5h: number | null; floor_week: number | null; created_at: string; consent_at: string | null; login_email: string | null;
  consent_by: string | null; cap_5h: number | null; cap_week: number | null; cap_30d: number | null;
  balance_usd: number | null; balance_at: string | null;
}

const toAccount = (r: Raw): AccountRow => ({
  id: r.id, runner: r.runner as Runner, name: r.name, kind: r.kind as AccountKind, ownerEmail: r.owner_email, state: r.state as AccountState,
  deadCode: r.dead_code, deadAt: r.dead_at, floor5h: r.floor_5h, floorWeek: r.floor_week, createdAt: r.created_at, consentAt: r.consent_at, loginEmail: r.login_email, consentBy: r.consent_by,
  cap5h: r.cap_5h, capWeek: r.cap_week, cap30d: r.cap_30d, balanceUsd: r.balance_usd, balanceAt: r.balance_at,
});

export function addAccount(db: DatabaseSync, a: NewAccount, now: Date = new Date()): AccountRow {
  if (!RUNNERS.includes(a.runner)) throw new Error(`unknown runner ${JSON.stringify(a.runner)}`);
  if (!KINDS.includes(a.kind)) throw new Error(`unknown account kind ${JSON.stringify(a.kind)}`);
  if (!NAME.test(a.name)) throw new Error(`account name ${JSON.stringify(a.name)} is not safe for a folder name`);
  if (a.kind === "token" && a.runner !== "claude") throw new Error(`a token account is for claude only, not ${a.runner}`);
  if (a.kind === "key" && a.runner === "claude") throw new Error("claude has no key account kind here: use a token or a login");
  const id = accountId(a.runner, a.name);
  // A removed row gives its name back: the new account replaces it. Its passes keep the id.
  if (getAccount(db, id)?.state === "removed") db.prepare("DELETE FROM accounts WHERE id = ? AND state = 'removed'").run(id);
  const consent = a.consent === undefined ? { by: "cli" } : a.consent;
  db.prepare("INSERT INTO accounts (id, runner, name, kind, owner_email, login_email, created_at, consent_at, consent_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, a.runner, a.name, a.kind, a.ownerEmail ?? null, a.loginEmail ?? null, now.toISOString(), consent === false ? null : now.toISOString(), consent === false ? null : consent.by,
  );
  return getAccount(db, id)!;
}

export function getAccount(db: DatabaseSync, id: string): AccountRow | undefined {
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Raw | undefined;
  return r === undefined ? undefined : toAccount(r);
}

/** The account, or undefined when there is none or it was removed: an "exists?" check for a new one. */
export function liveAccount(db: DatabaseSync, id: string): AccountRow | undefined {
  const a = getAccount(db, id);
  return a === undefined || a.state === "removed" ? undefined : a;
}

/** The accounts; a removed one only with `withRemoved`. */
export function listAccounts(db: DatabaseSync, runner?: string, opts: { readonly withRemoved?: boolean } = {}): AccountRow[] {
  const rows = (runner === undefined ? db.prepare("SELECT * FROM accounts ORDER BY id").all() : db.prepare("SELECT * FROM accounts WHERE runner = ? ORDER BY id").all(runner)) as unknown as Raw[];
  return rows.map(toAccount).filter((a) => opts.withRemoved === true || a.state !== "removed");
}

/** Any change of state but dead -> active. A dead account gets `dead_code` and `dead_at`. */
export function setState(db: DatabaseSync, id: string, state: AccountState, code?: string, now: Date = new Date()): void {
  const cur = getAccount(db, id);
  if (cur === undefined) throw new Error(`unknown account ${id}`);
  if (cur.state === "dead" && state === "active") throw new Error(`${id} is dead: only reviveByLogin can make it active`);
  if (cur.state === "removed" || state === "removed") throw new Error(`${id}: only markRemoved removes an account, and a removed one stays removed`);
  if (state === "dead") {
    db.prepare("UPDATE accounts SET state = 'dead', dead_code = ?, dead_at = ? WHERE id = ?").run(code ?? null, now.toISOString(), id);
  } else {
    db.prepare("UPDATE accounts SET state = ?, dead_code = NULL, dead_at = NULL WHERE id = ?").run(state, id);
  }
}

/** A fresh login for a dead account. It clears the fail count and the suspicion with it. */
export function reviveByLogin(db: DatabaseSync, id: string): void {
  const cur = getAccount(db, id);
  if (cur === undefined) throw new Error(`unknown account ${id}`);
  if (cur.state !== "dead") throw new Error(`${id} is not dead`);
  db.prepare("UPDATE accounts SET state = 'active', dead_code = NULL, dead_at = NULL WHERE id = ?").run(id);
  db.prepare("UPDATE health SET auth_fails = 0, suspect_since = NULL WHERE account = ?").run(id);
}

export function setOwnerEmail(db: DatabaseSync, id: string, email: string | null): void {
  db.prepare("UPDATE accounts SET owner_email = ? WHERE id = ?").run(email, id);
}

export function setLoginEmail(db: DatabaseSync, id: string, email: string | null): void {
  db.prepare("UPDATE accounts SET login_email = ? WHERE id = ?").run(email, id);
}

export interface RoomRead {
  readonly at: string;
  readonly source: "read" | "pass";
  readonly left5h: number | null;
  readonly leftWeek: number | null;
}

/** One reading of room left. A reading with neither window is not stored. */
export function recordRoom(db: DatabaseSync, account: string, at: Date, source: RoomRead["source"], left5h: number | undefined, leftWeek: number | undefined): void {
  if (left5h === undefined && leftWeek === undefined) return;
  db.prepare("INSERT INTO room_reads (account, at, left_5h, left_week, source) VALUES (?, ?, ?, ?, ?)").run(account, at.toISOString(), left5h ?? null, leftWeek ?? null, source);
}

/** The readings at or after `since`, oldest first. */
export function roomSince(db: DatabaseSync, account: string, since: Date): RoomRead[] {
  const rows = db.prepare("SELECT at, source, left_5h, left_week FROM room_reads WHERE account = ? AND at >= ? ORDER BY at, id").all(account, since.toISOString()) as unknown as { at: string; source: string; left_5h: number | null; left_week: number | null }[];
  return rows.map((r) => ({ at: r.at, source: r.source as RoomRead["source"], left5h: r.left_5h, leftWeek: r.left_week }));
}

interface RawHealth {
  account: string; cool_until: string | null; cool_kind: string | null; suspect_since: string | null; auth_fails: number;
  last_ok_at: string | null; last_fail_at: string | null; last_fail_kind: string | null; last_fail_code: string | null;
  last_used_at: string | null; left_5h: number | null; left_week: number | null; read_at: string | null; resets_5h: string | null; resets_week: string | null;
}

const toHealth = (r: RawHealth): HealthRow => ({
  account: r.account, coolUntil: r.cool_until, coolKind: r.cool_kind, suspectSince: r.suspect_since, authFails: r.auth_fails,
  lastOkAt: r.last_ok_at, lastFailAt: r.last_fail_at, lastFailKind: r.last_fail_kind, lastFailCode: r.last_fail_code,
  lastUsedAt: r.last_used_at, left5h: r.left_5h, leftWeek: r.left_week, readAt: r.read_at, resets5h: r.resets_5h, resetsWeek: r.resets_week,
});

export function getHealth(db: DatabaseSync, account: string): HealthRow {
  const r = db.prepare("SELECT * FROM health WHERE account = ?").get(account) as RawHealth | undefined;
  return r === undefined ? emptyHealth(account) : toHealth(r);
}

export function putHealth(db: DatabaseSync, h: HealthRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO health (account, cool_until, cool_kind, suspect_since, auth_fails, last_ok_at, last_fail_at, last_fail_kind, last_fail_code, last_used_at, left_5h, left_week, read_at, resets_5h, resets_week)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(h.account, h.coolUntil, h.coolKind, h.suspectSince, h.authFails, h.lastOkAt, h.lastFailAt, h.lastFailKind, h.lastFailCode, h.lastUsedAt, h.left5h, h.leftWeek, h.readAt, h.resets5h, h.resetsWeek);
}

const orUndef = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

/** The health word of an account: its state when it is not active, else suspect, cooling or ok. */
export function healthOf(a: AccountRow, h: HealthRow, now: Date): Health {
  const cooling = h.coolUntil !== null && Date.parse(h.coolUntil) > now.getTime();
  return a.state !== "active" ? a.state : h.suspectSince !== null ? "suspect" : cooling ? "cooling" : "ok";
}

/** The floors are percents left in each window that the pool keeps for the owner. */
export function setFloors(db: DatabaseSync, id: string, floor5h: number, floorWeek: number): void {
  if (getAccount(db, id) === undefined) throw new Error(`unknown account ${id}`);
  db.prepare("UPDATE accounts SET floor_5h = ?, floor_week = ? WHERE id = ?").run(floor5h, floorWeek, id);
}

/** The owner's floors; null clears one back to the default. */
export function setOwnerFloors(db: DatabaseSync, id: string, floor5h: number | null, floorWeek: number | null): void {
  if (getAccount(db, id) === undefined) throw new Error(`unknown account ${id}`);
  db.prepare("UPDATE accounts SET floor_5h = ?, floor_week = ? WHERE id = ?").run(floor5h, floorWeek, id);
}

/** The owner's dollar caps on a key account, one per window; null clears one. */
export function setOwnerCaps(db: DatabaseSync, id: string, cap5h: number | null, capWeek: number | null, cap30d: number | null): void {
  if (getAccount(db, id) === undefined) throw new Error(`unknown account ${id}`);
  db.prepare("UPDATE accounts SET cap_5h = ?, cap_week = ?, cap_30d = ? WHERE id = ?").run(cap5h, capWeek, cap30d, id);
}

/** The balance the owner typed, stamped with `now`; null clears the balance and its time. */
export function setOwnerBalance(db: DatabaseSync, id: string, usd: number | null, now: Date): void {
  if (getAccount(db, id) === undefined) throw new Error(`unknown account ${id}`);
  db.prepare("UPDATE accounts SET balance_usd = ?, balance_at = ? WHERE id = ?").run(usd, usd === null ? null : now.toISOString(), id);
}

/** A key's own passes reached one of its caps. squad sees only its own passes, never a provider balance. */
export function capReached(db: DatabaseSync, a: AccountRow, now: Date): boolean {
  if (a.kind !== "key" || (a.cap5h === null && a.capWeek === null && a.cap30d === null)) return false;
  const u = keyUsed(db, a.id, now);
  return (a.cap5h !== null && u.used5h >= a.cap5h) || (a.capWeek !== null && u.usedWeek >= a.capWeek) || (a.cap30d !== null && u.used30d >= a.cap30d);
}

/** The owner's consent. The first stamp stays: a second call changes nothing. */
export function setConsent(db: DatabaseSync, id: string, now: Date): void {
  if (getAccount(db, id) === undefined) throw new Error(`unknown account ${id}`);
  db.prepare("UPDATE accounts SET consent_at = COALESCE(consent_at, ?) WHERE id = ?").run(now.toISOString(), id);
}

/** Starts sharing (`by` = who agreed) or stops it (null), at that moment. */
export function setSharing(db: DatabaseSync, id: string, by: string | null, now: Date): void {
  if (getAccount(db, id) === undefined) throw new Error(`unknown account ${id}`);
  db.prepare("UPDATE accounts SET consent_at = ?, consent_by = ? WHERE id = ?").run(by === null ? null : now.toISOString(), by, id);
}

/**
 * The row stays, so its passes still name it. Its health and session pins go: a name used again must
 * not start cooling, or on another key's pi session. The caller removes the folder and conversations.
 */
export function markRemoved(db: DatabaseSync, id: string): void {
  if (getAccount(db, id) === undefined) throw new Error(`unknown account ${id}`);
  db.prepare("UPDATE accounts SET state = 'removed', dead_code = NULL, dead_at = NULL, consent_at = NULL, consent_by = NULL WHERE id = ?").run(id);
  db.prepare("DELETE FROM health WHERE account = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE account = ?").run(id);
}

/**
 * After a fresh login or a new token or key from the owner: alive again, with no cooling, suspicion or
 * last failure. The old ones were about the old secret.
 */
export function clearAfterLogin(db: DatabaseSync, id: string): void {
  if (getAccount(db, id)?.state === "dead") reviveByLogin(db, id);
  db.prepare("UPDATE health SET cool_until = NULL, cool_kind = NULL, suspect_since = NULL, auth_fails = 0, last_fail_kind = NULL, last_fail_code = NULL WHERE account = ?").run(id);
}

/** A dead account with one of these codes comes back only through a fresh login. */
export const needsLogin = (a: Pick<AccountRow, "state" | "deadCode">): boolean => a.state === "dead" && a.deadCode !== null && PERMANENT_AUTH_CODES.has(a.deadCode);

/**
 * A person's "reset health": clears cooling, suspicion and the last failure, and brings back a dead
 * account whose code was not permanent (such as two 401s in a row). The room read stays.
 */
export function resetHealth(db: DatabaseSync, id: string): "reset" | "log-in-again" {
  const cur = getAccount(db, id);
  if (cur === undefined) throw new Error(`unknown account ${id}`);
  if (needsLogin(cur)) return "log-in-again";
  if (cur.state === "dead") db.prepare("UPDATE accounts SET state = 'active', dead_code = NULL, dead_at = NULL WHERE id = ?").run(id);
  db.prepare("UPDATE health SET cool_until = NULL, cool_kind = NULL, suspect_since = NULL, auth_fails = 0, last_fail_kind = NULL, last_fail_code = NULL WHERE account = ?").run(id);
  return "reset";
}

/** Ends a cool-down and nothing else: the suspicion, the last failure and the room read stay. */
export function endCooling(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE health SET cool_until = NULL, cool_kind = NULL WHERE account = ?").run(id);
}

/** Every account of a runner as `pick` sees it. Busy comes from the caller: it knows the locks. */
export function candidates(db: DatabaseSync, runner: string, now: Date, busy: (id: string) => boolean, env?: Readonly<Record<string, string | undefined>>): Candidate[] {
  const floor = envNum(SQUAD_FLOOR_DEFAULT_ENV, env);
  const caps = !envOn(SQUAD_NO_KEY_CAPS_ENV, env);
  return listAccounts(db, runner).map((a) => {
    const h = getHealth(db, a.id);
    const health = healthOf(a, h, now);
    return {
      account: a.id,
      health,
      coolUntil: orUndef(h.coolUntil),
      left5h: orUndef(h.left5h),
      leftWeek: orUndef(h.leftWeek),
      readAt: orUndef(h.readAt),
      floor5h: a.floor5h ?? floor,
      floorWeek: a.floorWeek ?? floor,
      busy: busy(a.id),
      lastUsedAt: orUndef(h.lastUsedAt),
      sharing: a.consentAt !== null,
      capReached: caps && capReached(db, a, now),
    };
  });
}
