// One pass of an agent, start to end: pick an account, run the CLI in a container, read its stream,
// write the pass row, and feed the outcome back to the account's health.
//
// pi, claude and codex run here (see runners/table.ts). Only pi keeps a session. The decision code is in small functions
// (`failureOf`, `resolveCandidates`); the spawn code is `spawnDocker` and nothing else.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { findForbidden } from "@squad/contract";
import { bundledPath } from "./paths.ts";
import { applyOutcome } from "./accounts/health.ts";
import { withKeyCopy } from "./accounts/keycopy.ts";
import { candidates, getAccount, getHealth, putHealth, setState, type AccountRow } from "./accounts/store.ts";
import { SQUAD_DOCKER_ENV, SQUAD_NO_USAGE_EXPORT_ENV, envOn, envOptional } from "./settings.ts";
import { dockerKillArgv, dockerRunArgv, dockerStopArgv, stopGraceS, type PassPlan } from "./docker.ts";
import type { HomeLayout } from "./home.ts";
import { IMAGES } from "./images.ts";
import { ulid } from "./ids.ts";
import { makeLog, type Log } from "./log.ts";
import { scopeState } from "./health/breaker.ts";
import { pick, type PickResult } from "./pool/pick.ts";
import { loadPrices, passCost } from "./prices.ts";
import { checkSessionId, deleteSession, getSession, pinSession, sessionDir, touchSession } from "./sessions.ts";
import { isSupported, RUNNER_SPECS, type SupportedRunner } from "./runners/table.ts";
import { isBusy, NO_TOKENS, type Store } from "./store/db.ts";
import { writeUsageExport } from "./store/export.ts";
import type { Failure, StreamOutcome, Usage } from "./types.ts";

