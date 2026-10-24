// Makes a key or token account: the database row, then the folder with its files. The CLI
// (`add-key`, `add-token`) and the web app both call this, so both write the same folder.
//
// Nothing here puts a secret in an error message.

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountKind, Runner } from "../docker.ts";
import type { HomeLayout } from "../home.ts";
import { addAccount, liveAccount, accountId, type AccountRow } from "./store.ts";
import type { DatabaseSync } from "node:sqlite";

/** The account (or its folder) is already there. */
export class AccountExists extends Error {}

export interface NewFileAccount {
  readonly runner: Runner;
  readonly name: string;
  readonly kind: AccountKind;
  readonly ownerEmail?: string;
  /** As NewAccount: unset = `cli`, false = not shared until the owner agrees. */
  readonly consent?: { readonly by: string } | false;
}

export interface AccountFile {
  /** A file name inside the account folder. */
  readonly name: string;
  readonly body: string | Buffer;
}

export const MAX_SECRET = 4096;

/** Why a pasted key or token is refused by shape, or undefined. The text never holds the value. */
export function secretShapeError(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "") return "the secret is empty";
  if (v.length > MAX_SECRET) return `the secret is longer than ${MAX_SECRET} characters`;
  if (/\s/.test(v)) return "the secret holds a space or a line break";
  return undefined;
}

/** Row first (it checks the runner, the name and the kind), then the folder (mode 0700) and its files (mode 0600, tmp + rename). Undoes both on failure. */
export function createFileAccount(db: DatabaseSync, home: HomeLayout, a: NewFileAccount, files: readonly AccountFile[], now: Date): AccountRow {
  const dir = join(home.accounts, a.runner, a.name);
  if (liveAccount(db, accountId(a.runner, a.name)) !== undefined) throw new AccountExists("an account with this name exists");
  const row = addAccount(db, a, now);
  // The row check above also proved the name is safe for a folder name.
  if (existsSync(dir)) {
    db.prepare("DELETE FROM accounts WHERE id = ?").run(row.id);
    throw new AccountExists("an account folder with this name exists");
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    for (const f of files) {
      const tmp = join(dir, `.${f.name}.tmp`);
      writeFileSync(tmp, f.body, { mode: 0o600 });
      renameSync(tmp, join(dir, f.name));
    }
  } catch {
    db.prepare("DELETE FROM accounts WHERE id = ?").run(row.id);
    rmSync(dir, { recursive: true, force: true });
    throw new Error("cannot write the account folder");
  }
  return row;
}
