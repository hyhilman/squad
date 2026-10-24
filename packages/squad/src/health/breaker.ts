// The circuit breaker of a pool: when no account in it can ever start a pass soon, say so at once.
// This is pure. It looks at the health words only; a busy account will free, a suspect one waits for
// a probe, so both keep the breaker closed.

import type { Candidate } from "../pool/pick.ts";

export type ScopeState = "open" | "closed";

const OUT: ReadonlySet<string> = new Set(["cooling", "dead", "disabled", "moved", "removed"]);

/** `open` when the pool has accounts and every one is cooling, dead, disabled or moved. An empty pool is `closed`. */
export function scopeState(candidates: readonly Candidate[]): ScopeState {
  return candidates.length > 0 && candidates.every((c) => OUT.has(c.health)) ? "open" : "closed";
}
