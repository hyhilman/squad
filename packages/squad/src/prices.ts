// What a pass cost in money, for `key` accounts only. A login or a token account is a seat: it has
// room left (a percent of a window), not a bill.
//
// Prices come from a models.dev style catalog kept at `<home.state>/prices.json`. `refreshPrices`
// fetches it; `loadPrices` reads it. A catalog that cannot be reached keeps the old copy.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AccountKind } from "./docker.ts";
import type { HomeLayout } from "./home.ts";
import { SQUAD_DRY_RUN_ENV, SQUAD_NO_PRICES_ENV, SQUAD_PRICES_URL_ENV, envOn } from "./settings.ts";
import { isObj } from "./streams/lines.ts";
import type { Usage } from "./types.ts";

/** Dollars per million tokens. A cache price left out is the input price. */
export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** Keyed `<provider>/<model>`, the way pi names a model. */
export type Prices = ReadonlyMap<string, Price>;

export const PRICES_FILE = "prices.json";
export const PRICE_SRC = "catalog";

const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Every model of the catalog that has a usable input and output price. Junk gives an empty map, never a throw. */
export function parseCatalog(json: unknown): Prices {
  const out = new Map<string, Price>();
  if (!isObj(json)) return out;
  for (const [provider, entry] of Object.entries(json)) {
    if (!isObj(entry) || !isObj(entry.models)) continue;
    for (const [id, model] of Object.entries(entry.models)) {
      if (!isObj(model) || !isObj(model.cost)) continue;
      const c = model.cost;
      if (!money(c.input) || !money(c.output)) continue;
      out.set(`${provider}/${id}`, {
        input: c.input,
        output: c.output,
        ...(money(c.cache_read) ? { cacheRead: c.cache_read } : {}),
        ...(money(c.cache_write) ? { cacheWrite: c.cache_write } : {}),
      });
    }
  }
  return out;
}

export { SQUAD_NO_PRICES_ENV, SQUAD_PRICES_URL_ENV };

/** How long a copy is fresh. The catalog changes slowly. */
export const PRICES_TTL_MS = 6 * 60 * 60 * 1000;
/** The most the refresh reads. The real catalog is about 5 MB. */
const MAX_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
/** What the saved copy keeps of one model: the price, and what a models.json entry needs. */
export interface CatalogModel {
  readonly id: string;
  /** `canonical_model_id`: one id for the same model across providers, such as `meta/muse-wonder-1.0`. */
  readonly canonical?: string;
  readonly name?: string;
  /** `embedding` models are priced but never offered to pi. */
  readonly type?: string;
  readonly reasoning?: boolean;
  readonly context?: number;
  readonly output?: number;
  /** `modalities.input`, such as `["text", "image"]`. */
  readonly input?: readonly string[];
  readonly price: Price;
}

