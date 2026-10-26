// Web logins: the owner logs in a codex account again from the page, in any state but moved or
// removed (the swap is under the account lock, so a running pass makes it `busy`). The server runs `codex login
// --device-auth` in a container with no terminal, reads the one-time code from its output, and shows
// it. The owner types the code at OpenAI. When the CLI exits 0, the same checks and move as
// `squad login` run (`finishLogin`).
//
// Everything lives in memory. A login that is running when the server stops is stopped, and its
// staging folder is removed. No answer and no log line holds a token, a file path of the account,
// or the CLI's raw output.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErrorCode, LoginStart, LoginState, LoginStatus } from "@squad/contract";
import { ACCOUNT_NAME, accountId, liveAccount, type AccountRow } from "../accounts/store.ts";
import { dockerKillArgv, dockerStopArgv, stopGraceS } from "../docker.ts";
import type { HomeLayout } from "../home.ts";
import { ulid } from "../ids.ts";
import { finishLogin, loginArgv } from "../login.ts";
import type { Log } from "../log.ts";
import { SQUAD_DOCKER_ENV, SQUAD_DRY_RUN_ENV, SQUAD_NO_WEB_LOGIN_ENV, envOn, envOptional } from "../settings.ts";
import type { Store } from "../store/db.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The only page the codex device login may send a person to. Anything else is not shown. */
export const DEVICE_URL = "https://auth.openai.com/codex/device";
const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The code lives 15 minutes (the CLI prints it). */
export const LOGIN_LIFE_MS = 15 * 60_000;
export const SHOW_WAIT_MS = 20_000;
/** A finished login stays readable this long, so the page can poll its last state. */
export const KEEP_MS = 30 * 60_000;
export const MAX_RUNNING = 4;
const MAX_OUTPUT = 16 * 1024;

export type Parsed = { readonly kind: "wait" } | { readonly kind: "bad" } | { readonly kind: "ready"; readonly verifyUrl: string; readonly userCode: string };

/**
 * Reads the CLI's printed instructions (see test/fixtures/captures/codex/login-device-auth.txt). Only
 * whole lines count, so a half-printed URL is never judged. A URL line must be exactly DEVICE_URL.
 */
export function parseDeviceOutput(raw: string): Parsed {
  const text = raw.replace(ANSI, "");
  const whole = text.slice(0, text.lastIndexOf("\n") + 1);
  let verifyUrl: string | undefined;
  let userCode: string | undefined;
  for (const line of whole.split("\n")) {
    const t = line.trim();
    if (/https?:\/\//i.test(t)) {
      if (t !== DEVICE_URL) return { kind: "bad" };
      verifyUrl = t;
    } else if (userCode === undefined && CODE.test(t)) userCode = t;
  }
  return verifyUrl !== undefined && userCode !== undefined ? { kind: "ready", verifyUrl, userCode } : { kind: "wait" };
}

export class LoginRefused extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A running `docker run`: its stdout, and its exit code. */
export interface LoginProc {
  onStdout(cb: (chunk: string) => void): void;
  readonly exited: Promise<number>;
}
export interface LoginTimers {
  after(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export interface LoginRunner {
  start(argv: string[], name: string): LoginProc;
  /** Stop before kill. Resolves when the container is stopped or gone. */
  stop(name: string): Promise<void>;
}

const realTimers: LoginTimers = { after: (fn, ms) => setTimeout(fn, ms).unref(), clear: (h) => clearTimeout(h as NodeJS.Timeout) };

/** The real docker. stderr is dropped: it could hold anything the CLI prints. */
export function dockerLoginRunner(env: Env, docker: string = envOptional(SQUAD_DOCKER_ENV, env)!): LoginRunner {
  return {
    start: (argv) => {
      const child = spawn(docker, argv, { stdio: ["ignore", "pipe", "ignore"] });
      let cb: (s: string) => void = () => {};
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (s: string) => cb(s));
      const exited = new Promise<number>((resolve) => {
        child.on("error", () => resolve(1));
        child.on("close", (code) => resolve(code ?? 1));
      });
      return { onStdout: (f) => { cb = f; }, exited };
    },
    stop: (name) => new Promise<void>((resolve) => {
      const kill = (): void => {
        spawn(docker, dockerKillArgv(name), { stdio: "ignore" }).on("error", () => {}).on("close", () => resolve());
      };
      const s = spawn(docker, dockerStopArgv(name, stopGraceS(env)), { stdio: "ignore" });
      s.on("error", kill);
      s.on("close", (code) => (code === 0 ? resolve() : kill()));
    }),
  };
}

export interface DeviceLoginDeps extends LoginRunner {
  readonly env: Env;
  readonly home: HomeLayout;
  readonly store: Store;
  readonly log: Log;
  readonly now: () => Date;
  readonly user: { readonly uid: number; readonly gid: number } | null;
  readonly docker: string;
  readonly timers?: LoginTimers;
}

/** What a login is for: an account row, or the id and name of one that does not exist yet. */
type Target = Pick<AccountRow, "id" | "name" | "loginEmail">;

interface Entry {
  readonly id: string;
  readonly owner: string;
  /** The email as the person signed in with it; a new account stores it. */
  readonly ownerAs: string;
  readonly account: Target;
  /** A new account from the web: it does not exist until the login ends well. */
  readonly add: boolean;
  readonly name: string;
  readonly staging: string;
  readonly cwd: string;
  state: "starting" | LoginState;
  reason?: string;
  finishedAt?: number;
  finishing?: Promise<void>;
  timer?: unknown;
  /** Fails a start that is still waiting for the code. */
  abort?: (msg: string) => void;
}

export class DeviceLogins {
  private readonly d: DeviceLoginDeps;
  private readonly t: LoginTimers;
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(d: DeviceLoginDeps) {
    this.d = d;
    this.t = d.timers ?? realTimers;
  }

