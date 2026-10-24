// The project's squad home: one per project, at `.squad/` in the project's main checkout unless
// SQUAD_HOME says otherwise. A worktree finds its main checkout through git's common dir, so every
// worktree of one project shares one home, and one login has one writer.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SQUAD_DB_ENV, SQUAD_HOME_ENV, envOptional } from "./settings.ts";

export const HOME_DIR_NAME = ".squad";

/** The folders inside a home. Account folders and squad's own state never share a folder. */
export interface HomeLayout {
  readonly root: string;
  readonly accounts: string;
  readonly locks: string;
  readonly staging: string;
  readonly state: string;
  readonly spool: string;
  readonly db: string;
  readonly passLogs: string;
  readonly usageExport: string;
  readonly sessions: string;
}

export function layoutOf(root: string, env: Readonly<Record<string, string | undefined>> = process.env): HomeLayout {
  const state = join(root, "state");
  return {
    root,
    accounts: join(root, "accounts"),
    locks: join(root, "locks"),
    staging: join(root, "staging"),
    state,
    spool: join(state, "spool"),
    db: envOptional(SQUAD_DB_ENV, env) ?? join(state, "squad.db"),
    passLogs: join(root, "logs", "passes"),
    usageExport: join(root, "usage", "pi"),
    sessions: join(root, "sessions"),
  };
}

/**
 * The main checkout of the repo at `cwd`. git's common dir is the main checkout's `.git`, also when
 * `cwd` is a linked worktree. Outside a repo it fails, and the caller must set SQUAD_HOME.
 */
export function mainCheckoutOf(cwd: string): string {
  const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return dirname(out);
}

/** The home root: SQUAD_HOME, or `.squad/` in the main checkout of `cwd`. */
export function homeRoot(cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): string {
  const set = envOptional(SQUAD_HOME_ENV, env);
  if (set !== undefined) return isAbsolute(set) ? set : resolve(cwd, set);
  return join(mainCheckoutOf(cwd), HOME_DIR_NAME);
}

/** Makes every folder of the home, owner-only (0700). Safe to run twice. */
export function ensureHome(layout: HomeLayout): void {
  for (const dir of [layout.root, layout.accounts, layout.locks, layout.staging, layout.state, layout.spool, layout.passLogs, layout.usageExport, layout.sessions]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}
