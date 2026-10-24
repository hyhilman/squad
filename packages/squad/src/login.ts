// `squad login` and the argv of a person's terminal session (`login`, `shell`).
//
// A login runs the real CLI login in a container whose account mount is a fresh staging folder. No
// lock is mounted: nothing else can see staging. Only when the login worked does the folder move into
// `accounts/`, under the account lock, in one rename. So a failed or wrong-owner login never
// touches the account that is there.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { identityOf, loginFilesOf } from "./accounts/identity.ts";
import { addAccount, getAccount, reviveByLogin, setLoginEmail, setOwnerEmail, ACCOUNT_NAME } from "./accounts/store.ts";
import { dockerRunArgv, type AccountKind, type PassPlan, type Runner } from "./docker.ts";
import type { HomeLayout } from "./home.ts";
import { IMAGES } from "./images.ts";
import { ulid } from "./ids.ts";
import { withHostLock } from "./lock.ts";
import type { Store } from "./store/db.ts";

export interface TerminalOpts {
  /** A throwaway folder for the container's cwd. The real cwd may hold the home, which a mount must not touch. */
  readonly cwd: string;
  readonly passId: string;
  readonly project: string;
  readonly user: { readonly uid: number; readonly gid: number } | null;
  readonly home: string;
  readonly image?: string;
  readonly identity?: { readonly name: string; readonly email: string };
  /** A person at a terminal. Default true. The web login has none: it reads the CLI's output. */
  readonly tty?: boolean;
  /** The CLI args in place of the runner's login args (the claude setup-token). */
  readonly args?: readonly string[];
  /** Extra container env, such as the terminal size. */
  readonly env?: Readonly<Record<string, string>>;
}

function terminalPlan(runner: Runner, account: PassPlan["account"], lockFile: string | null, args: readonly string[], o: TerminalOpts, action: string, entrypoint?: string): PassPlan {
  return {
    runner,
    image: o.image ?? IMAGES[runner].tag,
    name: `squad-${action}-${o.passId.toLowerCase()}`,
    passId: o.passId,
    purpose: action === "login" ? "login" : "shell",
    caller: { project: o.project, flow: "cli" },
    user: o.user,
    cwd: o.cwd,
    gitDir: join(o.cwd, ".git"),
    mounts: [],
    overlays: [],
    session: null,
    account,
    lockFile,
    identity: o.identity ?? { name: "squad", email: "squad@localhost" },
    ghDir: null,
    home: o.home,
    env: o.env ?? {},
    args,
    tty: o.tty ?? true,
    ...(entrypoint === undefined ? {} : { entrypoint }),
  };
}

/** The CLI args that start a login, after the image's entrypoint. */
function loginArgs(runner: Runner): string[] {
  if (runner === "codex") return ["login", "--device-auth"];
  return []; // pi and claude: the person types /login, then /exit
}

/** The `docker run` argv of a login into `staging`. There is no lock: nothing else can see staging. */
export function loginArgv(runner: Runner, o: TerminalOpts & { readonly staging: string; readonly name?: string }): string[] {
  const args = o.args ?? loginArgs(runner);
  // Kind "key" only means "mount the folder, take no lock"; the row is made after the login.
  return dockerRunArgv(terminalPlan(runner, { name: o.name ?? "login", kind: "key", dir: o.staging }, null, args, o, "login"));
}

/** The argv of a bash session on one account, behind the same lock, key copy or token file a pass uses. */
export function shellArgv(account: { readonly runner: Runner; readonly name: string; readonly kind: AccountKind }, o: TerminalOpts & { readonly dir: string; readonly lockFile: string | null }): string[] {
  return dockerRunArgv(terminalPlan(account.runner, { name: account.name, kind: account.kind, dir: o.dir }, o.lockFile, ["bash"], o, "shell", "squad-entry"));
}

