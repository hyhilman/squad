// One account as the web app shows it. `squad web` and `squad serve` both build it here, so the two
// never drift apart.
import type { DatabaseSync } from "node:sqlite";
import type { AccountView } from "@squad/contract";
import { getHealth, healthOf, needsLogin, type AccountRow } from "../accounts/store.ts";
import { SQUAD_FLOOR_DEFAULT_ENV, envNum } from "../settings.ts";
import { keyUsed, keyUsedSince } from "../usage/key-used.ts";

export interface ViewContext {
  readonly db: DatabaseSync;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  /** Whether a pass holds the account now. */
  readonly busy: (a: AccountRow) => boolean;
}

export function accountView(ctx: ViewContext, a: AccountRow): AccountView {
  const db = ctx.db;
  const h = getHealth(db, a.id);
  const health = healthOf(a, h, ctx.now);
  const dflt = envNum(SQUAD_FLOOR_DEFAULT_ENV, ctx.env);
  const lastCode = a.deadCode ?? h.lastFailCode;
  return {
    account: a.id, runner: a.runner, name: a.name, kind: a.kind, ownerEmail: a.ownerEmail ?? "", ...(a.loginEmail === null ? {} : { loginEmail: a.loginEmail }), pools: [], health,
    ...(health === "cooling" && h.coolUntil !== null ? { coolUntil: h.coolUntil } : {}),
    ...(lastCode === null ? {} : { lastCode }),
    ...(h.left5h === null ? {} : { left5h: h.left5h }),
    ...(h.leftWeek === null ? {} : { leftWeek: h.leftWeek }),
    ...(h.readAt === null ? {} : { readAt: h.readAt }),
    floor5h: a.floor5h ?? dflt, floorWeek: a.floorWeek ?? dflt, floorSource: a.floor5h !== null || a.floorWeek !== null ? "owner" : "default",
    ...(a.consentAt === null ? {} : { consentAt: a.consentAt }),
    busy: ctx.busy(a),
    sharing: a.consentAt !== null,
    ...(a.consentAt === null || a.consentBy === null ? {} : { consentBy: a.consentBy }),
    ...(h.resets5h === null ? {} : { resets5h: h.resets5h }),
    ...(h.resetsWeek === null ? {} : { resetsWeek: h.resetsWeek }),
    canResetHealth: health === "cooling" || health === "suspect" || (a.state === "dead" && !needsLogin(a)),
    ...(a.kind === "key" ? keyUsed(db, a.id, ctx.now) : {}),
    ...(a.kind === "key" && a.cap5h !== null ? { cap5h: a.cap5h } : {}),
    ...(a.kind === "key" && a.capWeek !== null ? { capWeek: a.capWeek } : {}),
    ...(a.kind === "key" && a.cap30d !== null ? { cap30d: a.cap30d } : {}),
    ...(a.kind === "key" && a.balanceUsd !== null && a.balanceAt !== null
      ? { balanceUsd: a.balanceUsd, balanceAt: a.balanceAt, balanceLeft: a.balanceUsd - keyUsedSince(db, a.id, a.balanceAt) }
      : {}),
  };
}