export interface PassRequest {
  readonly runner: SupportedRunner;
  readonly model: string;
  readonly prompt: string;
  /** In this step a pool is every account of the runner; the name is only a label. */
  readonly pool?: string;
  /** A named account, `pi/alice`. */
  readonly account?: string;
  readonly cwd: string;
  /** The main repo's .git; default `<cwd>/.git`. A linked worktree must pass it. */
  readonly gitDir?: string;
  readonly caller: { readonly flow: string; readonly action: string };
  readonly task?: { readonly kind: string; readonly id: string };
  readonly session?: string;
  readonly idleMs?: number;
  readonly deadlineMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface RunDeps {
  readonly home: HomeLayout;
  readonly store: Store;
  readonly now?: () => Date;
  /** The docker program; default is the SQUAD_DOCKER setting. Tests point it at a fake. */
  readonly docker?: string;
  readonly project: string;
  readonly identity: { readonly name: string; readonly email: string };
  /** null on a rootless daemon. */
  readonly user: { readonly uid: number; readonly gid: number } | null;
  readonly log?: Log;
  /** Host-side busy check. The default probes a login's lock file and says false for the rest. */
  readonly busy?: (account: AccountRow, lockFile: string) => boolean;
  /** Settings source for the grace time, floors and cool times; default is process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PassResult {
  readonly passId: string;
  readonly account: string | null;
  readonly text: string;
  readonly texts: readonly string[];
  readonly turns: number;
  /** The model the stream reported, else null. */
  readonly model: string | null;
  readonly usage: Usage;
  readonly failure?: Failure;
  readonly logPath: string | null;
}

export const DEFAULT_IDLE_MS = 15 * 60_000;
export const DEFAULT_DEADLINE_MS = 2 * 60 * 60_000;
/** The exit code of `flock -E 75` in the container: another pass holds the account. */
export const EXIT_LOCK_BUSY = 75;
const STDERR_KEEP = 4096;
/**
 * codex writes a `[projects."<cwd>"]` trust entry into $CODEX_HOME/config.toml on every pass, even
 * with --ignore-user-config, so a login folder would grow a line per pass. An empty read-only file
 * over it stops that.
 */
function ensureEmptyFile(path: string): void {
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

const CODEX_CONFIG_GUARD = bundledPath("assets/codex-config.toml");

export const lockPathOf = (home: HomeLayout, a: AccountRow): string => join(home.locks, a.runner, `${a.name}.lock`);
const accountDirOf = (home: HomeLayout, a: AccountRow): string => join(home.accounts, a.runner, a.name);

/** Makes the empty lock file if it is missing. The container takes the lock, never this process. */
function ensureLockFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
}

/** A probe that takes the lock and lets it go at once. The answer can be stale; the container's flock is the real one. */
export function flockBusy(lock: string): boolean {
  return spawnSync("flock", ["-n", lock, "true"], { stdio: "ignore" }).status !== 0;
}

/** The accounts a request may use, as `pick` input. Throws for an unknown named account. */
export function resolveCandidates(req: PassRequest, deps: RunDeps, now: Date) {
  const db = deps.store.db;
  const busyFn = deps.busy ?? ((a: AccountRow, lock: string) => a.kind === "login" && flockBusy(lock));
  const named = req.account === undefined ? undefined : req.account.includes("/") ? req.account : `${req.runner}/${req.account}`;
  if (named !== undefined && getAccount(db, named)?.runner !== req.runner) throw new Error(`unknown ${req.runner} account ${named}`);
  const all = candidates(db, req.runner, now, (id) => {
    if (named !== undefined && id !== named) return false;
    const a = getAccount(db, id)!;
    const lock = lockPathOf(deps.home, a);
    if (a.kind === "login") ensureLockFile(lock);
    return busyFn(a, lock);
  }, deps.env);
  return { named, list: named === undefined ? all : all.filter((c) => c.account === named) };
}

/** The failure of a finished container. A stop we asked for beats the stream; the stream beats the exit code. */
export function failureOf(o: StreamOutcome, exitCode: number | null, stopped: "idle" | "timeout" | undefined, stderrTail: string): Failure | undefined {
  if (stopped !== undefined) return { kind: stopped, code: "", message: stopped === "idle" ? "no output for too long; the pass was stopped" : "the deadline passed; the pass was stopped" };
  if (o.failure !== undefined) return o.failure;
  if (o.ended) return undefined;
  const code = exitCode === null ? "exit:signal" : exitCode === 0 ? "no-agent-end" : `exit:${exitCode}`;
  return { kind: "provider", code, message: stderrTail === "" ? "the CLI ended before agent_end" : stderrTail };
}

/** Keeps stderr lines for a message, minus any line that looks like a secret. */
export function safeTail(raw: string): string {
  return raw.split("\n").filter((l) => findForbidden(l.trim()) === undefined).join("\n").trim().slice(-STDERR_KEEP);
}

interface Spawned {
  readonly exitCode: number | null;
  readonly stream: StreamOutcome;
  readonly raw: string;
  readonly stderrTail: string;
  readonly stopped?: "idle" | "timeout";
}

/** Runs one `docker run`. Thin: it only moves bytes and keeps two timers. */
function spawnDocker(docker: string, argv: string[], name: string, idleMs: number, deadlineMs: number, graceS: number, runner: SupportedRunner, stdin: string | null): Promise<Spawned> {
  return new Promise((resolve) => {
    const child = spawn(docker, argv, { stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
    const stream = RUNNER_SPECS[runner].stream();
    if (stdin !== null) {
      // The prompt goes on stdin so it is in no argv. A CLI that exits early closes the pipe: ignore that.
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin);
    }
    const out = new StringDecoder("utf8");
    let raw = "";
    let err = "";
    let stopped: "idle" | "timeout" | undefined;
    let done = false;

    const stop = (why: "idle" | "timeout"): void => {
      if (stopped !== undefined || done) return;
      stopped = why;
      // Stop before kill: the grace time lets a token refresh in flight finish.
      const s = spawn(docker, dockerStopArgv(name, graceS), { stdio: "ignore" });
      const after = (): void => {
        if (!done) child.kill("SIGTERM");
        setTimeout(() => {
          if (!done) spawn(docker, dockerKillArgv(name), { stdio: "ignore" }).on("error", () => {});
        }, 2000).unref();
      };
      s.on("error", after);
      s.on("close", after);
    };

    let idle = setTimeout(() => stop("idle"), idleMs);
    const deadline = setTimeout(() => stop("timeout"), deadlineMs);
    child.stdout!.on("data", (b: Buffer) => {
      clearTimeout(idle);
      idle = setTimeout(() => stop("idle"), idleMs);
      const s = out.write(b);
      raw += s;
      stream.push(s);
    });
    child.stderr!.on("data", (b: Buffer) => {
      err = (err + b.toString("utf8")).slice(-STDERR_KEEP * 2);
    });
    const finish = (exitCode: number | null, extra = ""): void => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(deadline);
      const rest = out.end();
      raw += rest;
      stream.push(rest);
      stream.end();
      resolve({ exitCode, stream: stream.outcome(), raw, stderrTail: safeTail(err + extra), ...(stopped === undefined ? {} : { stopped }) });
    };
    child.on("error", (e: NodeJS.ErrnoException) => finish(null, `\nspawn ${e.code ?? "error"}`));
    child.on("close", (code) => finish(code));
  });
}

/** The stream first; the `-o` file only when the stream had no agent_message. */
function withLastMessage(sp: Spawned, outDir: string): Spawned {
  if (sp.stream.texts.length > 0) return sp;
  let text: string;
  try {
    text = readFileSync(join(outDir, "last-message.txt"), "utf8");
  } catch {
    return sp;
  }
  return text === "" ? sp : { ...sp, stream: { ...sp.stream, text, texts: [text] } };
}

function writeLog(home: HomeLayout, now: Date, passId: string, raw: string): string {
  const dir = join(home.passLogs, now.toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${passId}.log`);
  writeFileSync(path, raw, { mode: 0o600 });
  return path;
}

const noAccount = (store: Store, req: PassRequest, deps: RunDeps, now: Date, failure: Failure): PassResult => {
  const id = ulid(now.getTime());
  store.startPass({ id, startedAt: now.toISOString(), project: deps.project, flow: req.caller.flow, action: req.caller.action, runner: req.runner, model: req.model, ...taskOf(req) });
  store.endPass({ id, endedAt: now.toISOString(), outcome: failure.kind, failKind: failure.kind, failCode: failure.code, tokens: NO_TOKENS });
  return { passId: id, account: null, text: "", texts: [], turns: 0, model: null, usage: NO_TOKENS, failure, logPath: null };
};

const taskOf = (req: PassRequest) => ({ ...(req.task === undefined ? {} : { taskKind: req.task.kind, taskId: req.task.id }), ...(req.session === undefined ? {} : { sessionId: req.session }) });

function reasonOf(p: PickResult, id: string | undefined): string {
  if (id === undefined) return `no account can run: ${JSON.stringify(p.skipped)}`;
  return `${id} cannot run: ${p.skipped[id] ?? "not in the pool"}`;
}

export async function runPass(req: PassRequest, deps: RunDeps): Promise<PassResult> {
  if ((req.pool === undefined) === (req.account === undefined)) throw new Error("a pass needs exactly one of pool and account");
  if (!isSupported(req.runner)) throw new Error(`runner ${req.runner} is not supported yet`);
  if (req.session !== undefined) {
    checkSessionId(req.session);
    if (req.runner !== "pi") throw new Error(`${req.runner} cannot keep a session yet; only pi can`);
  }
  const nowFn = deps.now ?? (() => new Date());
  const log = deps.log ?? makeLog();
  const { store } = deps;
  const db = store.db;

  const { named, list } = resolveCandidates(req, deps, nowFn());
  // The breaker looks at a whole pool only: a named account gets its own, exact refusal below.
  if (named === undefined && scopeState(list) === "open") {
    return noAccount(store, req, deps, nowFn(), { kind: "no-account", code: "", message: `breaker open: every ${req.runner} account is cooling or dead` });
  }
  // A session runs on the account that started it, and on no other: its transcript may hold that account's provider state.
  const pinned = req.session === undefined ? undefined : getSession(db, req.runner, req.session);
  if (pinned !== undefined && named !== undefined && named !== pinned.account) {
    return noAccount(store, req, deps, nowFn(), { kind: "no-account", code: "", message: `session ${req.session} is pinned to ${pinned.account}; it cannot run on ${named}` });
  }
  const picked = pick(pinned === undefined ? list : list.filter((c) => c.account === pinned.account), nowFn().getTime());
  if (picked.order.length === 0) {
    if (pinned !== undefined) return noAccount(store, req, deps, nowFn(), { kind: "no-account", code: "", message: `session ${req.session} is pinned to ${pinned.account}, which cannot run: ${picked.skipped[pinned.account] ?? "not in the pool"}` });
    if (named !== undefined && picked.skipped[named] === "busy") return noAccount(store, req, deps, nowFn(), { kind: "busy", code: "", message: `${named} is busy` });
    return noAccount(store, req, deps, nowFn(), { kind: "no-account", code: "", message: reasonOf(picked, named) });
  }

  for (const id of picked.order) {
    const account = getAccount(db, id)!;
    const passId = ulid(nowFn().getTime());
    const started = nowFn();
    store.startPass({ id: passId, startedAt: started.toISOString(), project: deps.project, flow: req.caller.flow, action: req.caller.action, runner: req.runner, model: req.model, account: id, ...taskOf(req) });

    // codex's last-message file goes to a fresh folder outside the home, removed after the pass.
    const outDir = req.runner === "codex" ? mkdtempSync(join(tmpdir(), "squad-out-")) : null;

    // A new session starts with an empty folder and is pinned to the account that really runs it.
    const sessionPath = req.session === undefined ? null : sessionDir(deps.home, req.runner, id, req.session);
    const run = (dir: string): Promise<Spawned> => {
      if (sessionPath !== null && req.session !== undefined) {
        if (pinned === undefined) {
          rmSync(sessionPath, { recursive: true, force: true });
          pinSession(db, req.runner, req.session, id, started);
        }
        mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
        chmodSync(sessionPath, 0o700);
      }
      const cli = RUNNER_SPECS[req.runner].cli({ model: req.model, prompt: req.prompt, cwd: req.cwd, ...(outDir === null ? {} : { outDir }), ...(req.session === undefined ? {} : { sessionId: req.session }) });
      // docker makes a missing mount target as an empty root-owned file inside the login folder.
      // An empty user file in its place is what codex would see anyway under the read-only guard.
      if (req.runner === "codex") ensureEmptyFile(join(dir, "config.toml"));
      const plan: PassPlan = {
        runner: req.runner,
        image: IMAGES[req.runner].tag,
        name: `squad-${passId.toLowerCase()}`,
        passId,
        caller: { project: deps.project, flow: req.caller.flow },
        user: deps.user,
        cwd: req.cwd,
        gitDir: req.gitDir ?? join(req.cwd, ".git"),
        mounts: cli.mounts,
        overlays: req.runner === "codex" ? [{ host: CODEX_CONFIG_GUARD, container: "/codex/config.toml" }] : [],
        session: sessionPath === null ? null : { dir: sessionPath },
        account: { name: account.name, kind: account.kind, dir },
        lockFile: account.kind === "login" ? lockPathOf(deps.home, account) : null,
        identity: deps.identity,
        ghDir: null,
        home: deps.home.root,
        env: req.env ?? {},
        args: cli.args,
      };
      return spawnDocker(deps.docker ?? envOptional(SQUAD_DOCKER_ENV, deps.env) ?? "docker", dockerRunArgv(plan), plan.name, req.idleMs ?? DEFAULT_IDLE_MS, req.deadlineMs ?? DEFAULT_DEADLINE_MS, stopGraceS(deps.env), req.runner, cli.stdin);
    };

    let sp: Spawned;
    try {
      sp = account.kind === "key" ? await withKeyCopy(deps.home, account, run) : await run(accountDirOf(deps.home, account));
      if (outDir !== null) sp = withLastMessage(sp, outDir);
    } catch (e) {
      // The plan was refused or the copy failed: the pass row must not stay open.
      store.endPass({ id: passId, endedAt: nowFn().toISOString(), outcome: "fail", failKind: "provider", failCode: "setup", tokens: NO_TOKENS });
      throw e;
    } finally {
      if (outDir !== null) rmSync(outDir, { recursive: true, force: true });
    }

    if (sp.exitCode === EXIT_LOCK_BUSY && sp.stopped === undefined) {
      store.endPass({ id: passId, endedAt: nowFn().toISOString(), outcome: "busy", failKind: "busy", tokens: NO_TOKENS, exitCode: sp.exitCode });
      log.info("pass-busy", { pass: passId, account: id });
      // The CLI never ran, so a new session has not started on this account: let the next one take it.
      if (sessionPath !== null && req.session !== undefined && pinned === undefined) {
        deleteSession(db, req.runner, req.session);
        rmSync(sessionPath, { recursive: true, force: true });
      }
      continue;
    }

    const ended = nowFn();
    const failure = failureOf(sp.stream, sp.exitCode, sp.stopped, sp.stderrTail);
    const logPath = writeLog(deps.home, ended, passId, sp.raw);
    // Only a key account has a bill. The model is what the stream saw, else what we asked for.
    const cost = account.kind === "key" ? passCost(account.kind, sp.stream.model ?? req.model, sp.stream.usage, loadPrices(deps.home)) : null;
    store.endPass({
      id: passId,
      endedAt: ended.toISOString(),
      outcome: failure === undefined ? "ok" : "fail",
      ...(failure === undefined ? {} : { failKind: failure.kind, failCode: failure.code }),
      tokens: sp.stream.usage,
      ...(cost === null ? {} : cost),
      turns: sp.stream.turns,
      ...(sp.stream.model === null ? {} : { model: sp.stream.model }),
      ...(sp.exitCode === null ? {} : { exitCode: sp.exitCode }),
    });
    if (!envOn(SQUAD_NO_USAGE_EXPORT_ENV, deps.env)) {
      const total = Object.values(sp.stream.usage).reduce((a, b) => a + b, 0);
      // A refusal before any token has nothing for a viewer to count.
      const text = total === 0 ? "" : RUNNER_SPECS[req.runner].exportOf(sp.raw, sp.stream, { passId, project: deps.project, flow: req.caller.flow, action: req.caller.action, at: started, model: req.model });
      if (text !== "") writeUsageExport(deps.home, passId, text, log);
    }
    if (req.session !== undefined) {
      try {
        touchSession(db, req.runner, req.session, ended);
      } catch (e) {
        if (!isBusy(e)) throw e;
        log.warn("session-write-busy", { session: req.session, pass: passId });
      }
    }
    feedHealth(deps, log, id, passId, ended, failure, sp.stream);
    log.info("pass-end", { pass: passId, account: id, outcome: failure === undefined ? "ok" : failure.kind });
    return {
      passId,
      account: id,
      text: sp.stream.text,
      texts: sp.stream.texts,
      turns: sp.stream.turns,
      model: sp.stream.model,
      usage: sp.stream.usage,
      ...(failure === undefined ? {} : { failure }),
      logPath,
    };
  }
  return noAccount(store, req, deps, nowFn(), { kind: "no-account", code: "", message: "every account was busy" });
}


/** Writes health, state and event. A busy database loses the health update, not the pass: the next pass corrects it. */
function feedHealth(deps: RunDeps, log: Log, id: string, passId: string, at: Date, failure: Failure | undefined, stream: StreamOutcome): void {
  const db = deps.store.db;
  const change = applyOutcome(getHealth(db, id), { ...(failure === undefined ? {} : { failure }), ...(stream.room === undefined ? {} : { room: stream.room }) }, at, deps.env);
  try {
    putHealth(db, change.health);
    if (change.accountState === "dead") setState(db, id, "dead", change.event?.code, at);
  } catch (e) {
    if (!isBusy(e)) throw e;
    log.warn("health-write-busy", { account: id, pass: passId });
  }
  if (change.event !== undefined) deps.store.event({ at: at.toISOString(), kind: change.event.kind, account: id, code: change.event.code, passId });
}
