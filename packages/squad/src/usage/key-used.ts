// What a key account used, in dollars, from squad's own pass records only. squad never asks a provider
// for a balance: it sees its own passes and nothing else.

// The CLI cost comes first: pi prices every message itself, also for models the catalog does not list.
// For a plan such as opencode-go it is an estimate from pi's price table, not money spent. A CLI cost of
// 0 means pi had no price, so the catalog cost stands in; with neither, the pass counts 0.
export const USED_COST_SQL = "COALESCE(NULLIF(cli_cost_usd, 0), catalog_cost_usd, 0)";

/** The same rule as USED_COST_SQL, for one pass. */
export const usedCostOf = (cli: number | null, catalog: number | null): number => (cli !== null && cli !== 0 ? cli : (catalog ?? 0));
