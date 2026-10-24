import type { ConnectStatus, LoginState, Runner } from "@squad/contract";

export type ClaudeWay = "signin" | "computer" | "token";

/** The ways to add a claude account. The server sign-in comes first: it needs nothing on the person's computer. */
export const CLAUDE_WAYS: readonly { readonly value: ClaudeWay; readonly title: string; readonly description: string }[] = [
  { value: "signin", title: "Sign in with Claude", description: "The server makes the token. You open a link and paste back a code." },
  { value: "computer", title: "Use my computer (no typing)", description: "Run one command on your computer. Claude Code opens your browser and squad gets the token." },
  { value: "token", title: "I already have a token", description: "Paste the output of claude setup-token." },
];

export const wayNeedsSecret = (w: ClaudeWay): boolean => w === "token";

export function submitTextFor(runner: Runner | undefined, way: ClaudeWay): string {
  if (runner === "codex" || (runner === "claude" && way === "signin")) return "Start login";
  if (runner === "claude" && way === "computer") return "Get the command";
  return "Add account";
}

export const isFinalConnect = (s: LoginState): boolean => s !== "pending";

const REASONS: Readonly<Record<string, string>> = {
  exists: "An account with this name was added already. Nothing was changed.",
  "bad-token": "What your computer sent did not look like a Claude token. Nothing was saved.",
  internal: "The server could not save the account. Try again.",
};

export function connectStateText(s: ConnectStatus): string {
  switch (s.state) {
    case "pending":
      return "Waiting for your computer…";
    case "done":
      return `Signed in. ${s.account ?? "The account"} is ready.`;
    case "expired":
      return "The command expired. Start again to get a new one.";
    case "failed":
      return s.reason === undefined ? "The sign-in failed." : (REASONS[s.reason] ?? `The sign-in failed (${s.reason}).`);
  }
}