  private live(e: Entry): boolean {
    return e.state === "starting" || e.state === "pending";
  }

  private sweep(): void {
    const now = this.d.now().getTime();
    for (const [id, e] of this.entries) if (e.finishedAt !== undefined && now - e.finishedAt > KEEP_MS) this.entries.delete(id);
  }

  /** A re-login of the owner's own account. A good end clears its health and is their consent. */
  start(email: string, a: AccountRow): Promise<LoginStart> {
    return this.begin(email, a, false);
  }

  /** A login for a NEW codex account. The person owns it; the seat's email comes from the login. */
  startAdd(email: string, name: string): Promise<LoginStart> {
    if (!ACCOUNT_NAME.test(name)) return Promise.reject(new LoginRefused(400, "bad-request", "the name must be lower-case letters, digits, dot, dash or underscore, and start with a letter or digit"));
    const id = accountId("codex", name);
    if (liveAccount(this.d.store.db, id) !== undefined) return Promise.reject(new LoginRefused(409, "conflict", "an account with this name exists"));
    return this.begin(email, { id, name, loginEmail: null }, true);
  }

  private async begin(email: string, a: Target, add: boolean): Promise<LoginStart> {
    const { env, home, log } = this.d;
    if (envOn(SQUAD_NO_WEB_LOGIN_ENV, env)) throw new LoginRefused(501, "disabled", "web login is off (SQUAD_NO_WEB_LOGIN=1)");
    // A dry run starts nothing, and a login with no container cannot show a code.
    if (envOn(SQUAD_DRY_RUN_ENV, env)) throw new LoginRefused(501, "disabled", "web login starts no container while SQUAD_DRY_RUN=1");
    if (!add) {
      const row = a as AccountRow;
      if (row.runner !== "codex" || row.kind !== "login") throw new LoginRefused(400, "bad-request", `web login is for codex login accounts only: run \`squad login ${a.name}\` on the host`);
      // A live login may be replaced: finishLogin swaps it under the account lock, so a pass makes it busy.
      if (row.state === "moved" || row.state === "removed") throw new LoginRefused(409, "conflict", `the account is ${row.state}`);
    }
    if (this.closed) throw new LoginRefused(501, "disabled", "the server is stopping");
    this.sweep();
    const prev = [...this.entries.values()].find((e) => this.live(e) && e.account.id === a.id);
    if (prev !== undefined) {
      // A closed page leaves its login waiting. The same person may start again; the old one stops.
      if (prev.owner !== email.toLowerCase() || prev.state !== "pending" || prev.finishing !== undefined) throw new LoginRefused(409, "conflict", "a login is already running for this account");
      this.end(prev, "expired");
      void this.halt(prev, false);
    }
    const running = [...this.entries.values()].filter((e) => this.live(e));
    if (running.length >= MAX_RUNNING) throw new LoginRefused(409, "conflict", "too many logins are running: try again soon");

    const passId = ulid(this.d.now().getTime());
    const id = randomBytes(16).toString("base64url");
    const staging = join(home.staging, passId);
    const cwd = join(tmpdir(), `squad-login-${passId}`);
    const argv = loginArgv("codex", { cwd, passId, project: "squad-web", user: this.d.user, home: home.root, staging, name: a.name, tty: false });
    const name = argv[argv.indexOf("--name") + 1]!;
    const e: Entry = { id, owner: email.toLowerCase(), ownerAs: email, account: a, add, name, staging, cwd, state: "starting" };
    this.entries.set(id, e);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });

