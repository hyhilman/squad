// Pure helpers for the catalog pages: price text, search and filter, sorting, the cheapest marks.
// No React and no fetch, so `node --test` runs them.
import type { CatalogModelView, CatalogPricePoint, CatalogProviderView, Runner } from "@squad/contract";

/** Dollars per 1M tokens. A price under a dollar keeps up to four decimals: many cost a fraction of a cent. */
export function perMillionText(usd: number | undefined): string {
  if (usd === undefined) return "-";
  if (usd === 0) return "free";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const t = usd.toFixed(4).replace(/0+$/, "");
  return `$${t.split(".")[1]!.length < 2 ? usd.toFixed(2) : t}`;
}

export function contextText(n: number | undefined): string {
  if (n === undefined) return "-";
  if (n < 1e6) return `${Math.round(n / 1000)}K`;
  return `${Math.round((n / 1e6) * 10) / 10}M`;
}

export type ProviderFilter = "all" | "in-use" | Runner;

export function filterProviders(list: readonly CatalogProviderView[], query: string, filter: ProviderFilter): CatalogProviderView[] {
  const q = query.trim().toLowerCase();
  return list.filter(
    (p) => (q === "" || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) && (filter === "all" || (filter === "in-use" ? p.accounts > 0 : p.runner === filter)),
  );
}

export const runnersOf = (list: readonly CatalogProviderView[]): Runner[] => [...new Set(list.map((p) => p.runner))].sort();

export type ModelSort = "name" | "context" | "input" | "output" | "cacheRead" | "cacheWrite";
export type PriceColumn = "input" | "output" | "cacheRead" | "cacheWrite";

const valueOf = (m: CatalogModelView, key: Exclude<ModelSort, "name">): number | undefined => (key === "context" ? m.context : m.price?.[key]);

/** A sorted copy. A missing value goes last in both directions, so the rows with a price stay on top. */
export function sortModels(models: readonly CatalogModelView[], key: ModelSort, dir: "asc" | "desc"): CatalogModelView[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: CatalogModelView, b: CatalogModelView): number => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...models].sort((a, b) => {
    if (key === "name") return sign * byName(a, b);
    const x = valueOf(a, key);
    const y = valueOf(b, key);
    if (x === undefined || y === undefined) return x === y ? byName(a, b) : x === undefined ? 1 : -1;
    return sign * (x - y) || byName(a, b);
  });
}

/** The ids at the lowest price of a column. None when fewer than two models have a price there, or all are equal: no news then. */
export function cheapestIds(models: readonly CatalogModelView[], col: PriceColumn): Set<string> {
  const priced = models.flatMap((m) => (m.price?.[col] === undefined ? [] : [{ id: m.id, v: m.price[col] }]));
  if (priced.length < 2) return new Set();
  const min = Math.min(...priced.map((p) => p.v));
  if (priced.every((p) => p.v === min)) return new Set();
  return new Set(priced.filter((p) => p.v === min).map((p) => p.id));
}

export const providerPath = (id: string): string => `/catalog/${encodeURIComponent(id)}`;
export const modelPath = (id: string): string => `/catalog/models/${encodeURIComponent(id)}`;

/** The chart's rows: one per time, each provider's input price then, carried forward from its last row. */
export function historyRows(history: readonly CatalogPricePoint[]): { providers: string[]; rows: Record<string, string | number>[] } {
  const providers = [...new Set(history.map((h) => h.provider))].sort();
  const times = [...new Set(history.map((h) => h.at))].sort();
  const last: Record<string, number> = {};
  const rows = times.map((at) => {
    for (const h of history) if (h.at === at) last[h.provider] = h.input;
    return { at, ...last };
  });
  return { providers, rows };
}