export interface FinishParams {
  readonly store: Store;
  readonly home: HomeLayout;
  readonly runner: Runner;
  readonly name: string;
  readonly staging: string;
  /** The email the login must belong to (`squad login --owner`). Without it, whoever logged in owns the account. */
  readonly owner?: string;
  /**
   * A NEW account added from the web: this person owns it, whatever seat they logged in with, and the
   * seat's own email is stored apart. The login must still hold an identity.
   */
  readonly addFor?: string;
  readonly now: Date;
}

export type FinishResult =
  | { readonly ok: true; readonly ownerEmail: string | null }
  | { readonly ok: false; readonly reason: "empty" | "no-login" | "owner-mismatch" | "seat-mismatch" | "exists" | "busy"; readonly found?: string };

/**
 * The part of a login after the container: check what it left in `staging`, move it into `accounts/`
 * under the account lock, and register or revive the account. On any refusal `staging` is removed and
 * nothing else changes. `squad login` and the web login both end here.
 */
export async function finishLogin(p: FinishParams): Promise<FinishResult> {
  const { store, home, runner, name, staging } = p;
  const id = `${runner}/${name}`;
  const drop = (): void => rmSync(staging, { recursive: true, force: true });
  if (readdirSync(staging).length === 0) {
    drop();
    return { ok: false, reason: "empty" };
  }

  // A CLI that is stopped (a docker restart) exits 0 with only log/ and tmp/. That is no login.
  const files = loginFilesOf(runner, staging);
  if (files === "none") {
    drop();
    return { ok: false, reason: "no-login" };
  }

  const found = identityOf(runner, "login", staging);
  const before = getAccount(store.db, id);
  if (p.addFor !== undefined && before !== undefined) {
    drop();
    return { ok: false, reason: "exists" };
  }
  const seat = before?.loginEmail ?? null;
  if (p.addFor !== undefined && found === null) {
    drop();
    return { ok: false, reason: "no-login" };
  }
  if (seat !== null) {
    // A re-login is for the same seat. A person may hold several seats, so the owner is not the test.
    if (found === null) {
      drop();
      return { ok: false, reason: "no-login" };
    }
    if (found.email.toLowerCase() !== seat.toLowerCase()) {
      drop();
      return { ok: false, reason: "seat-mismatch", found: found.email };
    }
  } else if (p.owner !== undefined && found !== null && found.email.toLowerCase() !== p.owner.toLowerCase()) {
    drop();
    return { ok: false, reason: "owner-mismatch", found: found.email };
  }
  const ownerEmail = p.addFor ?? (seat !== null ? before!.ownerEmail : (found?.email ?? p.owner ?? null));

  const dest = join(home.accounts, runner, name);
  const stamp = p.now.toISOString().replace(/\D/g, "");
  const aside: { old: string | null } = { old: null };
  const locked = await withHostLock(join(home.locks, runner, `${name}.lock`), () => {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const oldPath = join(dirname(dest), `.${name}.old-${stamp}`);
    const had = existsSync(dest);
    if (had) renameSync(dest, oldPath);
    try {
      renameSync(staging, dest);
    } catch (e) {
      if (had) renameSync(oldPath, dest);
      throw e;
    }
    aside.old = had ? oldPath : null;
  });
  if (locked === "busy") {
    drop();
    return { ok: false, reason: "busy" };
  }
  if (aside.old !== null) rmSync(aside.old, { recursive: true, force: true });

  const existing = getAccount(store.db, id);
  // A pi login that holds only API keys is a key account: no lock, many passes. A dead login account
  // that is logged in again keeps its kind, so a re-login never changes how its row is locked.
  const kind = files === "keys" ? "key" : "login";
  if (existing === undefined) addAccount(store.db, { runner, name, kind, ...(ownerEmail === null ? {} : { ownerEmail }), ...(found === null ? {} : { loginEmail: found.email }) }, p.now);
  else {
    // The state may have changed while the login ran. Only a dead account is revived.
    if (existing.state === "dead") reviveByLogin(store.db, id);
    // The owner of a row with a known seat never changes by a login.
    if (seat === null) {
      if (ownerEmail !== null) setOwnerEmail(store.db, id, ownerEmail);
      if (found !== null) setLoginEmail(store.db, id, found.email);
    }
  }
  store.event({ at: p.now.toISOString(), kind: "login", account: id });
  return { ok: true, ownerEmail };
}

