// The `squad` command. `main` takes its io as a value, so a test runs a verb against a throwaway
// home. The entry at the bottom is the only code that reads process values.
//
// Nothing here prints a key, an auth file or a path inside an account folder.

import "./quiet.ts";
import { findPassFile, readPassFile } from "../passfiles.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { roomOf } from "../accounts/room.ts";
import { dueReads, readIntervalMs, refreshUsage } from "../accounts/usage-read.ts";
import type { UsageReadResult } from "../accounts/health.ts";
import { createFileAccount } from "../accounts/add.ts";
import { withKeyCopy } from "../accounts/keycopy.ts";
import { getAccount, getHealth, healthOf, listAccounts, setFloors, setOwnerEmail } from "../accounts/store.ts";
import type { Runner } from "../docker.ts";
import { describeAction, executeGc, gatherGcState, gcSettings, planGc } from "../gc.ts";
import { ensureHome, homeRoot, layoutOf } from "../home.ts";
import { ULID_RE, ulid } from "../ids.ts";
import { runImport, runImportDoppelganger } from "../import.ts";
import { ensureLockFile } from "../lock.ts";
import { identityOf } from "../accounts/identity.ts";
import { runLogin, shellArgv } from "../login.ts";
import { findForbidden } from "@squad/contract";
import { bundledPath } from "../paths.ts";
import { buildArgv, IMAGES, type ImageRunner } from "../images.ts";
import { flockBusy, lockPathOf, runPass, safeTail, type RunDeps } from "../run.ts";
import { SQUAD_DOCKER_ENV, SQUAD_DRY_RUN_ENV, SQUAD_NO_GC_ENV, SQUAD_NO_USAGE_READ_ENV, envOn, envOptional } from "../settings.ts";
import type { SupportedRunner } from "../runners/table.ts";
import { openStore, type Store } from "../store/db.ts";
import { startWeb } from "../web/server.ts";
import { USAGE_BYS, usageBy, type UsageBy, type UsageRow } from "../usage/report.ts";

export interface Io {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly now?: () => Date;
  /** The fetch for the usage read; tests inject one. Default is the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Runs a docker command with the person's terminal attached; returns its exit code. Tests inject one. */
  readonly interactive?: (docker: string, argv: readonly string[]) => Promise<number>;
  /** Ends a long-running verb (`web`). Default: SIGINT or SIGTERM. Tests inject one. */
  readonly signal?: AbortSignal;
}

const USAGE = `usage: squad <verb>
  list                                     accounts, health and room left
  usage [--by account|task|flow|day|model] [--since 7d]
                                           token use, grouped
  add-key <runner>/<name> --from <file> [--owner <email>]
                                           make a key account from a file
  add-token claude/<name> --from <file> [--owner <email>]
                                           make a claude token account from a file
  owner <account> [<email>]                set who owns an account (a codex login gives its own email)
  usage-read [<account>]                   read the codex usage now (all that are due, or the one named)
  floor <account> <5h%> <week%>            share of each window kept for the owner
  image build <runner>                     build a runner image with docker (SQUAD_DRY_RUN=1 prints the argv)
  probe <runner>/<name> [--model <id>]     one tiny real pass on one account; pi, claude and codex need --model
  gc [--dry-run]                           remove orphan containers, lost passes, old files and sessions
  login <runner>/<name> [--owner <email>]  log in to a new account (or a dead one) in a container
  import <home> [<account>...]             bring accounts from another home (a login is moved, a key copied); a doppelganger project: its pi keys are copied (--owner <email>)
  import --back <account> <home>           send one account to another home
  shell <account>                          a bash session in a container on one account
  log <passId>                             the last 50 lines of a pass log
  web [--api-only]                         the web app and its API (needs SQUAD_WEB_URL and the SQUAD_OIDC_* settings)
                                           (not --api-only) it also runs a background loop: usage reads, auto probes, prices
`;

/** A usage mistake: exit 2 with the text on stderr. Anything else that fails is exit 1. */
class UsageError extends Error {}

