import type { AccountView } from "@squad/contract";

type Facts = Pick<AccountView, "health" | "left5h" | "leftWeek" | "floor5h" | "floorWeek">;

// The pool skips an account that is dead, cooling, or at or under its floor in either window
// (packages/squad/src/pool/pick.ts), so those are the ones a person should look at. A disabled or
// moved account was put aside on purpose.
export function attentionOf(a: Facts): string | undefined {
  if (a.health === "dead") return "Login is dead";
  if (a.health === "cooling") return "Cooling down";
  if (a.health === "disabled" || a.health === "moved") return undefined;
  if (a.left5h !== undefined && a.left5h <= a.floor5h) return "5-hour room at the floor";
  if (a.leftWeek !== undefined && a.leftWeek <= a.floorWeek) return "Week room at the floor";
  return undefined;
}

export function needsAttention<A extends Facts>(list: readonly A[]): { account: A; reason: string }[] {
  return list.flatMap((account) => {
    const reason = attentionOf(account);
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
