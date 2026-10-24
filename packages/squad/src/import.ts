// `squad import`: bring accounts from another home, or send one there (`--back`).
//
// A key or token account is copied hot: the source stays. A login has exactly one writer, so it is
// MOVED: we take the source's account lock without waiting (a busy account is refused), copy the
// folder into the target's staging, fsync it, rename it into `accounts/`, and only then empty the
// source. The source keeps a `MOVED-TO` file and a `moved` row, so its pool never picks it again.
// This is the only code that copies a login.

import { closeSync, cpSync, chmodSync, existsSync, readFileSync, statSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AccountExists, createFileAccount } from "./accounts/add.ts";
import { ACCOUNT_NAME, addAccount, getAccount, listAccounts, setOwnerEmail, setState, type AccountRow } from "./accounts/store.ts";
import type { HomeLayout } from "./home.ts";
import { ulid } from "./ids.ts";
import { withHostLock } from "./lock.ts";
import type { Out } from "./login.ts";
import type { Store } from "./store/db.ts";

export const MOVED_TO = "MOVED-TO";

export interface Side {
  readonly home: HomeLayout;
  readonly store: Store;
}

/** Flushes a whole folder to disk, so the rename that follows never shows half a login. */
function fsyncTree(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) fsyncTree(p);
    else if (e.isFile()) {
      const fd = openSync(p, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const accountDir = (h: HomeLayout, a: { runner: string; name: string }): string => join(h.accounts, a.runner, a.name);

/** Why this account cannot move, or undefined when it can. */
function refusal(src: AccountRow | undefined, from: Side, to: Side): string | undefined {
  if (src === undefined) return "not in the source home";
  if (src.state !== "active") return `is ${src.state}${src.state === "dead" ? ": log in again" : ""}`;
  if (!existsSync(accountDir(from.home, src))) return "has no folder in the source home";
  const there = getAccount(to.store.db, src.id);
  const folder = accountDir(to.home, src);
  // A `moved` row is a login that left this home once. It may come home: its folder holds only MOVED-TO.
  if (there !== undefined) {
    if (there.state !== "moved" || there.kind !== src.kind) return "already exists in the target home";
  } else if (existsSync(folder)) return "already has a folder in the target home";
  return undefined;
}

/** Copies the folder to the target, registers it there. Leaves the source alone. Undoes itself on failure. */
function place(src: AccountRow, from: Side, to: Side, now: Date): void {
  const staging = join(to.home.staging, ulid(now.getTime()));
  const dest = accountDir(to.home, src);
  mkdirSync(to.home.staging, { recursive: true, mode: 0o700 });
  let renamed = false;
  try {
    cpSync(accountDir(from.home, src), staging, { recursive: true });
    chmodSync(staging, 0o700);
    fsyncTree(staging);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
    renamed = true;
    if (getAccount(to.store.db, src.id) === undefined) addAccount(to.store.db, { runner: src.runner, name: src.name, kind: src.kind, ...(src.ownerEmail === null ? {} : { ownerEmail: src.ownerEmail }) }, now);
    else {
      setState(to.store.db, src.id, "active");
      setOwnerEmail(to.store.db, src.id, src.ownerEmail);
    }
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    if (renamed) rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/** Empties the source folder and leaves a MOVED-TO note. The row is already `moved`, so a failure here leaves no second writer. */
function leaveNote(src: AccountRow, from: Side, to: Side, now: Date): void {
  const dir = accountDir(from.home, src);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, MOVED_TO), `${to.home.root}\n`, { mode: 0o600 });
  from.store.event({ at: now.toISOString(), kind: "moved", account: src.id, detail: "import" });
}

export interface ImportParams {
  readonly from: Side;
  readonly to: Side;
  /** Account ids. Empty = every active account of the source home. */
  readonly names: readonly string[];
  readonly dryRun: boolean;
  readonly now: Date;
  readonly out: Out;
}

/** Exit code: 0 when every account was done, 1 when any was refused. */
export async function runImport(p: ImportParams): Promise<number> {
  const { from, to, out } = p;
  const all = p.names.length === 0;
  const ids = all ? listAccounts(from.store.db).map((a) => a.id) : p.names;
  let failed = 0;
  for (const id of ids) {
    const src = getAccount(from.store.db, id);
    if (all && src !== undefined && src.state !== "active") {
      out.stdout(`skipped ${id}: ${src.state}\n`);
      continue;
    }
    const why = refusal(src, from, to);
    if (why !== undefined || src === undefined) {
      out.stderr(`${id}: refused: ${why}\n`);
      failed++;
      continue;
    }
    if (p.dryRun) {
      out.stdout(`would ${src.kind === "login" ? "move" : "copy"} ${id}\n`);
      continue;
    }
    try {
      if (src.kind !== "login") {
        place(src, from, to, p.now);
        to.store.event({ at: p.now.toISOString(), kind: "import", account: id, detail: "copy" });
        out.stdout(`copied ${id}\n`);
        continue;
      }
      const locked = await withHostLock(join(from.home.locks, src.runner, `${src.name}.lock`), () => {
        // Under the source lock no pass runs on it, and none can start while we copy.
        // Mark the source first: from here the source pool skips it. If the copy fails, the mark is undone.
        setState(from.store.db, src.id, "moved");
        try {
          place(src, from, to, p.now);
        } catch (e) {
          setState(from.store.db, src.id, "active");
          throw e;
        }
        leaveNote(src, from, to, p.now);
      });
      if (locked === "busy") {
        out.stderr(`${id}: refused: account busy (a pass holds it)\n`);
        failed++;
        continue;
      }
      to.store.event({ at: p.now.toISOString(), kind: "import", account: id, detail: "move" });
      out.stdout(`moved ${id}\n`);
    } catch (e) {
      out.stderr(`${id}: failed: ${e instanceof Error ? e.message.split("\n")[0] : "error"}\n`);
      failed++;
    }
  }
  return failed === 0 ? 0 : 1;
}


export interface DoppelgangerImport {
  /** The folder that holds `pi/<name>/auth.json` and `models.json`: doppelganger's `.doppelganger/creds`. */
  readonly creds: string;
  readonly to: Side;
  /** `<name>` or `pi/<name>`. Empty = every pi folder. */
  readonly names: readonly string[];
  /** The owner of the new accounts; unset = none, and `squad owner` sets it later. */
  readonly ownerEmail?: string;
  readonly dryRun: boolean;
  readonly now: Date;
  readonly out: Out;
}

/** Whether auth.json holds only API keys. A pi OAuth entry is a refreshing login, which has one writer and is never copied. Never throws, never prints the file. */
function onlyApiKeys(file: string): boolean {
  try {
    const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
    const entries = Object.values(doc);
    return entries.length > 0 && entries.every((e) => typeof e === "object" && e !== null && (e as { type?: unknown }).type === "api_key" && typeof (e as { key?: unknown }).key === "string");
  } catch {
    return false;
  }
}

/** Copies doppelganger's pi key accounts (auth.json and models.json only) into this home as key accounts. The source is never changed. Exit code: 0 when all were done, 1 when any was refused. */
export function runImportDoppelganger(p: DoppelgangerImport): number {
  const piDir = join(p.creds, "pi");
  const all = p.names.length === 0;
  const names = (all ? readdirSync(piDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : p.names.map((n) => n.replace(/^pi\//, ""))).sort();
  let failed = 0;
  for (const name of names) {
    const id = `pi/${name}`;
    const dir = join(piDir, name);
    const auth = join(dir, "auth.json");
    if (!ACCOUNT_NAME.test(name) || !existsSync(dir) || !statSync(dir).isDirectory()) {
      p.out.stderr(`${id}: refused: not in the source\n`);
      failed++;
    } else if (!existsSync(auth)) {
      if (all) p.out.stdout(`skipped ${id}: no auth.json\n`);
      else {
        p.out.stderr(`${id}: refused: no auth.json\n`);
        failed++;
      }
    } else if (!onlyApiKeys(auth)) {
      p.out.stderr(`${id}: refused: it holds a login, not an API key: use squad login\n`);
      failed++;
    } else if (p.dryRun) {
      p.out.stdout(`would copy ${id}\n`);
    } else {
      try {
        const files = [{ name: "auth.json", body: readFileSync(auth) }, ...(existsSync(join(dir, "models.json")) ? [{ name: "models.json", body: readFileSync(join(dir, "models.json")) }] : [])];
        createFileAccount(p.to.store.db, p.to.home, { runner: "pi", name, kind: "key", ...(p.ownerEmail === undefined ? {} : { ownerEmail: p.ownerEmail }) }, files, p.now);
        p.to.store.event({ at: p.now.toISOString(), kind: "import", account: id, detail: "copy" });
        p.out.stdout(`copied ${id}\n`);
      } catch (e) {
        p.out.stderr(`${id}: ${e instanceof AccountExists ? "refused: already exists in the target home" : "failed"}\n`);
        failed++;
      }
    }
  }
  return failed === 0 ? 0 : 1;
}
