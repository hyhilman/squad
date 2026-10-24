// A key account holds a plain API key, not a refreshing login, so a pass may work on a throwaway
// copy of its folder. The copy dies with the pass. When given, `passId` goes into the copy's name, so
// `squad gc` can tell which pass owns a copy that a crash left behind. A login must never be copied: its refresh token
// has exactly one writer.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HomeLayout } from "../home.ts";
import type { AccountRow } from "./store.ts";

export async function withKeyCopy<T>(home: HomeLayout, account: AccountRow, fn: (copyDir: string) => T | Promise<T>, passId?: string): Promise<T> {
  if (account.kind !== "key") throw new Error(`${account.id} is a ${account.kind} account: only a key account may be copied`);
  mkdirSync(home.staging, { recursive: true, mode: 0o700 });
  const copy = mkdtempSync(join(home.staging, `${account.runner}-${account.name}-${passId === undefined ? "" : `${passId}-`}`));
  try {
    cpSync(join(home.accounts, account.runner, account.name), copy, { recursive: true });
    return await fn(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