/** A plain table: two spaces between columns, numbers to the right. */
function table(head: readonly string[], rows: readonly (readonly string[])[], right: ReadonlySet<number> = new Set()): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: readonly string[]): string => r.map((c, i) => (right.has(i) ? c.padStart(w[i]!) : c.padEnd(w[i]!))).join("  ").trimEnd();
  return `${[head, ...rows].map(line).join("\n")}\n`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An owner email, lowercased. A bad shape is a usage error. */
function cleanEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (!EMAIL.test(e)) throw new UsageError("an owner email must look like x@y.z");
  return e;
}

const pct = (v: number | null): string => (v === null ? "-" : `${Math.round(v)}%`);

function list(store: Store, io: Io): number {
  const now = (io.now ?? (() => new Date()))();
  const rows = listAccounts(store.db).map((a) => {
    const h = getHealth(store.db, a.id);
    return [a.id, a.kind, a.ownerEmail ?? "-", a.state, healthOf(a, h, now), pct(h.left5h), pct(h.leftWeek), h.lastUsedAt ?? "-"];
  });
  io.stdout(table(["ACCOUNT", "KIND", "OWNER", "STATE", "HEALTH", "5H", "WEEK", "LAST USED"], rows, new Set([5, 6])));
  const home = layoutOf(homeRoot(io.cwd, io.env), io.env);
  const runners = [...new Set(listAccounts(store.db).map((a) => a.runner))];
  const rooms = runners.map((runner) => {
    // A login is busy when its lock file exists and is held. The probe makes no file.
    const r = roomOf(store.db, runner, now, (id) => {
      const a = getAccount(store.db, id)!;
      const lock = lockPathOf(home, a);
      return a.kind === "login" && existsSync(lock) && flockBusy(lock);
    }, io.env);
    return `room: ${runner} ${r.free}/${r.total}\n`;
  });
  if (rooms.length > 0) io.stdout(`\n${rooms.join("")}`);
  return 0;
}

const sayRead = (id: string, r: UsageReadResult): string => {
  if ("ok" in r) return `${id} 5h=${pct(r.ok.room.left5h ?? null)} week=${pct(r.ok.room.leftWeek ?? null)} plan=${r.ok.plan ?? "-"}\n`;
  return "suspect" in r ? `${id} suspect (401)\n` : `${id} error ${r.error}\n`;
};

/** Reads the codex usage now. With a name, that account; without, the accounts the schedule says are due. */
async function usageRead(store: Store, io: Io, args: readonly string[]): Promise<number> {
  const { rest } = options(args, []);
  if (rest.length > 1) throw new UsageError("usage-read takes at most one account");
  if (envOn(SQUAD_NO_USAGE_READ_ENV, io.env)) {
    io.stdout("usage reads are off (SQUAD_NO_USAGE_READ=1); nothing done\n");
    return 0;
  }
  const now = (io.now ?? (() => new Date()))();
  const home = layoutOf(homeRoot(io.cwd, io.env), io.env);
  let targets;
  if (rest[0] !== undefined) {
    const one = getAccount(store.db, rest[0]);
    if (one === undefined) throw new UsageError(`unknown account ${rest[0]}`);
    if (one.runner !== "codex" || one.kind !== "login") {
      io.stderr(`${one.id}: the usage read is for codex login accounts only\n`);
      return 1;
    }
    targets = [one];
  } else {
    const accounts = listAccounts(store.db);
    // A hand run reads every account that is due, with no per-call budget: that budget spreads a timer's calls.
    targets = dueReads(accounts, new Map(accounts.map((a) => [a.id, getHealth(store.db, a.id)])), now, readIntervalMs(io.env), io.env, Infinity);
    if (targets.length === 0) {
      io.stdout("nothing due\n");
      return 0;
    }
  }
  let code = 0;
  for (const a of targets) {
    const r = await refreshUsage(store, home, a, io.fetch ?? globalThis.fetch, now);
    io.stdout(sayRead(a.id, r));
    if (!("ok" in r)) code = 1;
  }
  return code;
}

/** Options as a map. Every option takes one value; anything else is a usage error. */
function options(args: readonly string[], allowed: readonly string[]): { rest: string[]; opts: Map<string, string> } {
  const rest: string[] = [];
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) rest.push(a);
    else if (allowed.includes(a.slice(2)) && i + 1 < args.length) opts.set(a.slice(2), args[++i]!);
    else throw new UsageError(`bad option ${a}`);
  }
  return { rest, opts };
}

