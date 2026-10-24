// What each account can serve, and a view of the pool for a caller that picks an account itself.
// Nothing here returns a key, a token or a file body: only provider names and model ids.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HomeLayout } from "../home.ts";
import { flockBusy, lockPathOf } from "../run.ts";
import type { Store } from "../store/db.ts";
import type { CatalogProvider } from "../prices.ts";
import { offeredModels, runnerOf } from "../providers.ts";
import { getHealth, healthOf, listAccounts, type AccountRow } from "./store.ts";

export interface ServedProvider {
  readonly provider: string;
  /** Model ids of this provider, as pi's models.json lists them (the pi model name is `<provider>/<id>`). Unset = unknown. */
  readonly models?: readonly string[];
}

/** A provider id becomes a result key, so a file cannot smuggle odd text through it. */
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * pi: the keys of auth.json are the providers it has a login or key for. models.json (shape:
 * `{ providers: { <name>: { models: [{ id }] } } }`, from pi's docs/models.md) adds custom providers
 * and lists their models. Built-in providers have no model list on disk, so their models stay unknown.
 */
function piServes(dir: string): ServedProvider[] {
  const names = new Set<string>();
  const models = new Map<string, string[]>();
  for (const k of Object.keys(readJson(join(dir, "auth.json")) ?? {})) if (PROVIDER.test(k)) names.add(k);
  const providers = readJson(join(dir, "models.json"))?.providers;
  if (isObj(providers)) {
    for (const [name, def] of Object.entries(providers)) {
      if (!PROVIDER.test(name) || !isObj(def)) continue;
      names.add(name);
      if (Array.isArray(def.models)) {
        const ids = def.models.flatMap((m) => (isObj(m) && typeof m.id === "string" ? [m.id] : []));
        if (ids.length > 0) models.set(name, ids);
      }
    }
  }
  return [...names].sort().map((provider) => (models.has(provider) ? { provider, models: models.get(provider)! } : { provider }));
}

export function servesOf(home: HomeLayout, account: AccountRow): ServedProvider[] {
  if (account.runner === "codex") return [{ provider: "openai" }];
  if (account.runner === "claude") return [{ provider: "anthropic" }];
  return piServes(join(home.accounts, account.runner, account.name));
}

export interface AccountInfo {
  /** `<runner>/<name>` */
  readonly account: string;
  readonly runner: string;
  readonly name: string;
  readonly kind: string;
  readonly health: { readonly state: string; readonly coolUntil?: string; readonly code?: string };
  /** A host-side probe. The container's own lock is the real answer. */
  readonly busy: boolean;
  /** Percent left in each window and when it resets; a field is unset when nothing was read. */
  readonly room: { readonly left5h?: number; readonly leftWeek?: number; readonly resets5h?: string; readonly resetsWeek?: string; readonly readAt?: string };
  readonly serves: readonly ServedProvider[];
  /** False: the owner stopped sharing it, and squad refuses every pass on it. */
  readonly sharing: boolean;
}

export interface InfoDeps {
  readonly home: HomeLayout;
  readonly store: Store;
  readonly now?: () => Date;
  readonly busy?: (account: AccountRow) => boolean;
}

export function listAccountsWithServes(deps: InfoDeps, runner?: string): AccountInfo[] {
  const now = (deps.now ?? (() => new Date()))();
  const busyOf = deps.busy ?? ((a: AccountRow): boolean => {
    if (a.kind !== "login") return false;
    const lock = lockPathOf(deps.home, a);
    return existsSync(lock) && flockBusy(lock);
  });
  return listAccounts(deps.store.db, runner).map((a) => {
    const h = getHealth(deps.store.db, a.id);
    const state = healthOf(a, h, now);
    return {
      account: a.id, runner: a.runner, name: a.name, kind: a.kind,
      health: { state, ...(state === "cooling" && h.coolUntil !== null ? { coolUntil: h.coolUntil } : {}), ...(state === "dead" && a.deadCode !== null ? { code: a.deadCode } : {}) },
      busy: busyOf(a),
      room: {
        ...(h.left5h === null ? {} : { left5h: h.left5h }), ...(h.leftWeek === null ? {} : { leftWeek: h.leftWeek }),
        ...(h.resets5h === null ? {} : { resets5h: h.resets5h }), ...(h.resetsWeek === null ? {} : { resetsWeek: h.resetsWeek }),
        ...(h.readAt === null ? {} : { readAt: h.readAt }),
      },
      serves: servesOf(deps.home, a),
      sharing: a.consentAt !== null,
    };
  });
}

/**
 * The model ids a pass on this account may name: pi's own models.json first, else the catalog's
 * models of its providers (`<provider>/<id>`); codex and claude take the catalog of their runner.
 */
export function servedModels(home: HomeLayout, account: AccountRow, catalog: readonly CatalogProvider[]): string[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  if (account.runner !== "pi") return [...new Set(catalog.filter((p) => runnerOf(p.id) === account.runner).flatMap((p) => offeredModels(p).map((m) => m.id)))].sort();
  return servesOf(home, account).flatMap((s) => {
    const ids = s.models ?? (byId.has(s.provider) ? offeredModels(byId.get(s.provider)!).map((m) => m.id) : []);
    return ids.map((id) => `${s.provider}/${id}`);
  });
}
