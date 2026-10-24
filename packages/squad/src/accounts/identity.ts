// Who owns an account, read from its files. A codex login holds an identity in the id_token in
// auth.json, a JWT (a signed token) whose claims carry the email. A claude login holds it in
// .claude.json. A pi login holds none.
//
// No signature check is needed: the file came from our own login run, and the email is used only to
// compare with --owner and to label the account, never to let anyone in.
// The token itself is never returned or logged.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountKind, Runner } from "../docker.ts";

export interface Identity {
  readonly email: string;
  readonly emailVerified: boolean;
}

/** The claims of a JWT, or null when it is not a JWT with a JSON object in the middle. */
function claimsOf(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function identityOf(runner: Runner, kind: AccountKind, dir: string): Identity | null {
  // claude token and pi key hold no identity: the owner comes from --owner.
  // pi login: its OAuth providers have no capture yet, so we do not know where an email would be.
  if (kind !== "login") return null;
  if (runner === "claude") {
    const account = (readJson(join(dir, ".claude.json")) as { oauthAccount?: unknown } | null)?.oauthAccount;
    const email = isObject(account) ? account.emailAddress : undefined;
    // One "@" only: anything else is not an address we should compare or show.
    return typeof email === "string" && email.split("@").length === 2 ? { email, emailVerified: false } : null;
  }
  if (runner !== "codex") return null;
  const auth = readJson(join(dir, "auth.json"));
  const tokens = (auth as { tokens?: { id_token?: unknown } } | null)?.tokens;
  const claims = claimsOf(tokens?.id_token);
  if (claims === null || typeof claims.email !== "string" || claims.email === "") return null;
  return { email: claims.email, emailVerified: claims.email_verified === true };
}

/**
 * What a finished login left in `dir`. "none": the runner's login file is missing (a CLI that was
 * stopped still exits 0 and leaves log/ and tmp/). "keys" (pi only): every provider entry is a plain
 * API key, which needs no lock. "login": a login that refreshes itself.
 */
export function loginFilesOf(runner: Runner, dir: string): "none" | "login" | "keys" {
  if (runner === "codex") return identityOf("codex", "login", dir) === null ? "none" : "login";
  if (runner === "claude") {
    const creds = readJson(join(dir, ".credentials.json"));
    return isObject(creds) && isObject(creds.claudeAiOauth) ? "login" : "none";
  }
  const auth = readJson(join(dir, "auth.json"));
  if (!isObject(auth)) return "none";
  const entries = Object.values(auth);
  if (entries.length === 0) return "none";
  // Not "keys" for any entry we do not know. An OAuth provider needs a capture before it can be told apart.
  return entries.every((e) => isObject(e) && e.type === "api_key") ? "keys" : "login";
}
