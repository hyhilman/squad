// Which provider account an account is (the "account user"), next to who owns it in squad. They can
// differ: a person's work owner email with a personal Claude seat.
import type { AccountView } from "@squad/contract";

export const UNKNOWN_USER_HINT = "squad could not read which provider account this is";

export interface AccountUser {
  readonly user: string | undefined;
  readonly owner: string;
  /** `<account user> / <owner>`, with `unknown` and `-` for what is missing. */
  readonly text: string;
  readonly hint?: string;
  /**
   * A new sign-in can fill an unknown account user: codex reads it from its ID token, and claude's
   * setup-token leaves it in its config. A pi key says nothing about whose it is.
   */
  readonly fillable: boolean;
}

export function accountUser(a: Pick<AccountView, "runner" | "kind" | "ownerEmail"> & { readonly loginEmail?: string | undefined }): AccountUser {
  const owner = a.ownerEmail === "" ? "-" : a.ownerEmail;
  const fillable = (a.runner === "codex" && a.kind === "login") || (a.runner === "claude" && a.kind === "token");
  const user = a.loginEmail;
  return { user, owner, text: `${user ?? "unknown"} / ${owner}`, ...(user === undefined ? { hint: UNKNOWN_USER_HINT } : {}), fillable };
}
