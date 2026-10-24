// Accounts and their health in the database. The state machine has one rule worth a name: a dead
// account is alive again only through `reviveByLogin`, which a person's fresh login calls. Nothing
// else, no retry and no timer, can bring it back.

import type { DatabaseSync } from "node:sqlite";
import type { AccountKind, Runner } from "../docker.ts";
import type { Candidate, Health } from "../pool/pick.ts";
import { envNum, SQUAD_FLOOR_DEFAULT_ENV } from "../settings.ts";
import { emptyHealth, type HealthRow } from "./health.ts";

export type AccountState = "active" | "dead" | "disabled" | "moved";

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
}

export interface NewAccount {
  readonly runner: Runner;
  readonly name: string;
  readonly kind: AccountKind;
  readonly ownerEmail?: string;
}

const RUNNERS: readonly string[] = ["claude", "codex", "pi"];
const KINDS: readonly string[] = ["login", "key", "token"];
/** The name becomes a folder name, so it can hold no slash or dot-dot. */
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const NAME = ACCOUNT_NAME;

export const accountId = (runner: string, name: string): string => `${runner}/${name}`;

interface Raw {
  id: string; runner: string; name: string; kind: string; owner_email: string | null; state: string;
  dead_code: string | null; dead_at: string | null; floor_5h: number | null; floor_week: number | null; created_at: string; consent_at: string | null;
}

const toAccount = (r: Raw): AccountRow => ({
  id: r.id, runner: r.runner as Runner, name: r.name, kind: r.kind as AccountKind, ownerEmail: r.owner_email, state: r.state as AccountState,
  deadCode: r.dead_code, deadAt: r.dead_at, floor5h: r.floor_5h, floorWeek: r.floor_week, createdAt: r.created_at, consentAt: r.consent_at,
});

export function addAccount(db: DatabaseSync, a: NewAccount, now: Date = new Date()): AccountRow {
  if (!RUNNERS.includes(a.runner)) throw new Error(`unknown runner ${JSON.stringify(a.runner)}`);
  if (!KINDS.includes(a.kind)) throw new Error(`unknown account kind ${JSON.stringify(a.kind)}`);
  if (!NAME.test(a.name)) throw new Error(`account name ${JSON.stringify(a.name)} is not safe for a folder name`);
  if (a.kind === "token" && a.runner !== "claude") throw new Error(`a token account is for claude only, not ${a.runner}`);
  if (a.kind === "key" && a.runner === "claude") throw new Error("claude has no key account kind here: use a token or a login");
  const id = accountId(a.runner, a.name);
  db.prepare("INSERT INTO accounts (id, runner, name, kind, owner_email, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, a.runner, a.name, a.kind, a.ownerEmail ?? null, now.toISOString());
  return getAccount(db, id)!;
}

export function getAccount(db: DatabaseSync, id: string): AccountRow | undefined {
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Raw | undefined;
  return r === undefined ? undefined : toAccount(r);
}

export function listAccounts(db: DatabaseSync, runner?: string): AccountRow[] {
  const rows = (runner === undefined ? db.prepare("SELECT * FROM accounts ORDER BY id").all() : db.prepare("SELECT * FROM accounts WHERE runner = ? ORDER BY id").all(runner)) as unknown as Raw[];
  return rows.map(toAccount);
}

/** Any change of state but dead -> active. A dead account gets `dead_code` and `dead_at`. */
export function setState(db: DatabaseSync, id: string, state: AccountState, code?: string, now: Date = new Date()): void {
  const cur = getAccount(db, id);
  if (cur === undefined) throw new Error(`unknown account ${id}`);
  if (cur.state === "dead" && state === "active") throw new Error(`${id} is dead: only reviveByLogin can make it active`);
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

interface RawHealth {
  account: string; cool_until: string | null; cool_kind: string | null; suspect_since: string | null; auth_fails: number;
  last_ok_at: string | null; last_fail_at: string | null; last_fail_kind: string | null; last_fail_code: string | null;
  last_used_at: string | null; left_5h: number | null; left_week: number | null; read_at: string | null;
}

const toHealth = (r: RawHealth): HealthRow => ({
  account: r.account, coolUntil: r.cool_until, coolKind: r.cool_kind, suspectSince: r.suspect_since, authFails: r.auth_fails,
  lastOkAt: r.last_ok_at, lastFailAt: r.last_fail_at, lastFailKind: r.last_fail_kind, lastFailCode: r.last_fail_code,
  lastUsedAt: r.last_used_at, left5h: r.left_5h, leftWeek: r.left_week, readAt: r.read_at,
});

export function getHealth(db: DatabaseSync, account: string): HealthRow {
  const r = db.prepare("SELECT * FROM health WHERE account = ?").get(account) as RawHealth | undefined;
  return r === undefined ? emptyHealth(account) : toHealth(r);
}

export function putHealth(db: DatabaseSync, h: HealthRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO health (account, cool_until, cool_kind, suspect_since, auth_fails, last_ok_at, last_fail_at, last_fail_kind, last_fail_code, last_used_at, left_5h, left_week, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(h.account, h.coolUntil, h.coolKind, h.suspectSince, h.authFails, h.lastOkAt, h.lastFailAt, h.lastFailKind, h.lastFailCode, h.lastUsedAt, h.left5h, h.leftWeek, h.readAt);
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

/** The owner's consent. The first stamp stays: a second call changes nothing. */
export function setConsent(db: DatabaseSync, id: string, now: Date): void {
  if (getAccount(db, id) === undefined) throw new Error(`unknown account ${id}`);
  db.prepare("UPDATE accounts SET consent_at = COALESCE(consent_at, ?) WHERE id = ?").run(now.toISOString(), id);
}

/** Every account of a runner as `pick` sees it. Busy comes from the caller: it knows the locks. */
export function candidates(db: DatabaseSync, runner: string, now: Date, busy: (id: string) => boolean, env?: Readonly<Record<string, string | undefined>>): Candidate[] {
  const floor = envNum(SQUAD_FLOOR_DEFAULT_ENV, env);
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
    };
  });
}
