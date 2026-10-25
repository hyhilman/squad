import type { AccountView } from "@squad/contract";
import { capReachedText } from "./keyUse.ts";
import { weekSoon } from "./weekReset.ts";

type Facts = Pick<AccountView, "health" | "left5h" | "leftWeek" | "floor5h" | "floorWeek"> &
  Partial<Pick<AccountView, "kind" | "used5h" | "usedWeek" | "used30d" | "cap5h" | "capWeek" | "cap30d">> & { readonly resetsWeek?: string; readonly sharing?: boolean };

// The pool skips an account that is dead, cooling, or at or under its floor in either window
// (packages/squad/src/pool/pick.ts), or a key whose own passes reached a dollar cap, so those are the ones a person should look at. A disabled or
// moved account was put aside on purpose.
export function attentionOf(a: Facts): string | undefined {
  if (a.health === "dead") return "Login is dead";
  if (a.health === "cooling") return "Cooling down";
  if (a.health === "disabled" || a.health === "moved" || a.health === "removed") return undefined;
  if (a.sharing === false) return "Not shared";
  const cap = capReachedText(a);
  if (cap !== undefined) return cap;
  if (a.left5h !== undefined && a.left5h <= a.floor5h) return "5-hour room at the floor";
  if (a.leftWeek !== undefined && a.leftWeek <= a.floorWeek) return "Week room at the floor";
  return undefined;
}

/**
 * The accounts to look at: those the pool skips, then those whose week resets within 3 days (the room
 * comes back soon; worth knowing, but the pool still uses them, so countHealth does not count them).
 */
export function needsAttention<A extends Facts>(list: readonly A[], now: Date = new Date()): { account: A; reason: string }[] {
  return list.flatMap((account) => {
    const reason = attentionOf(account) ?? (account.health !== "disabled" && account.health !== "moved" && account.health !== "removed" && weekSoon(account.resetsWeek, now) ? "Week resets soon" : undefined);
    return reason === undefined ? [] : [{ account, reason }];
  });
}

export function countHealth(list: readonly Facts[]): { total: number; ok: number; attention: number } {
  let ok = 0;
  let attention = 0;
  for (const a of list) {
    if (attentionOf(a) !== undefined) attention++;
    else if (a.health === "ok") ok++;
  }
  return { total: list.length, ok, attention };
}
