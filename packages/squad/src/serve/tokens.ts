// Project tokens: one live token per project, made by `squad token add`. The token is 256 random bits,
// shown once. squad keeps only its sha256, which is enough for a random value that long.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAccount, listAccounts } from "../accounts/store.ts";
import { ulid } from "../ids.ts";
import { isSupported } from "../runners/table.ts";
import { isBusy } from "../store/db.ts";
import { unauthorized } from "./scope.ts";

export interface ProjectToken {
  readonly id: string;
  readonly project: string;
  /**
   * As stored: account ids, `<runner>/<name>`, and patterns. `*` is every account of the home and
   * `<runner>/*` every account of that runner, now and added later. `tokenAccounts` expands them.
   */
  readonly accounts: readonly string[];
  /** Real absolute paths. */
  readonly roots: readonly string[];
  /** Images besides squad's own that a pass may name. */
  readonly images: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface TokenScope {
  readonly accounts: readonly string[];
  readonly roots: readonly string[];
  readonly images: readonly string[];
}

const PREFIX = "sqd_";
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/** True for `*` and `<runner>/*`, the two patterns a token may hold. No account name can be one: names start with a letter or digit. */
export const isAccountPattern = (entry: string): boolean => entry === "*" || entry.endsWith("/*");

const matches = (pattern: string, id: string): boolean => pattern === "*" || id.startsWith(pattern.slice(0, -1));

/**
 * The accounts the token may use now. The named ids come first, as stored and unchecked, so a token
 * with no pattern reads exactly as before. Then each pattern adds the accounts that match it; a
 * removed account never matches.
 */
export function tokenAccounts(db: DatabaseSync, token: Pick<ProjectToken, "accounts">): string[] {
  const named = token.accounts.filter((a) => !isAccountPattern(a));
  const patterns = token.accounts.filter(isAccountPattern);
  if (patterns.length === 0) return [...named];
  const live = listAccounts(db).map((a) => a.id).filter((id) => patterns.some((p) => matches(p, id)));
  return [...new Set([...named, ...live])];
}

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

interface Raw {
  id: string; project: string; accounts: string; roots: string; images: string; created_at: string; last_used_at: string | null;
}
const tokenOf = (r: Raw): ProjectToken => ({
  id: r.id, project: r.project, accounts: JSON.parse(r.accounts) as string[], roots: JSON.parse(r.roots) as string[], images: JSON.parse(r.images) as string[], createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

/** Makes the project's token. Returns the token itself once; it is never stored or shown again. */
export function addToken(db: DatabaseSync, project: string, scope: TokenScope, now: Date): { token: string; row: ProjectToken } {
  if (!PROJECT.test(project)) throw new Error("a project name is letters, digits, dot, dash or underscore, at most 64");
  if (scope.accounts.length === 0) throw new Error("a token needs at least one account");
  if (scope.roots.length === 0) throw new Error("a token needs at least one root");
  for (const a of scope.accounts) {
    if (a.includes("*")) {
      if (a !== "*" && !(a.endsWith("/*") && isSupported(a.slice(0, -2)))) throw new Error(`account pattern ${a} must be * or <runner>/*`);
      continue;
    }
    const row = getAccount(db, a);
    if (row === undefined || row.state === "removed") throw new Error(`unknown account ${a}`);
  }
  const roots = scope.roots.map((r) => {
    if (!isAbsolute(r)) throw new Error(`root ${r} must be an absolute path`);
    if (!existsSync(r)) throw new Error(`root ${r} does not exist`);
    return realpathSync(r);
  });
  for (const i of scope.images) if (!IMAGE.test(i)) throw new Error(`image ${JSON.stringify(i)} is not a safe image name`);
  if (db.prepare("SELECT 1 FROM serve_tokens WHERE project = ? AND revoked_at IS NULL").get(project) !== undefined) throw new Error(`${project} already has a live token; revoke it first`);
  const token = PREFIX + randomBytes(32).toString("base64url");
  const id = ulid(now.getTime());
  db.prepare("INSERT INTO serve_tokens (id, project, hash, accounts, roots, images, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, project, hashToken(token), JSON.stringify([...new Set(scope.accounts)]), JSON.stringify([...new Set(roots)]), JSON.stringify([...new Set(scope.images)]), now.toISOString());
  return { token, row: tokenOf(db.prepare("SELECT * FROM serve_tokens WHERE id = ?").get(id) as unknown as Raw) };
}

/** The live tokens, oldest first. Never the token: there is none to show. */
export function listTokens(db: DatabaseSync): ProjectToken[] {
  return (db.prepare("SELECT * FROM serve_tokens WHERE revoked_at IS NULL ORDER BY created_at, id").all() as unknown as Raw[]).map(tokenOf);
}

/** Revokes the project's live token. False when it has none. */
export function revokeToken(db: DatabaseSync, project: string, now: Date): boolean {
  return db.prepare("UPDATE serve_tokens SET revoked_at = ? WHERE project = ? AND revoked_at IS NULL").run(now.toISOString(), project).changes > 0;
}

/** The token of an `Authorization: Bearer <token>` header. Anything wrong is the same 401. */
export function authenticate(db: DatabaseSync, header: string | undefined, now: Date): ProjectToken {
  const m = header === undefined ? null : /^Bearer (sqd_[A-Za-z0-9_-]{43})$/.exec(header);
  if (m === null) throw unauthorized();
  const row = db.prepare("SELECT * FROM serve_tokens WHERE hash = ? AND revoked_at IS NULL").get(hashToken(m[1]!)) as Raw | undefined;
  if (row === undefined) throw unauthorized();
  try {
    db.prepare("UPDATE serve_tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), row.id);
  } catch (e) {
    // The stamp is a hint for `token list`; a busy database must not refuse the call.
    if (!isBusy(e)) throw e;
  }
  return tokenOf({ ...row, last_used_at: now.toISOString() });
}
