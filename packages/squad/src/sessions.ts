// Sessions: a follow-up pass that continues a transcript. A session is pinned to the account that
// started it, because its transcript may hold that account's provider state. Nothing here moves one.

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HomeLayout } from "./home.ts";

/** Short, lower case, safe as one folder name. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function checkSessionId(id: string): string {
  if (!SESSION_ID_RE.test(id)) throw new Error(`session id ${JSON.stringify(id)} must match ${SESSION_ID_RE}`);
  return id;
}

export interface SessionRow {
  readonly id: string;
  readonly runner: string;
  /** `<runner>/<name>` */
  readonly account: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

/** `<home>/sessions/<runner>/<account name>/<id>`. `account` is the account id, `pi/alice`. */
export const sessionDir = (home: HomeLayout, runner: string, account: string, id: string): string =>
  join(home.sessions, runner, account.slice(account.indexOf("/") + 1), id);

interface Raw { id: string; runner: string; account: string; created_at: string; last_used_at: string }
const rowOf = (r: Raw): SessionRow => ({ id: r.id, runner: r.runner, account: r.account, createdAt: r.created_at, lastUsedAt: r.last_used_at });

export function getSession(db: DatabaseSync, runner: string, id: string): SessionRow | undefined {
  const r = db.prepare("SELECT * FROM sessions WHERE runner = ? AND id = ?").get(runner, id) as Raw | undefined;
  return r === undefined ? undefined : rowOf(r);
}

export function listSessions(db: DatabaseSync): SessionRow[] {
  return (db.prepare("SELECT * FROM sessions ORDER BY runner, id").all() as unknown as Raw[]).map(rowOf);
}

/** Pins a NEW session to its account. Call it only for a session that has no row: a pinned one never moves. */
export function pinSession(db: DatabaseSync, runner: string, id: string, account: string, now: Date): void {
  const t = now.toISOString();
  db.prepare("INSERT INTO sessions (id, runner, account, created_at, last_used_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (runner, id) DO UPDATE SET account = excluded.account, last_used_at = excluded.last_used_at").run(id, runner, account, t, t);
}

export function touchSession(db: DatabaseSync, runner: string, id: string, now: Date): void {
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE runner = ? AND id = ?").run(now.toISOString(), runner, id);
}

export function deleteSession(db: DatabaseSync, runner: string, id: string): void {
  db.prepare("DELETE FROM sessions WHERE runner = ? AND id = ?").run(runner, id);
}