export interface Out {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
}

export interface LoginParams {
  readonly store: Store;
  readonly home: HomeLayout;
  readonly runner: Runner;
  readonly name: string;
  readonly owner?: string;
  readonly docker: string;
  readonly interactive: (docker: string, argv: readonly string[]) => Promise<number>;
  readonly dryRun: boolean;
  readonly project: string;
  readonly user: TerminalOpts["user"];
  readonly now: Date;
  readonly out: Out;
}

/** Exit codes: 0 done, 1 failed, 2 wrong use. */
export async function runLogin(p: LoginParams): Promise<number> {
  const { store, home, runner, name, out } = p;
  const id = `${runner}/${name}`;
  if (runner !== "codex" && runner !== "pi" && runner !== "claude") {
    out.stderr(`squad login: unknown runner ${runner}\n`);
    return 2;
  }
  if (!ACCOUNT_NAME.test(name)) {
    out.stderr(`squad login: account name ${JSON.stringify(name)} is not safe for a folder name\n`);
    return 2;
  }
  const existing = getAccount(store.db, id);
  if (existing !== undefined && (existing.state !== "dead" || existing.kind !== "login")) {
    out.stderr(`${id} exists (${existing.kind}, ${existing.state}): use a new name or wait until it is dead\n`);
    return 2;
  }
  const passId = ulid(p.now.getTime());
  const staging = join(home.staging, passId);
  const cwd = join(tmpdir(), `squad-login-${passId}`);
  const opts = { cwd, passId, project: p.project, user: p.user, home: home.root, staging, name };
  let argv: string[];
  try {
    argv = loginArgv(runner, opts);
  } catch (e) {
    out.stderr(`${e instanceof Error ? e.message : "cannot build the login"}\n`);
    return 2;
  }
  if (p.dryRun) {
    out.stdout(`${p.docker} ${argv.join(" ")}\n`);
    out.stdout(`plan: log in to ${id} in ${staging}; check the owner; move it into accounts under the lock; ${existing === undefined ? "register" : "revive"} the account\n`);
    return 0;
  }

  mkdirSync(staging, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  let code: number;
  try {
    code = await p.interactive(p.docker, argv);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const drop = (): void => rmSync(staging, { recursive: true, force: true });
  if (code !== 0) {
    drop();
    out.stderr(`the login did not finish (exit ${code}); nothing was changed\n`);
    return 1;
  }
  const fin = await finishLogin({ store, home, runner, name, staging, ...(p.owner === undefined ? {} : { owner: p.owner }), now: p.now });
  if (!fin.ok) {
    if (fin.reason === "empty") out.stderr("the login wrote no files; nothing was changed\n");
    else if (fin.reason === "no-login") out.stderr("the login left no login file (the CLI was stopped or you did not log in); nothing was changed\n");
    else if (fin.reason === "owner-mismatch") out.stderr(`the login is for ${fin.found}, not ${p.owner}; nothing was moved\n`);
    else if (fin.reason === "seat-mismatch") out.stderr(`the login is for another seat than ${id} had; nothing was moved\n`);
    else if (fin.reason === "exists") out.stderr(`${id} exists; nothing was moved\n`);
    else out.stderr(`${id}: account busy (a pass holds it); the new login was dropped, nothing was changed\n`);
    return 1;
  }
  const ownerEmail = fin.ownerEmail;
  out.stdout(`logged in ${id}${ownerEmail === null ? "" : ` (${ownerEmail})`}\n`);
  return 0;
}
