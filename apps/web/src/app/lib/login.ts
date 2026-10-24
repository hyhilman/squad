import type { LoginState, LoginStatus } from "@squad/contract";

/** How often the page asks for the login state. */
export const POLL_MS = 3000;

export const isFinalLogin = (s: LoginState): boolean => s !== "pending";

const REASONS: Readonly<Record<string, string>> = {
  "owner-mismatch": "The login was for another email than the owner of this account. Nothing was changed.",
  busy: "A pass is using this account right now. Nothing was changed; try again later.",
  "login-failed": "The login did not finish. Nothing was changed.",
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
