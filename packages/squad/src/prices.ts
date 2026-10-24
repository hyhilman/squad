// What a pass cost in money, for `key` accounts only. A login or a token account is a seat: it has
// room left (a percent of a window), not a bill.
//
// Prices come from a models.dev style catalog kept at `<home.state>/prices.json`. `refreshPrices`
// fetches it; `loadPrices` reads it. A catalog that cannot be reached keeps the old copy.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
/** A file of another version is read as no copy, so the next refresh renews it. */
const SAVED_VERSION = 1;

type Catalog = Record<string, { models: Record<string, { cost: Record<string, number> }> }>;

/** The saved file, or undefined when it is missing, broken or of another shape. Never throws. */
function readSaved(home: HomeLayout): { readonly fetchedAt: number; readonly catalog: unknown } | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home.state, PRICES_FILE), "utf8"));
    if (!isObj(raw) || raw.v !== SAVED_VERSION || typeof raw.fetchedAt !== "number" || !isObj(raw.catalog)) return undefined;
    return { fetchedAt: raw.fetchedAt, catalog: raw.catalog };
  } catch {
    return undefined;
  }
}

/** The saved catalog, or no prices when the file is missing or broken: a bad catalog must not stop a pass. */
export function loadPrices(home: HomeLayout): Prices {
  return parseCatalog(readSaved(home)?.catalog);
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
  if (saved !== undefined && r.now >= saved.fetchedAt && r.now - saved.fetchedAt < PRICES_TTL_MS) return "fresh";
  try {
    const res = await r.fetch(r.url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return `kept: the catalog answered ${res.status}`;
    const text = await res.text();
    if (text.length > MAX_BYTES) return "kept: the catalog is too big";
    const prices = parseCatalog(JSON.parse(text));
    // A catalog with no usable model is the wrong file; it must not replace a good copy.
    if (prices.size === 0) return "kept: the catalog has no model with a price";
    // Keep only what parseCatalog reads, so the file stays small.
    const catalog: Catalog = {};
    for (const [key, p] of prices) {
      const i = key.indexOf("/");
      const provider = key.slice(0, i);
      const cost: Record<string, number> = { input: p.input, output: p.output };
      if (p.cacheRead !== undefined) cost.cache_read = p.cacheRead;
      if (p.cacheWrite !== undefined) cost.cache_write = p.cacheWrite;
      (catalog[provider] ??= { models: {} }).models[key.slice(i + 1)] = { cost };
    }
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
