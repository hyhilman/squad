// The catalog pages of the web app: squad's saved copy of the catalog (prices.ts), shown per provider
// and per model id.
//
// A model is matched across providers by its exact id. The saved copy keeps no canonical id, so the
// same model under another id at another provider is not matched.
import type { CatalogModelCompare, CatalogModelView, CatalogOffer, CatalogPrice, CatalogPricePoint, CatalogProviderDetail, CatalogProviderView } from "@squad/contract";
import type { DatabaseSync } from "node:sqlite";
import type { CatalogModel, CatalogProvider } from "./prices.ts";
import { runnerOf, type ProviderEntry } from "./providers.ts";

export interface CatalogCtx {
  /** The Add account id of a catalog provider (`codex` for `openai`), or undefined when it is not offered. */
  readonly addAs: (id: string) => string | undefined;
  readonly accounts: (id: string) => number;
}

/** A seat provider (openai, anthropic) is offered and counted under its runner's name, as listProviders does. */
export function catalogCtx(entries: readonly ProviderEntry[], used: ReadonlyMap<string, number>): CatalogCtx {
  const keyOf = (id: string): string => {
    const r = runnerOf(id);
    return r === "pi" ? id : r;
  };
  return {
    addAs: (id) => entries.find((e) => e.id === keyOf(id) && e.runner === runnerOf(id))?.id,
    accounts: (id) => used.get(keyOf(id)) ?? 0,
  };
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isProviderIdParam = (s: string): boolean => PROVIDER_ID.test(s);
/** Real ids hold `@`, `/` and `:`, and the id is only compared, so any visible ASCII is fine. Only dots would be a path step. */
export const isModelIdParam = (s: string): boolean => /^[\x21-\x7e]{1,200}$/.test(s) && !/^\.+$/.test(s);

const shown = (p: CatalogProvider): readonly CatalogModel[] => p.models.filter((m) => m.type !== "embedding");

const priceOf = (m: CatalogModel): CatalogPrice => ({
  input: m.price.input, output: m.price.output,
  ...(m.price.cacheRead === undefined ? {} : { cacheRead: m.price.cacheRead }),
  ...(m.price.cacheWrite === undefined ? {} : { cacheWrite: m.price.cacheWrite }),
});

const byPrice = (a: CatalogPrice, b: CatalogPrice): number => a.input - b.input || a.output - b.output;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: { name: string; id: string }, b: { name: string; id: string }): number =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || byText(a.id, b.id);

function providerView(p: CatalogProvider, ctx: CatalogCtx): CatalogProviderView {
  const models = shown(p);
  const cheapest = models.map(priceOf).sort(byPrice)[0];
  const addAs = ctx.addAs(p.id);
  return {
    id: p.id, name: p.name ?? p.id, runner: runnerOf(p.id), offered: addAs !== undefined, ...(addAs === undefined ? {} : { addAs }),
    models: models.length, accounts: ctx.accounts(p.id), ...(cheapest === undefined ? {} : { cheapest: { input: cheapest.input, output: cheapest.output } }),
  };
}

export function catalogProviderList(catalog: readonly CatalogProvider[], ctx: CatalogCtx): CatalogProviderView[] {
  return catalog.map((p) => providerView(p, ctx)).sort(byName);
}

/** How many providers list each model id (embedding models left out). */
function idCounts(catalog: readonly CatalogProvider[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const p of catalog) for (const m of shown(p)) n.set(m.id, (n.get(m.id) ?? 0) + 1);
  return n;
}

export function catalogProviderDetail(catalog: readonly CatalogProvider[], id: string, ctx: CatalogCtx): CatalogProviderDetail | undefined {
  const p = catalog.find((x) => x.id === id);
  if (p === undefined) return undefined;
  const counts = idCounts(catalog);
  const models = shown(p).map((m): CatalogModelView => ({
    id: m.id, name: m.name ?? m.id, reasoning: m.reasoning ?? false,
    ...(m.context === undefined ? {} : { context: m.context }), ...(m.output === undefined ? {} : { maxOutput: m.output }),
    inputs: m.input ?? [], price: priceOf(m), otherProviders: (counts.get(m.id) ?? 1) - 1,
  }));
  return { provider: providerView(p, ctx), models: models.sort(byName) };
}

export function catalogModelCompare(catalog: readonly CatalogProvider[], modelId: string, ctx: CatalogCtx, history: readonly CatalogPricePoint[]): CatalogModelCompare | undefined {
  const hits = [...catalog].sort((a, b) => byText(a.id, b.id)).flatMap((p) => shown(p).filter((m) => m.id === modelId).map((m) => ({ p, m })));
  if (hits.length === 0) return undefined;
  const best = hits.map((h) => priceOf(h.m)).sort(byPrice)[0]!;
  const offers = hits.map(({ p, m }): CatalogOffer => {
    const addAs = ctx.addAs(p.id);
    const price = priceOf(m);
    return {
      provider: p.id, providerName: p.name ?? p.id, runner: runnerOf(p.id), offered: addAs !== undefined, ...(addAs === undefined ? {} : { addAs }), accounts: ctx.accounts(p.id),
      price, ...(m.context === undefined ? {} : { context: m.context }), ...(m.output === undefined ? {} : { maxOutput: m.output }), cheapest: byPrice(price, best) === 0,
    };
  });
  offers.sort((a, b) => byPrice(a.price!, b.price!) || byText(a.provider, b.provider));
  // Two providers may name one id differently: take the most common name; on a tie, the first by provider id.
  const names = new Map<string, number>();
  for (const h of hits) names.set(h.m.name ?? h.m.id, (names.get(h.m.name ?? h.m.id) ?? 0) + 1);
  let name = hits[0]!.m.name ?? modelId;
  for (const [n, c] of names) if (c > (names.get(name) ?? 0)) name = n;
  return { modelId, name, offers, history };
}

/** The price_history rows of one model id at the given providers, seen at or after `since`, oldest first. */
export function priceHistory(db: DatabaseSync, modelId: string, providers: readonly string[], since: Date): CatalogPricePoint[] {
  if (providers.length === 0) return [];
  const rows = db.prepare(`SELECT provider, seen_at, input, output FROM price_history WHERE model = ? AND seen_at >= ? AND provider IN (${providers.map(() => "?").join(", ")}) ORDER BY seen_at, provider, rowid`)
    .all(modelId, since.toISOString(), ...providers) as unknown as { provider: string; seen_at: string; input: number; output: number }[];
  return rows.map((r) => ({ provider: r.provider, at: r.seen_at, input: r.input, output: r.output }));
}
