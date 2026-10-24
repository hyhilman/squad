// The owner's and admin's acts on one account that change its files: remove it, or give it a new
// claude token or pi key. Nothing here puts a secret in an error, a log line or an answer.

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeForAccount } from "../conversations.ts";
import type { HomeLayout } from "../home.ts";
import { withHostLock } from "../lock.ts";
import { lockPathOf } from "../run.ts";
import type { Store } from "../store/db.ts";
import { clearAfterLogin, markRemoved, setSharing, type AccountRow } from "./store.ts";

const dirOf = (home: HomeLayout, a: AccountRow): string => join(home.accounts, a.runner, a.name);

/**
 * Removes the folder and marks the row removed, under the account's host lock (as `squad import`
 * moves a login): a pass in a container holds that lock, so it makes this `busy` at once. A key or
 * token pass takes no lock; it runs on its own copy or mounted file and ends as it would.
 */
export async function removeAccount(store: Store, home: HomeLayout, a: AccountRow, now: Date): Promise<"removed" | "busy"> {
  const done = await withHostLock(lockPathOf(home, a), () => {
    rmSync(dirOf(home, a), { recursive: true, force: true });
    markRemoved(store.db, a.id);
    closeForAccount(store.db, home, a.id, now);
  });
  if (done === "busy") return "busy";
  store.event({ at: now.toISOString(), kind: "removed", account: a.id });
  return "removed";
}

/** Where the person revokes what squad held. Fixed text: squad fetches nothing and links nowhere. */
export function revokeNote(a: Pick<AccountRow, "runner" | "kind">): string {
  if (a.runner === "codex") return "squad no longer holds this login. To end it at OpenAI too, sign out of the device in your ChatGPT settings (Security, log out of devices).";
  if (a.runner === "claude") return "squad no longer holds this token. To end it at Anthropic too, revoke it at claude.ai in Settings, under Claude Code.";
  return "squad no longer holds this key. To end it at the provider too, delete it on the provider's API keys page.";
}

/** tmp + rename in the account folder: a running pass keeps the old file, the next one reads the new. */
function writeAtomic(dir: string, name: string, body: string): void {
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, join(dir, name));
}

/** The owner's new token, from any sign-in way: alive and shared again, health cleared. */
export function replaceToken(store: Store, home: HomeLayout, a: AccountRow, token: string, by: string, now: Date): void {
  if (a.runner !== "claude" || a.kind !== "token") throw new Error("only a claude token account takes a new token");
  writeAtomic(dirOf(home, a), "token", token);
  clearAfterLogin(store.db, a.id);
  setSharing(store.db, a.id, by, now);
  store.event({ at: now.toISOString(), kind: "login", account: a.id, code: "token-replaced" });
}

/**
 * The owner's new pi key. Only that provider's entry of auth.json changes, so the other providers'
 * keys stay. With several providers, the caller must name one.
 */
export function replacePiKey(store: Store, home: HomeLayout, a: AccountRow, provider: string | undefined, key: string, by: string, now: Date): "ok" | "pick-provider" | "unknown-provider" {
  if (a.runner !== "pi" || a.kind !== "key") throw new Error("only a pi key account takes a new key");
  const dir = dirOf(home, a);
  let auth: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    if (typeof v === "object" && v !== null && !Array.isArray(v)) auth = v as Record<string, unknown>;
  } catch {
    // An unreadable file has no provider to keep.
  }
  const names = Object.keys(auth);
  const target = provider ?? (names.length === 1 ? names[0] : undefined);
  if (target === undefined) return "pick-provider";
  if (!names.includes(target)) return "unknown-provider";
  writeAtomic(dir, "auth.json", `${JSON.stringify({ ...auth, [target]: { type: "api_key", key } }, null, 2)}\n`);
  clearAfterLogin(store.db, a.id);
  setSharing(store.db, a.id, by, now);
  store.event({ at: now.toISOString(), kind: "login", account: a.id, code: "key-replaced" });
  return "ok";
}
