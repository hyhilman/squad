// Which acts the page offers on one account, as the server allows them (packages/squad/src/web/server.ts):
// consent, log in again, a new key and a limit reset are the owner's own; test, reset health, floors,
// disable and remove are also an admin's. A removed or moved account takes none.
import type { AccountModels, AccountView } from "@squad/contract";
import { isOwnerOf } from "./login.ts";

export type ActionKey = "share" | "unshare" | "login" | "key" | "test" | "reset" | "limit" | "floors" | "enable" | "remove";

type Facts = Pick<AccountView, "runner" | "kind" | "health" | "ownerEmail" | "sharing" | "canResetHealth">;

export function accountActions(a: Facts, me: { readonly email: string; readonly admin: boolean } | undefined): ActionKey[] {
  if (me === undefined || a.health === "removed" || a.health === "moved") return [];
  const owner = isOwnerOf(a, me);
  if (!owner && !me.admin) return [];
  const out: ActionKey[] = [];
  if (owner && !a.sharing) out.push("share");
  if (owner && ((a.runner === "codex" && a.kind === "login") || (a.runner === "claude" && a.kind === "token"))) out.push("login");
  if (owner && a.runner === "pi" && a.kind === "key") out.push("key");
  out.push("test");
  if (a.canResetHealth) out.push("reset");
  if (owner && a.runner === "claude") out.push("limit");
  out.push("floors");
  if (owner && a.sharing) out.push("unshare");
  if (a.health !== "dead") out.push("enable");
  out.push("remove");
  return out;
}

/** The header shows the urgent acts and Test as buttons; the rest go in the ⋯ menu. */
export function splitActions(keys: readonly ActionKey[], a: Pick<AccountView, "health" | "sharing">): { primary: ActionKey[]; menu: ActionKey[] } {
  const urgent = (k: ActionKey): boolean => k === "test" || k === "share" || k === "reset" || (k === "login" && a.health === "dead");
  return { primary: keys.filter(urgent), menu: keys.filter((k) => !urgent(k)) };
}

/** A row of the accounts table shows Test, the floors (or caps) and Disable as icon buttons; the rest go in the ⋯ menu. */
export function rowActions(keys: readonly ActionKey[]): { inline: ActionKey[]; menu: ActionKey[] } {
  const inline = (k: ActionKey): boolean => k === "test" || k === "floors" || k === "enable";
  return { inline: keys.filter(inline), menu: keys.filter((k) => !inline(k)) };
}

/** Remove asks the person to type the id; only the exact id counts. */
export const confirmMatches = (typed: string, id: string): boolean => typed.trim() === id;

/** The model the Test dialog starts on. "" = send none: the server uses its default. */
export function pickTestModel(m: AccountModels): string {
  if (m.defaultModel !== undefined && m.models.includes(m.defaultModel)) return m.defaultModel;
  return m.models[0] ?? "";
}
