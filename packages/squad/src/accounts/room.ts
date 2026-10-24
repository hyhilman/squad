// How many passes a runner's pool can start now. It uses `pick`, so it agrees with what `runPass`
// would do. A login runs one pass at a time; a key or token account runs SQUAD_KEY_PARALLEL.
// Only active accounts count in `total`: a dead or disabled one is not capacity.

import type { DatabaseSync } from "node:sqlite";
import { pick, type Skip } from "../pool/pick.ts";
import { envNum, SQUAD_KEY_PARALLEL_ENV } from "../settings.ts";
import { candidates, listAccounts } from "./store.ts";

export interface AccountRoom {
  readonly account: string;
  readonly free: number;
  readonly total: number;
  /** Why the account has no free room; unset when it has. */
  readonly skip?: Skip;
}

export interface PoolRoom {
  readonly free: number;
  readonly total: number;
  readonly accounts: readonly AccountRoom[];
}

export function roomOf(db: DatabaseSync, runner: string, now: Date, busy: (id: string) => boolean, env?: Readonly<Record<string, string | undefined>>): PoolRoom {
  const parallel = envNum(SQUAD_KEY_PARALLEL_ENV, env);
  const picked = pick(candidates(db, runner, now, busy, env), now.getTime());
  const accounts: AccountRoom[] = [];
  for (const a of listAccounts(db, runner)) {
    if (a.state !== "active") continue;
    const total = a.kind === "login" ? 1 : parallel;
    const free = picked.order.includes(a.id) ? total : 0;
    const skip = picked.skipped[a.id];
    accounts.push({ account: a.id, free, total, ...(skip === undefined ? {} : { skip }) });
  }
  return { free: accounts.reduce((n, a) => n + a.free, 0), total: accounts.reduce((n, a) => n + a.total, 0), accounts };
}