export interface CatalogProvider {
  readonly id: string;
  readonly name?: string;
  /** The base URL of an OpenAI-compatible API. */
  readonly api?: string;
  readonly npm?: string;
  readonly models: readonly CatalogModel[];
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const str = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= 300;

/** Every provider of the catalog with the models that have a usable price. Junk gives an empty list, never a throw. */
export function parseProviders(json: unknown): CatalogProvider[] {
  const out: CatalogProvider[] = [];
  if (!isObj(json)) return out;
  for (const [id, entry] of Object.entries(json)) {
    if (!isObj(entry) || !isObj(entry.models)) continue;
    const models: CatalogModel[] = [];
    for (const [mid, m] of Object.entries(entry.models)) {
      if (!isObj(m) || !isObj(m.cost) || !money(m.cost.input) || !money(m.cost.output)) continue;
      const c = m.cost as { input: number; output: number; cache_read?: unknown; cache_write?: unknown };
      const limit = isObj(m.limit) ? m.limit : {};
      const input = isObj(m.modalities) && Array.isArray(m.modalities.input) ? m.modalities.input.filter((x): x is string => str(x)) : [];
      models.push({
        id: mid,
        ...(str(m.canonical_model_id) ? { canonical: m.canonical_model_id } : {}),
        ...(str(m.name) ? { name: m.name } : {}),
        ...(str(m.type) ? { type: m.type } : {}),
        ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
        ...(posInt(limit.context) ? { context: limit.context } : {}),
        ...(posInt(limit.output) ? { output: limit.output } : {}),
        ...(input.length > 0 ? { input } : {}),
        price: { input: c.input, output: c.output, ...(money(c.cache_read) ? { cacheRead: c.cache_read } : {}), ...(money(c.cache_write) ? { cacheWrite: c.cache_write } : {}) },
      });
    }
    if (models.length === 0) continue;
    out.push({ id, ...(str(entry.name) ? { name: entry.name } : {}), ...(str(entry.api) ? { api: entry.api } : {}), ...(str(entry.npm) ? { npm: entry.npm } : {}), models });
  }
  return out;
}

/** The trimmed catalog in the models.dev shape, so `parseCatalog` and `parseProviders` read it as they read the raw one. */
function trim(providers: readonly CatalogProvider[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of providers) {
    const models: Record<string, unknown> = {};
    for (const m of p.models) {
      models[m.id] = {
        ...(m.canonical === undefined ? {} : { canonical_model_id: m.canonical }),
        ...(m.name === undefined ? {} : { name: m.name }),
        ...(m.type === undefined ? {} : { type: m.type }),
        ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
        ...(m.context === undefined && m.output === undefined ? {} : { limit: { ...(m.context === undefined ? {} : { context: m.context }), ...(m.output === undefined ? {} : { output: m.output }) } }),
        ...(m.input === undefined ? {} : { modalities: { input: m.input } }),
        cost: {
          input: m.price.input, output: m.price.output,
          ...(m.price.cacheRead === undefined ? {} : { cache_read: m.price.cacheRead }),
          ...(m.price.cacheWrite === undefined ? {} : { cache_write: m.price.cacheWrite }),
        },
      };
    }
    out[p.id] = { ...(p.name === undefined ? {} : { name: p.name }), ...(p.api === undefined ? {} : { api: p.api }), ...(p.npm === undefined ? {} : { npm: p.npm }), models };
  }
  return out;
}

/** Version 1 held prices only; version 2 had no canonical id. Both still load, but a refresh renews them, so the new fields arrive. */
const SAVED_VERSION = 3;
const LOADABLE_VERSIONS: readonly unknown[] = [1, 2, SAVED_VERSION];

/** The saved file, or undefined when it is missing, broken or of another shape. Never throws. */
function readSaved(home: HomeLayout): { readonly v: number; readonly fetchedAt: number; readonly catalog: unknown } | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home.state, PRICES_FILE), "utf8"));
    if (!isObj(raw) || !LOADABLE_VERSIONS.includes(raw.v) || typeof raw.fetchedAt !== "number" || !isObj(raw.catalog)) return undefined;
    return { v: raw.v as number, fetchedAt: raw.fetchedAt, catalog: raw.catalog };
  } catch {
    return undefined;
  }
}

/** The saved catalog, or no prices when the file is missing or broken: a bad catalog must not stop a pass. */
export function loadPrices(home: HomeLayout): Prices {
  return parseCatalog(readSaved(home)?.catalog);
}

/** The saved providers and models (empty when there is no usable copy). */
export function loadProviders(home: HomeLayout): CatalogProvider[] {
  return parseProviders(readSaved(home)?.catalog);
}

export interface RefreshPrices {
  readonly home: HomeLayout;
  /** The catalog address; empty = nothing is fetched. */
  readonly url: string;
  readonly now: number;
  readonly fetch: (url: string, init: RequestInit) => Promise<{ readonly ok: boolean; readonly status: number; readonly text: () => Promise<string> }>;
  /** The settings source; the process env when left out. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type RefreshResult = "off" | "fresh" | "refreshed" | `kept: ${string}`;

/** Renews the saved catalog when it is old. On any failure the old copy stays, so a catalog that is down never stops a pass. */
export async function refreshPrices(r: RefreshPrices): Promise<RefreshResult> {
  const env = r.env ?? process.env;
  if (r.url === "" || envOn(SQUAD_NO_PRICES_ENV, env) || envOn(SQUAD_DRY_RUN_ENV, env)) return "off";
  const saved = readSaved(r.home);
  // A copy stamped in the future means the clock moved back; renew it.
  if (saved !== undefined && saved.v === SAVED_VERSION && r.now >= saved.fetchedAt && r.now - saved.fetchedAt < PRICES_TTL_MS) return "fresh";
  try {
    const res = await r.fetch(r.url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return `kept: the catalog answered ${res.status}`;
    const text = await res.text();
    if (text.length > MAX_BYTES) return "kept: the catalog is too big";
    const json: unknown = JSON.parse(text);
    const prices = parseCatalog(json);
    // A catalog with no usable model is the wrong file; it must not replace a good copy.
    if (prices.size === 0) return "kept: the catalog has no model with a price";
    // Keep only what the app reads, so the file stays small.
    const catalog = trim(parseProviders(json));
    mkdirSync(r.home.state, { recursive: true });
    const file = join(r.home.state, PRICES_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: SAVED_VERSION, fetchedAt: r.now, catalog }));
    renameSync(tmp, file);
    return "refreshed";
  } catch (e) {
    return `kept: ${e instanceof Error ? (e.message.split("\n")[0] ?? "error") : "error"}`;
  }
}