    const proc = this.d.start(argv, name);
    log.info("web_login_started", { account: a.id, login: id });
    const shown = new Promise<LoginStart>((resolve, reject) => {
      let buf = "";
      let exited = false;
      const fail = (msg: string): void => {
        if (e.state !== "starting") return;
        this.t.clear(e.timer);
        this.entries.delete(id);
        log.warn("web_login_start_failed", { account: a.id, login: id });
        void this.halt(e, exited);
        reject(new LoginRefused(502, "internal", `the login did not start: ${msg}`));
      };
      e.abort = fail;
      e.timer = this.t.after(() => fail("no code in time"), SHOW_WAIT_MS);
      proc.onStdout((chunk) => {
        if (e.state !== "starting") return;
        buf += chunk;
        const got = parseDeviceOutput(buf);
        if (got.kind === "bad") return fail("unexpected-output");
        if (got.kind === "wait") return buf.length > MAX_OUTPUT ? fail("unexpected-output") : undefined;
        this.t.clear(e.timer);
        e.state = "pending";
        e.timer = this.t.after(() => void this.expire(e), LOGIN_LIFE_MS);
        resolve({ loginId: id, userCode: got.userCode, verifyUrl: got.verifyUrl, expiresAt: new Date(this.d.now().getTime() + LOGIN_LIFE_MS).toISOString() });
      });
      void proc.exited.then((code) => {
        exited = true;
        if (e.state === "starting") return fail("the login ended early");
        void this.onExit(e, code);
      });
    });
    return shown;
  }

  status(email: string, loginId: string): LoginStatus {
    this.sweep();
    const e = this.entries.get(loginId);
    if (e === undefined || e.owner !== email.toLowerCase()) throw new LoginRefused(404, "not-found", "no such login");
    const state: LoginState = e.state === "starting" ? "pending" : e.state;
    return { loginId, state, ...(e.reason === undefined ? {} : { reason: e.reason }) };
  }

  private end(e: Entry, state: LoginState, reason?: string): void {
    e.state = state;
    if (reason !== undefined) e.reason = reason;
    e.finishedAt = this.d.now().getTime();
    this.d.log.info(`web_login_${state}`, { account: e.account.id, login: e.id, ...(reason === undefined ? {} : { reason }) });
  }

  private clean(e: Entry): void {
    rmSync(e.staging, { recursive: true, force: true });
    rmSync(e.cwd, { recursive: true, force: true });
  }

  /** Stops the container (stop before kill) and removes the folders. */
  private async halt(e: Entry, alreadyExited: boolean): Promise<void> {
    this.t.clear(e.timer);
    if (!alreadyExited) await this.d.stop(e.name).catch(() => {});
    this.clean(e);
  }

  private async expire(e: Entry): Promise<void> {
    if (e.state !== "pending" || e.finishing !== undefined) return;
    this.end(e, "expired");
    await this.halt(e, false);
  }

  private onExit(e: Entry, code: number): Promise<void> {
    if (e.state !== "pending") {
      this.clean(e);
      return Promise.resolve();
    }
    this.t.clear(e.timer);
    const run = async (): Promise<void> => {
      if (code !== 0) {
        this.clean(e);
        return this.end(e, "failed", "login-failed");
      }
      try {
        // A row with a known seat is checked by seat; a legacy row with none keeps the owner check.
        const check = e.add ? { addFor: e.ownerAs } : { ...(e.account.loginEmail === null ? { owner: e.owner } : {}), consentBy: e.owner };
        const r = await finishLogin({ store: this.d.store, home: this.d.home, runner: "codex", name: e.account.name, staging: e.staging, ...check, now: this.d.now() });
        if (r.ok) this.end(e, "done");
        else this.end(e, "failed", r.reason === "empty" ? "login-failed" : r.reason);
      } catch {
        this.end(e, "failed", "login-failed");
      }
      this.clean(e);
    };
    e.finishing = run();
    return e.finishing;
  }

  /** Stops every running login and clears the timers. A move that already began is let finish. */
  async close(): Promise<void> {
    this.closed = true;
    const jobs: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      if (e.finishing !== undefined) jobs.push(e.finishing);
      else if (e.state === "starting") e.abort?.("the server is stopping");
      else if (e.state === "pending") {
        this.end(e, "expired");
        jobs.push(this.halt(e, false));
      }
    }
    await Promise.all(jobs);
  }
}