const SINCE = /^(\d+)([hd])$/;

function usage(store: Store, io: Io, args: readonly string[]): number {
  const { rest, opts } = options(args, ["by", "since"]);
  if (rest.length > 0) throw new UsageError(`unexpected ${rest[0]}`);
  const by = opts.get("by") ?? "account";
  if (!(USAGE_BYS as readonly string[]).includes(by)) throw new UsageError(`--by must be one of ${USAGE_BYS.join(", ")}`);
  const m = SINCE.exec(opts.get("since") ?? "7d");
  if (m === null) throw new UsageError("--since must look like 7d or 12h");
  const now = (io.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000));
  const n = (v: number): string => String(v);
  const cost = (r: UsageRow): string => (r.costUsd === null ? "-" : `$${r.costUsd.toFixed(4)}`);
  const rows = usageBy(store.db, by as UsageBy, since).map((r) => [r.key, n(r.passes), n(r.ok), n(r.fail), n(r.input), n(r.output), n(r.cacheRead), n(r.cacheWrite), n(r.reasoning), cost(r)]);
  io.stdout(table([by.toUpperCase(), "PASSES", "OK", "FAIL", "INPUT", "OUTPUT", "CACHE-R", "CACHE-W", "REASON", "COST"], rows, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9])));
  return 0;
}

/** Copies the file under the home, then registers the account. The content goes nowhere else. */
function addKey(store: Store, io: Io, args: readonly string[]): number {
  const { rest, opts } = options(args, ["from", "owner"]);
  const id = /^([^/]+)\/([^/]+)$/.exec(rest[0] ?? "");
  const from = opts.get("from");
  if (rest.length !== 1 || id === null || from === undefined) throw new UsageError("add-key needs <runner>/<name> and --from <file>");
  const ownerEmail = opts.has("owner") ? cleanEmail(opts.get("owner")!) : undefined;
  let body: Buffer;
  try {
    body = readFileSync(from);
  } catch {
    io.stderr("cannot read the key file\n");
    return 1;
  }
  const runner = id[1]!;
  const name = id[2]!;
  try {
    createFileAccount(store.db, layoutOf(homeRoot(io.cwd, io.env), io.env), { runner: runner as Runner, name, kind: "key", ...(ownerEmail === undefined ? {} : { ownerEmail }) }, [{ name: "auth.json", body }], (io.now ?? (() => new Date()))());
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : "cannot add the account"}\n`);
    return 1;
  }
  io.stdout(`added key account ${runner}/${name}\n`);
  return 0;
}

/** Copies the token under the home (one trailing newline cut), then registers the account. It prints no content. */
function addToken(store: Store, io: Io, args: readonly string[]): number {
  const { rest, opts } = options(args, ["from", "owner"]);
  const id = /^([^/]+)\/([^/]+)$/.exec(rest[0] ?? "");
  const from = opts.get("from");
  if (rest.length !== 1 || id === null || from === undefined) throw new UsageError("add-token needs claude/<name> and --from <file>");
  const ownerEmail = opts.has("owner") ? cleanEmail(opts.get("owner")!) : undefined;
  let body: Buffer;
  try {
    body = readFileSync(from);
  } catch {
    io.stderr("cannot read the token file\n");
    return 1;
  }
  const text = body.toString("utf8").replace(/\r?\n$/, "");
  if (text === "") {
    io.stderr("the token file is empty\n");
    return 1;
  }
  const runner = id[1]!;
  const name = id[2]!;
  try {
    createFileAccount(store.db, layoutOf(homeRoot(io.cwd, io.env), io.env), { runner: runner as Runner, name, kind: "token", ...(ownerEmail === undefined ? {} : { ownerEmail }) }, [{ name: "token", body: text }], (io.now ?? (() => new Date()))());
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : "cannot add the account"}\n`);
    return 1;
  }
  io.stdout(`added token account ${runner}/${name}\n`);
  return 0;
}