/** What the tokens cost at `p`, in dollars. Reasoning tokens are inside `output` already, so they add nothing. */
export function costOf(t: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">, p: Price): number {
  return (t.input * p.input + t.output * p.output + t.cacheRead * (p.cacheRead ?? p.input) + t.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
}

/** The cost of a pass, or null when it has no money cost (a seat) or the model has no price. */
export function passCost(kind: AccountKind, providerModel: string, usage: Usage, prices: Prices): { readonly costUsd: number; readonly priceSrc: string } | null {
  if (kind !== "key") return null;
  const p = prices.get(providerModel);
  return p === undefined ? null : { costUsd: costOf(usage, p), priceSrc: PRICE_SRC };
}

// ---- the price a pass was charged at ----

/** The catalog key of a model for a runner: pi names its model `<provider>/<id>` already. */
export function catalogKey(runner: string, model: string): string | undefined {
  if (runner === "pi") return model.includes("/") ? model : undefined;
  if (runner === "codex") return `openai/${model}`;
  if (runner === "claude") return `anthropic/${model}`;
  return undefined;
}

interface HistoryRaw { input: number; output: number; cache_read: number | null; cache_write: number | null }

/** Appends a row for each model whose price is new or differs from its latest row. One transaction. Returns the rows written. */
export function recordPriceHistory(db: DatabaseSync, prices: Prices, now: Date): number {
  const latest = new Map<string, HistoryRaw>();
  const rows = db.prepare("SELECT p.provider, p.model, p.input, p.output, p.cache_read, p.cache_write FROM price_history p JOIN (SELECT MAX(rowid) AS r FROM price_history GROUP BY provider, model) m ON p.rowid = m.r").all() as unknown as (HistoryRaw & { provider: string; model: string })[];
  for (const r of rows) latest.set(`${r.provider}/${r.model}`, r);
  const insert = db.prepare("INSERT INTO price_history (provider, model, input, output, cache_read, cache_write, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let written = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [key, p] of prices) {
      const old = latest.get(key);
      if (old !== undefined && old.input === p.input && old.output === p.output && old.cache_read === (p.cacheRead ?? null) && old.cache_write === (p.cacheWrite ?? null)) continue;
      const i = key.indexOf("/");
      insert.run(key.slice(0, i), key.slice(i + 1), p.input, p.output, p.cacheRead ?? null, p.cacheWrite ?? null, now.toISOString());
      written++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return written;
}

/** The price in force at `at`: the last row seen at or before it. undefined when the history has none. */
export function priceAt(db: DatabaseSync, key: string, at: Date): Price | undefined {
  const i = key.indexOf("/");
  const r = db.prepare("SELECT input, output, cache_read, cache_write FROM price_history WHERE provider = ? AND model = ? AND seen_at <= ? ORDER BY seen_at DESC, rowid DESC LIMIT 1").get(key.slice(0, i), key.slice(i + 1), at.toISOString()) as HistoryRaw | undefined;
  return r === undefined ? undefined : { input: r.input, output: r.output, ...(r.cache_read === null ? {} : { cacheRead: r.cache_read }), ...(r.cache_write === null ? {} : { cacheWrite: r.cache_write }) };
}

/** Tokens times the catalog price at `at`, for any kind of account; the saved copy stands in when the history has no row. null = no price. */
export function catalogCost(db: DatabaseSync, prices: Prices, runner: string, model: string, usage: Usage, at: Date): number | null {
  const key = catalogKey(runner, model);
  if (key === undefined) return null;
  const p = priceAt(db, key, at) ?? prices.get(key);
  return p === undefined ? null : costOf(usage, p);
}

/**
 * Prices the finished passes that have no catalog cost yet, such as those from before the cost was
 * stored. A pass from before the price history uses the saved copy. Returns how many it priced.
 */
export function backfillCatalogCosts(db: DatabaseSync, prices: Prices, limit = 5000): number {
  const rows = db.prepare(
    "SELECT id, started_at, runner, model, input, output, cache_read, cache_write, reasoning FROM passes WHERE catalog_cost_usd IS NULL AND ended_at IS NOT NULL AND (input + output + cache_read + cache_write) > 0 ORDER BY started_at LIMIT ?",
  ).all(limit) as unknown as { id: string; started_at: string; runner: string; model: string; input: number; output: number; cache_read: number; cache_write: number; reasoning: number }[];
  const set = db.prepare("UPDATE passes SET catalog_cost_usd = ? WHERE id = ? AND catalog_cost_usd IS NULL");
  let n = 0;
  for (const r of rows) {
    const usage = { input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, reasoning: r.reasoning };
    const c = catalogCost(db, prices, r.runner, r.model, usage, new Date(r.started_at));
    if (c !== null) n += Number(set.run(c, r.id).changes);
  }
  return n;
}
