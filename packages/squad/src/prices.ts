// What a pass cost in money, for `key` accounts only. A login or a token account is a seat: it has
// room left (a percent of a window), not a bill.
//
// Prices come from a models.dev style catalog kept at `<home.state>/prices.json`. This file only
// reads it; a later step fetches it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountKind } from "./docker.ts";
import type { HomeLayout } from "./home.ts";
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

/** The saved catalog, or no prices when the file is missing or broken: a bad catalog must not stop a pass. */
export function loadPrices(home: HomeLayout): Prices {
  try {
    return parseCatalog(JSON.parse(readFileSync(join(home.state, PRICES_FILE), "utf8")));
  } catch {
    return new Map();
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