/** Sets who owns an account. For a codex login the ID token is the truth; for the rest the person gives the email. */
function ownerCmd(store: Store, io: Io, args: readonly string[]): number {
  const { rest } = options(args, []);
  if (rest.length < 1 || rest.length > 2) throw new UsageError("owner needs <account> and may take <email>");
  const a = getAccount(store.db, rest[0]!);
  if (a === undefined) throw new UsageError(`unknown account ${rest[0]}`);
  const given = rest[1] === undefined ? undefined : cleanEmail(rest[1]);
  const found = identityOf(a.runner, a.kind, join(layoutOf(homeRoot(io.cwd, io.env), io.env).accounts, a.runner, a.name));
  const foundEmail = found?.email.toLowerCase();
  if (given === undefined && foundEmail === undefined) {
    if (a.kind === "login" && a.runner === "codex") {
      io.stderr(`${a.id}: the login has no email in its files; give the email\n`);
      return 1;
    }
    throw new UsageError(`give the email: no identity in the files of a ${a.kind} account`);
  }
  if (given !== undefined && foundEmail !== undefined && given !== foundEmail) {
    io.stderr(`${a.id}: the login belongs to another email; nothing changed\n`);
    return 1;
  }
  const email = (given ?? foundEmail)!;
  setOwnerEmail(store.db, a.id, email);
  store.event({ at: (io.now ?? (() => new Date()))().toISOString(), kind: "owner-set", account: a.id, code: foundEmail === undefined ? "manual" : "login" });
  io.stdout(`${a.id} owner ${email}\n`);
  return 0;
}

