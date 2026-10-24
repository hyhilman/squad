// Who owns an account, read from its files. Only a codex login holds an identity: the id_token in
// auth.json is a JWT (a signed token) whose claims carry the email.
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

export function identityOf(runner: Runner, kind: AccountKind, dir: string): Identity | null {
  // claude token and pi key hold no identity: the owner comes from --owner.
  // TODO: pi login and claude login. No capture of their files yet, so we do not know where an email would be.
  if (runner !== "codex" || kind !== "login") return null;
  let auth: unknown;
  try {
    auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
  } catch {
    return null;
  }
  const tokens = (auth as { tokens?: { id_token?: unknown } } | null)?.tokens;
  const claims = claimsOf(tokens?.id_token);
  if (claims === null || typeof claims.email !== "string" || claims.email === "") return null;
  return { email: claims.email, emailVerified: claims.email_verified === true };
}
