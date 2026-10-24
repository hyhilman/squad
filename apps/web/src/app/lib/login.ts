import type { AccountView, LoginState, LoginStatus } from "@squad/contract";

/** How often the page asks for the login state. */
export const POLL_MS = 3000;

// Consent and a new login are the owner's own acts; the server refuses them for anyone else, an
// admin included, so the page offers them only to the owner.
export const isOwnerOf = (a: Pick<AccountView, "ownerEmail">, me: { readonly email: string } | undefined): boolean =>
  me !== undefined && a.ownerEmail !== "" && a.ownerEmail.toLowerCase() === me.email.toLowerCase();

export const isFinalLogin = (s: LoginState): boolean => s !== "pending";

const REASONS: Readonly<Record<string, string>> = {
  "owner-mismatch": "The login was for another email than the owner of this account. Nothing was changed.",
  busy: "A pass is using this account right now. Nothing was changed; try again later.",
  "login-failed": "The login did not finish. Nothing was changed.",
  "no-login": "The login stopped with no login saved. Nothing was changed.",
  "seat-mismatch": "The login was for another seat than this account had. Nothing was changed.",
};

export function loginStateText(s: LoginStatus): string {
  switch (s.state) {
    case "pending":
      return "Waiting for you to enter the code…";
    case "done":
      return "Logged in. The account is ready.";
    case "expired":
      return "The code expired. Start again to get a new one.";
    case "failed":
      return s.reason === undefined ? "The login failed." : (REASONS[s.reason] ?? `The login failed (${s.reason}).`);
  }
}