function floor(store: Store, io: Io, args: readonly string[]): number {
  const { rest } = options(args, []);
  if (rest.length !== 3) throw new UsageError("floor needs <account> <5h%> <week%>");
  const [id, a, b] = [rest[0]!, Number(rest[1]), Number(rest[2])];
  for (const v of [a, b]) if (!Number.isFinite(v) || v < 0 || v > 100) throw new UsageError("a floor is a percent from 0 to 100");
  try {
    setFloors(store.db, id, a, b);
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : "cannot set the floors"}\n`);
    return 1;
  }
  io.stdout(`${id}: floors ${a}% (5h) and ${b}% (week)\n`);
  return 0;
}

/** Runs `docker build` from the repo root and streams its output to stderr. Exits with docker's code. */
async function imageBuild(_store: Store, io: Io, args: readonly string[]): Promise<number> {
  const { rest } = options(args.slice(1), []);
  if (args[0] !== "build" || rest.length !== 1) throw new UsageError("image needs: build <runner>");
  const runner = rest[0]!;
  if (!Object.hasOwn(IMAGES, runner)) throw new UsageError(`unknown runner ${runner}; one of ${Object.keys(IMAGES).join(", ")}`);
  const dir = bundledPath("images");
  if (!existsSync(dir)) {
    io.stderr(`cannot find the images folder (looked for ${dir})\n`);
    return 1;
  }
  const docker = envOptional(SQUAD_DOCKER_ENV, io.env)!;
  const argv = buildArgv(runner as ImageRunner);
  if (envOn(SQUAD_DRY_RUN_ENV, io.env)) {
    io.stdout(`${docker} ${argv.join(" ")}\n`);
    return 0;
  }
  return new Promise((resolve) => {
    const child = spawn(docker, argv, { cwd: dirname(dir.replace(/\/$/, "")), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => io.stderr(b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => io.stderr(b.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      io.stderr(`cannot run ${docker}: ${e.code ?? "error"}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** The deps `runPass` needs, for every verb that runs a pass. One place, so the verbs agree. */
function passDeps(store: Store, io: Io): RunDeps {
  const home = layoutOf(homeRoot(io.cwd, io.env), io.env);
  return {
    home,
    store,
    project: basename(dirname(home.root)),
    identity: { name: "squad", email: "squad@localhost" },
    user: process.getuid === undefined || process.getgid === undefined ? null : { uid: process.getuid(), gid: process.getgid() },
    env: io.env,
    ...(io.now === undefined ? {} : { now: io.now }),
  };
}

const PROBE_PROMPT = "Reply with the single word: ok";

/** One tiny pass on one account. Prints one line and never the stream text. */
async function probe(store: Store, io: Io, args: readonly string[]): Promise<number> {
  const { rest, opts } = options(args, ["model"]);
  const id = /^([^/]+)\/([^/]+)$/.exec(rest[0] ?? "");
  if (rest.length !== 1 || id === null) throw new UsageError("probe needs <runner>/<name>");
  const runner = id[1]!;
  const model = opts.get("model");
  if (getAccount(store.db, rest[0]!) === undefined) throw new UsageError(`unknown account ${rest[0]}`);
  if ((runner === "pi" || runner === "claude" || runner === "codex") && model === undefined) throw new UsageError(`probe on ${runner} needs --model; there is no safe default`);
  const cwd = mkdtempSync(join(tmpdir(), "squad-probe-"));
  try {
    if (spawnSync("git", ["init", "-q"], { cwd, stdio: "ignore" }).status !== 0) {
      io.stderr("cannot make the probe folder a git repo\n");
      return 1;
    }
    const res = await runPass({ runner: runner as SupportedRunner, model: model ?? "", prompt: PROBE_PROMPT, account: rest[0]!, cwd, caller: { flow: "cli", action: "probe" } }, passDeps(store, io));
    const account = res.account ?? rest[0]!;
    if (res.failure !== undefined) {
      io.stdout(`${account} fail ${res.failure.kind}${res.failure.code === "" ? "" : ` ${res.failure.code}`}\n`);
      // The message can be the CLI's stderr: it says why when no stream came. Lines that look like secrets are dropped.
      const reason = safeTail(res.failure.message).replace(/\s*\n\s*/g, " ").slice(0, 200);
      if (reason !== "") io.stdout(`  reason: ${reason}\n`);
      return 1;
    }
    const h = getHealth(store.db, account);
    io.stdout(`${account} ok ${res.model ?? model} in=${res.usage.input} out=${res.usage.output} 5h=${pct(h.left5h)} week=${pct(h.leftWeek)}\n`);
    return 0;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The cleanup job. `--dry-run` (or SQUAD_DRY_RUN=1) prints the plan and changes nothing. */
function gc(store: Store, io: Io, args: readonly string[]): number {
  if (args.some((a) => a !== "--dry-run")) throw new UsageError("gc takes only --dry-run");
  if (envOn(SQUAD_NO_GC_ENV, io.env)) {
    io.stdout("gc is off (SQUAD_NO_GC=1); nothing done\n");
    return 0;
  }
  const dry = args.length > 0 || envOn(SQUAD_DRY_RUN_ENV, io.env);
  const now = io.now ?? (() => new Date());
  const home = layoutOf(homeRoot(io.cwd, io.env), io.env);
  const deps = { docker: envOptional(SQUAD_DOCKER_ENV, io.env)!, store, home, now, fold: !dry };
  const actions = planGc(gatherGcState(deps), now(), gcSettings(io.env));
  if (actions.length === 0) {
    io.stdout("nothing to clean\n");
    return 0;
  }
  if (dry) {
    io.stdout(actions.map((a) => `${describeAction(a, home, true)}\n`).join(""));
    return 0;
  }
  const res = executeGc(actions, deps);
  io.stdout(res.done.map((a) => `${describeAction(a, home, false)}\n`).join(""));
  for (const f of res.failed) io.stderr(`failed: ${describeAction(f.action, home, true)}: ${f.why}\n`);
  return res.failed.length === 0 ? 0 : 1;
}

/** The default `Io.interactive`: the child owns the terminal until it ends. */
const inheritTerminal = (docker: string, argv: readonly string[]): Promise<number> =>
  new Promise((done) => {
    const child = spawn(docker, [...argv], { stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("close", (code) => done(code ?? 1));
  });

const dockerOf = (io: Io): string => envOptional(SQUAD_DOCKER_ENV, io.env)!;

/** A person logs in to a new account, or a dead one. The real CLI runs in a container. */
async function login(store: Store, io: Io, args: readonly string[]): Promise<number> {
  const { rest, opts } = options(args, ["owner"]);
  const id = /^([^/]+)\/([^/]+)$/.exec(rest[0] ?? "");
  if (rest.length !== 1 || id === null) throw new UsageError("login needs <runner>/<name> and may take --owner <email>");
  const d = passDeps(store, io);
  return runLogin({
    store, home: d.home, runner: id[1] as Runner, name: id[2]!, ...(opts.has("owner") ? { owner: opts.get("owner")! } : {}),
    docker: dockerOf(io), interactive: io.interactive ?? inheritTerminal, dryRun: envOn(SQUAD_DRY_RUN_ENV, io.env),
    project: d.project, user: d.user, now: (io.now ?? (() => new Date()))(), out: io,
  });
}

/** `import <home> [<account>...]` or `import --back <account> <home>`. */
async function importCmd(store: Store, io: Io, args: readonly string[]): Promise<number> {
  const back = args.includes("--back");
  const { rest } = options(args.filter((a) => a !== "--back"), ["owner"]);
  if (back ? rest.length !== 2 : rest.length < 1) throw new UsageError("import needs <home> [<account>...], or --back <account> <home>");
  const here = layoutOf(homeRoot(io.cwd, io.env), io.env);
  const otherRoot = resolve(io.cwd, back ? rest[1]! : rest[0]!);
  if (otherRoot === resolve(here.root)) {
    io.stderr("that is this home\n");
    return 1;
  }
  if (!existsSync(otherRoot)) {
    io.stderr("the other home does not exist\n");
    return 1;
  }
  // The other home never takes this process's SQUAD_DB: that setting is for this home.
  const other = layoutOf(otherRoot, {});
  // A doppelganger project has no squad database, only `creds/pi/<name>/`. Its pi key accounts are copied, never moved.
  const creds = [join(otherRoot, "creds"), join(otherRoot, ".doppelganger", "creds")].find((d) => existsSync(join(d, "pi")));
  if (!back && !existsSync(other.db) && creds !== undefined) {
    const owner = options(args.filter((a) => a !== "--back"), ["owner"]).opts.get("owner");
    return runImportDoppelganger({
      creds, to: { home: here, store }, names: rest.slice(1), ...(owner === undefined ? {} : { ownerEmail: cleanEmail(owner) }),
      dryRun: envOn(SQUAD_DRY_RUN_ENV, io.env), now: (io.now ?? (() => new Date()))(), out: io,
    });
  }
  if (!back && !existsSync(other.db)) {
    io.stderr("the other home has no database\n");
    return 1;
  }
  ensureHome(other);
  const otherStore = openStore({ dbPath: other.db, spoolDir: other.spool });
  try {
    const mine = { home: here, store };
    const theirs = { home: other, store: otherStore };
    return await runImport({ from: back ? mine : theirs, to: back ? theirs : mine, names: back ? [rest[0]!] : rest.slice(1), dryRun: envOn(SQUAD_DRY_RUN_ENV, io.env), now: (io.now ?? (() => new Date()))(), out: io });
  } finally {
    otherStore.close();
  }
}

/** A bash session on one account, behind the same lock, key copy or token file as a pass. */
async function shell(store: Store, io: Io, args: readonly string[]): Promise<number> {
  const { rest } = options(args, []);
  if (rest.length !== 1) throw new UsageError("shell needs <account>");
  const a = getAccount(store.db, rest[0]!);
  if (a === undefined) throw new UsageError(`unknown account ${rest[0]}`);
  if (a.state === "moved") {
    io.stderr(`${a.id} moved to another home\n`);
    return 1;
  }
  const d = passDeps(store, io);
  const docker = dockerOf(io);
  const passId = ulid((io.now ?? (() => new Date()))().getTime());
  const cwd = mkdtempSync(join(tmpdir(), "squad-shell-"));
  const lockFile = a.kind === "login" ? lockPathOf(d.home, a) : null;
  const argvFor = (dir: string): string[] => shellArgv(a, { dir, lockFile, cwd, passId, project: d.project, user: d.user, home: d.home.root });
  const realDir = join(d.home.accounts, a.runner, a.name);
  try {
    if (envOn(SQUAD_DRY_RUN_ENV, io.env)) {
      // A key account would run on a throwaway copy; the plan shows the account folder under a name, never its path.
      io.stdout(`${docker} ${argvFor(realDir).join(" ").replaceAll(realDir, "<account>")}\n`);
      return 0;
    }
    if (lockFile !== null) ensureLockFile(lockFile);
    const run = async (dir: string): Promise<number> => (io.interactive ?? inheritTerminal)(docker, argvFor(dir));
    const code = a.kind === "key" ? await withKeyCopy(d.home, a, run) : await run(realDir);
    if (code === 75) io.stderr(`${a.id}: account busy (a pass holds it)\n`);
    return code === 75 ? 1 : code;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const LOG_LINES = 50;

/** A log line is safe to show when it, its JSON (if it is JSON) and each of its words pass findForbidden. */
function lineIsSafe(line: string): boolean {
  const t = line.trim();
  if (findForbidden(t) !== undefined || t.split(/\s+/).some((w) => findForbidden(w) !== undefined)) return false;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return findForbidden(JSON.parse(t)) === undefined;
    } catch {
      return true;
    }
  }
  return true;
}

/** Prints where a pass log is and its last 50 lines, minus any line that looks like a secret. */
function logCmd(_store: Store, io: Io, args: readonly string[]): number {
  const { rest } = options(args, []);
  if (rest.length !== 1) throw new UsageError("log needs <passId>");
  const id = rest[0]!;
  if (!ULID_RE.test(id)) throw new UsageError(`${JSON.stringify(id)} is not a pass id`);
  const home = layoutOf(homeRoot(io.cwd, io.env), io.env);
  const path = findPassFile(home, id, "log");
  if (path === undefined) throw new UsageError(`no log for pass ${id}`);
  const lines = readPassFile(path).split("\n");
  if (lines.at(-1) === "") lines.pop();
  io.stdout(`${path}\n${lines.slice(-LOG_LINES).filter(lineIsSafe).map((l) => `${l}\n`).join("")}`);
  return 0;
}

/** `squad web`: runs until the signal. It prints where it listens and the public URL; no secret. */
async function web(store: Store, io: Io, args: readonly string[]): Promise<number> {
  if (args.some((a) => a !== "--api-only")) throw new UsageError("web takes only --api-only");
  const handle = await startWeb({
    // The loop's probes run the verb above, so there is one way to start a probe pass.
    probe: async (a, model) => { await probe(store, { ...io, stdout: () => {}, stderr: () => {} }, [a.id, "--model", model]); },
    env: io.env, home: layoutOf(homeRoot(io.cwd, io.env), io.env), store, apiOnly: args.length > 0,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }), ...(io.now === undefined ? {} : { now: io.now }),
  });
  io.stdout(`squad web: listening on http://${handle.bind.includes(":") ? `[${handle.bind}]` : handle.bind}:${handle.port} (public ${handle.url})\n`);
  await new Promise<void>((done) => {
    if (io.signal !== undefined) {
      if (io.signal.aborted) return done();
      return io.signal.addEventListener("abort", () => done(), { once: true });
    }
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
  });
  await handle.close();
  return 0;
}

const VERBS: Record<string, (store: Store, io: Io, args: readonly string[]) => number | Promise<number>> = {
  list: (s, io, args) => (args.length === 0 ? list(s, io) : fail("list takes no arguments")),
  usage,
  "usage-read": usageRead,
  "add-key": addKey,
  "add-token": addToken,
  owner: ownerCmd,
  floor,
  image: imageBuild,
  probe,
  gc,
  login,
  import: importCmd,
  shell,
  log: logCmd,
  web,
};

function fail(msg: string): never {
  throw new UsageError(msg);
}

/** Runs one verb. Returns the exit code: 0 done, 1 failed, 2 wrong use. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const verb = argv[0];
  const run = verb === undefined ? undefined : Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (run === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  let store: Store | undefined;
  try {
    const home = layoutOf(homeRoot(io.cwd, io.env), io.env);
    ensureHome(home);
    store = openStore({ dbPath: home.db, spoolDir: home.spool });
    return await run(store, io, argv.slice(1));
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`squad ${verb}: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`squad ${verb}: ${e instanceof Error ? e.message.split("\n")[0] : "failed"}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

// The entry: only when this file is the program, not when a test imports it.
// argv[1] is the npm bin symlink when installed, so compare real paths.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env: process.env, cwd: process.cwd() });
}
