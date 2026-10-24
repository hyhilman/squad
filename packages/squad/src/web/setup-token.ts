// Web logins for a claude token account: the owner adds a claude seat from the page. The server runs
// `claude setup-token` in a container under a pseudo-terminal (the CLI prints nothing without one),
// reads the sign-in link from its output, and shows it. The owner signs in at claude.com, and pastes
// the code that page shows. The server types the code into the CLI. The CLI then prints a long-lived
// token; the server writes it as a token account and forgets it.
//
// The sign-in link is checked against an exact allowlist. The token is matched only by its exact
// shape. Everything lives in memory. No answer and no log line holds the code, the token or the CLI's
// raw output.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginStart, LoginState, LoginStatus } from "@squad/contract";
import { AccountExists, createFileAccount } from "../accounts/add.ts";
import { ACCOUNT_NAME, accountId, getAccount } from "../accounts/store.ts";
import type { HomeLayout } from "../home.ts";
import { ulid } from "../ids.ts";
import { loginArgv } from "../login.ts";
import type { Log } from "../log.ts";
import { SQUAD_DOCKER_ENV, SQUAD_DRY_RUN_ENV, SQUAD_NO_WEB_LOGIN_ENV, envOn, envOptional } from "../settings.ts";
import type { Store } from "../store/db.ts";
import { KEEP_MS, LOGIN_LIFE_MS, LoginRefused, MAX_RUNNING, dockerLoginRunner, type LoginTimers } from "./device-login.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The only page the setup-token sign-in may send a person to. */
const AUTH_HOST = "claude.com";
const AUTH_PATH = "/cai/oauth/authorize";
/** The CLI starts and prints its link within this time. */
export const LINK_WAIT_MS = 30_000;
/** After the code is typed, the token must come within this time. */
export const TOKEN_WAIT_MS = 60_000;
/** The CLI's input box takes a pasted chunk as text; Enter must come as its own key press after it. */
export const ENTER_DELAY_MS = 250;
/** What is kept of the output before the link, and of the output after the code. */
const MAX_BEFORE = 64 * 1024;
const MAX_AFTER = 16 * 1024;
/** The terminal is wide, so the CLI does not wrap the link. */
const COLS = 400;
const ROWS = 50;

const TOKEN_SHAPE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g;
const TOKEN_CHAR = /[A-Za-z0-9_-]/;
const CODE_SHAPE = /^[\x21-\x7e]{1,512}$/;

/**
 * Plain text from terminal output. A cursor move takes the place of a space in the CLI's UI, so
 * the prose loses its spaces: callers match on a URL or a token, never on prose. `sep` stands where an
 * escape sequence was.
 */
function strip(raw: string, sep: string): string {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, sep)
    .replace(/\u001b\[[0-9;?<=>]*[ -/]*[@-~]/g, sep)
    .replace(/\u001b[()#][0-9A-Za-z]|\u001b[@-Z\\-_]/g, sep)
    .replace(/\r\n|\r/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, sep);
}

export type Parsed = { readonly kind: "wait" } | { readonly kind: "bad" } | { readonly kind: "ready"; readonly url: string };

const allowedUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname === AUTH_HOST && u.port === "" && u.username === "" && u.password === "" && u.pathname === AUTH_PATH && u.hash === "";
  } catch {
    return false;
  }
};

/**
 * Finds the sign-in link in the CLI's output. Only whole lines count, so a half-printed link is never
 * judged. Every link in the output must pass the allowlist; one that does not is `bad`.
 */
export function parseSetupOutput(raw: string): Parsed {
  const text = strip(raw, "");
  const whole = text.slice(0, text.lastIndexOf("\n") + 1);
  let url: string | undefined;
  for (const m of whole.matchAll(/[a-z][a-z0-9+.-]*:\/\/\S*/gi)) {
    if (!allowedUrl(m[0])) return { kind: "bad" };
    url = m[0];
  }
  return url === undefined ? { kind: "wait" } : { kind: "ready", url };
}

/**
 * The token the CLI printed, by its exact shape. It must be whole: followed by something that cannot be
 * in a token, or (`ended`) the output has ended. No other text is read.
 */
export function findToken(raw: string, ended: boolean): string | undefined {
  const text = strip(raw, "\u0001");
  for (const m of text.matchAll(TOKEN_SHAPE)) {
    const next = text[m.index + m[0].length];
    if (next === undefined ? ended : !TOKEN_CHAR.test(next)) return m[0];
  }
  return undefined;
}

/** Why a pasted code is refused by shape, or undefined. The text never holds the value. */
export function codeShapeError(v: unknown): string | undefined {
  return typeof v === "string" && CODE_SHAPE.test(v) ? undefined : "the code must be 1 to 512 visible characters with no space";
}

/** A running `docker run -it` behind a pseudo-terminal: its output, a way to type, and its exit code. */
export interface PtyProc {
  onOutput(cb: (chunk: string) => void): void;
  write(s: string): void;
  readonly exited: Promise<number>;
}
export interface PtyRunner {
  start(argv: string[], name: string): PtyProc;
  /** Stop before kill. Resolves when the container is stopped or gone. */
  stop(name: string): Promise<void>;
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** The shell line `script` runs: the terminal size is set first, so the CLI sees a wide screen. */
export const ptyCommand = (docker: string, argv: readonly string[]): string => `stty cols ${COLS} rows ${ROWS}; exec ${[docker, ...argv].map(quote).join(" ")}`;

/** The real docker, behind util-linux `script`. stderr is dropped: it could hold anything the CLI prints. */
export function dockerPtyRunner(env: Env, docker: string = envOptional(SQUAD_DOCKER_ENV, env)!): PtyRunner {
  const base = dockerLoginRunner(env, docker);
  const children = new Map<string, ReturnType<typeof spawn>>();
  return {
    start: (argv, name) => {
      const child = spawn("script", ["-qfc", ptyCommand(docker, argv), "/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
      children.set(name, child);
      let cb: (s: string) => void = () => {};
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (s: string) => cb(s));
      child.stdin!.on("error", () => {});
      const exited = new Promise<number>((resolve) => {
        child.on("error", () => resolve(1));
        child.on("close", (code) => {
          children.delete(name);
          resolve(code ?? 1);
        });
      });
      return { onOutput: (f) => { cb = f; }, write: (s) => void child.stdin!.write(s), exited };
    },
    stop: async (name) => {
      await base.stop(name);
      children.get(name)?.kill();
    },
  };
}

export interface SetupTokenDeps extends PtyRunner {
  readonly env: Env;
  readonly home: HomeLayout;
  readonly store: Store;
  readonly log: Log;
  readonly now: () => Date;
  readonly user: { readonly uid: number; readonly gid: number } | null;
  readonly docker: string;
  readonly timers?: LoginTimers;
}

interface Entry {
  readonly id: string;
  readonly owner: string;
  readonly ownerAs: string;
  /** The account name; the account does not exist until the token comes. */
  readonly name: string;
  readonly accountId: string;
  readonly container: string;
  readonly staging: string;
  readonly cwd: string;
  readonly proc: PtyProc;
  state: "starting" | LoginState;
  reason?: string;
  finishedAt?: number;
  finishing?: Promise<void>;
  /** The code was typed. */
  sent: boolean;
  /** The CLI's output since the code was typed (a tail). Emptied when the login ends. */
  tail: string;
  life?: unknown;
  step?: unknown;
  abort?: (msg: string) => void;
}

const realTimers: LoginTimers = { after: (fn, ms) => setTimeout(fn, ms).unref(), clear: (h) => clearTimeout(h as NodeJS.Timeout) };

export class SetupTokenLogins {
  private readonly d: SetupTokenDeps;
  private readonly t: LoginTimers;
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(d: SetupTokenDeps) {
    this.d = d;
    this.t = d.timers ?? realTimers;
  }

  private clr(h: unknown): void {
    if (h !== undefined) this.t.clear(h);
  }

  private live(e: Entry): boolean {
    return e.state === "starting" || e.state === "pending";
  }

  private sweep(): void {
    const now = this.d.now().getTime();
    for (const [id, e] of this.entries) if (e.finishedAt !== undefined && now - e.finishedAt > KEEP_MS) this.entries.delete(id);
  }

  /** A login for a NEW claude token account. The person owns it. */
  start(email: string, name: string): Promise<LoginStart> {
    const { env, home, log } = this.d;
    if (envOn(SQUAD_NO_WEB_LOGIN_ENV, env)) return Promise.reject(new LoginRefused(501, "disabled", "web login is off (SQUAD_NO_WEB_LOGIN=1)"));
    if (envOn(SQUAD_DRY_RUN_ENV, env)) return Promise.reject(new LoginRefused(501, "disabled", "web login starts no container while SQUAD_DRY_RUN=1"));
    if (!ACCOUNT_NAME.test(name)) return Promise.reject(new LoginRefused(400, "bad-request", "the name must be lower-case letters, digits, dot, dash or underscore, and start with a letter or digit"));
    if (this.closed) return Promise.reject(new LoginRefused(501, "disabled", "the server is stopping"));
    const aid = accountId("claude", name);
    if (getAccount(this.d.store.db, aid) !== undefined) return Promise.reject(new LoginRefused(409, "conflict", "an account with this name exists"));
    this.sweep();
    const running = [...this.entries.values()].filter((e) => this.live(e));
    if (running.some((e) => e.accountId === aid)) return Promise.reject(new LoginRefused(409, "conflict", "a login is already running for this account"));
    if (running.length >= MAX_RUNNING) return Promise.reject(new LoginRefused(409, "conflict", "too many logins are running: try again soon"));

    const passId = ulid(this.d.now().getTime());
    const id = randomBytes(16).toString("base64url");
    const staging = join(home.staging, passId);
    const cwd = join(tmpdir(), `squad-login-${passId}`);
    const argv = loginArgv("claude", {
      cwd, passId, project: "squad-web", user: this.d.user, home: home.root, staging, name, tty: true,
      args: ["setup-token"], env: { COLUMNS: String(COLS), LINES: String(ROWS) },
    });
    const container = argv[argv.indexOf("--name") + 1]!;
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    const proc = this.d.start(argv, container);
    const e: Entry = { id, owner: email.toLowerCase(), ownerAs: email, name, accountId: aid, container, staging, cwd, proc, state: "starting", sent: false, tail: "" };
    this.entries.set(id, e);
    log.info("web_login_started", { account: aid, login: id });

    return new Promise<LoginStart>((resolve, reject) => {
      let buf = "";
      let exited = false;
      const fail = (msg: string): void => {
        if (e.state !== "starting") return;
        this.clr(e.step);
        this.entries.delete(id);
        log.warn("web_login_start_failed", { account: aid, login: id });
        void this.halt(e, exited);
        reject(new LoginRefused(502, "internal", `the login did not start: ${msg}`));
      };
      e.abort = fail;
      e.step = this.t.after(() => fail("no link in time"), LINK_WAIT_MS);
      proc.onOutput((chunk) => {
        if (e.state === "starting") {
          buf += chunk;
          const got = parseSetupOutput(buf);
          if (got.kind === "bad") return fail("unexpected-output");
          if (got.kind === "wait") return buf.length > MAX_BEFORE ? fail("unexpected-output") : undefined;
          buf = "";
          this.clr(e.step);
          e.state = "pending";
          e.life = this.t.after(() => void this.expire(e), LOGIN_LIFE_MS);
          resolve({ loginId: id, verifyUrl: got.url, needsCode: true, expiresAt: new Date(this.d.now().getTime() + LOGIN_LIFE_MS).toISOString() });
        } else if (e.state === "pending" && e.sent && e.finishing === undefined) {
          e.tail = (e.tail + chunk).slice(-MAX_AFTER);
          const token = findToken(e.tail, false);
          if (token !== undefined) this.succeed(e, token);
        }
      });
      void proc.exited.then((code) => {
        exited = true;
        if (e.state === "starting") return fail("the login ended early");
        this.onExit(e, code);
      });
    });
  }

  private mine(email: string, loginId: string): Entry {
    this.sweep();
    const e = this.entries.get(loginId);
    if (e === undefined || e.owner !== email.toLowerCase()) throw new LoginRefused(404, "not-found", "no such login");
    return e;
  }

  status(email: string, loginId: string): LoginStatus {
    const e = this.mine(email, loginId);
    const state: LoginState = e.state === "starting" ? "pending" : e.state;
    return { loginId, state, ...(e.reason === undefined ? {} : { reason: e.reason }) };
  }

  /** Types the code the sign-in page showed into the CLI. One try. The code is not kept or logged. */
  submitCode(email: string, loginId: string, code: string): LoginStatus {
    const e = this.mine(email, loginId);
    if (codeShapeError(code) !== undefined) throw new LoginRefused(400, "bad-request", "the code has a wrong shape");
    if (e.state !== "pending" || e.finishing !== undefined) throw new LoginRefused(409, "conflict", "the login is not waiting for a code");
    if (e.sent) throw new LoginRefused(409, "conflict", "a code was already sent");
    e.sent = true;
    e.proc.write(code);
    this.t.after(() => { if (e.state === "pending") e.proc.write("\r"); }, ENTER_DELAY_MS);
    e.step = this.t.after(() => void this.noToken(e), TOKEN_WAIT_MS);
    this.d.log.info("web_login_code_sent", { account: e.accountId, login: e.id });
    return { loginId, state: "pending" };
  }

  private end(e: Entry, state: LoginState, reason?: string): void {
    e.state = state;
    if (reason !== undefined) e.reason = reason;
    e.finishedAt = this.d.now().getTime();
    e.tail = "";
    this.d.log.info(`web_login_${state}`, { account: e.accountId, login: e.id, ...(reason === undefined ? {} : { reason }) });
  }

  private clean(e: Entry): void {
    rmSync(e.staging, { recursive: true, force: true });
    rmSync(e.cwd, { recursive: true, force: true });
  }

  private async halt(e: Entry, alreadyExited: boolean): Promise<void> {
    this.clr(e.life);
    this.clr(e.step);
    if (!alreadyExited) await this.d.stop(e.container).catch(() => {});
    this.clean(e);
  }

  /** The token came: write the account, then stop the container. The token is not kept. */
  private succeed(e: Entry, token: string): void {
    if (e.state !== "pending" || e.finishing !== undefined) return;
    this.clr(e.life);
    this.clr(e.step);
    try {
      createFileAccount(this.d.store.db, this.d.home, { runner: "claude", name: e.name, kind: "token", ownerEmail: e.ownerAs.toLowerCase() }, [{ name: "token", body: token }], this.d.now());
      this.end(e, "done");
    } catch (err) {
      this.end(e, "failed", "login-failed");
      if (!(err instanceof AccountExists)) this.d.log.error("web_login_account_failed", { account: e.accountId, login: e.id });
    }
    e.finishing = this.halt(e, false);
  }

  private fail(e: Entry): Promise<void> {
    this.end(e, "failed", "login-failed");
    return this.halt(e, false);
  }

  /**
   * Keeps what the CLI printed after the code, so a change in its output can be seen. Every run of 20
   * or more token characters is replaced, so no token, code or key can be in the file.
   */
  private trace(e: Entry): void {
    try {
      const dir = join(this.d.home.state, "debug");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const text = strip(e.tail, " ").replace(/sk-ant[A-Za-z0-9_-]*/g, "[token?]").replace(/[A-Za-z0-9_-]{20,}/g, "[long]").replace(/[ \t]+/g, " ");
      writeFileSync(join(dir, `setup-token-${e.id}.txt`), text, { mode: 0o600 });
    } catch {
      // A trace is a help, never a reason for the login to fail differently.
    }
  }

  private noToken(e: Entry): Promise<void> {
    if (e.state !== "pending" || e.finishing !== undefined) return Promise.resolve();
    this.trace(e);
    e.finishing = this.fail(e);
    return e.finishing;
  }

  private async expire(e: Entry): Promise<void> {
    if (e.state !== "pending" || e.finishing !== undefined) return;
    this.end(e, "expired");
    e.finishing = this.halt(e, false);
    await e.finishing;
  }

  private onExit(e: Entry, code: number): void {
    if (e.state !== "pending" || e.finishing !== undefined) {
      this.clean(e);
      return;
    }
    // The CLI ended: a token that was the last thing it printed has no terminator, so the end counts.
    const token = e.sent && code === 0 ? findToken(e.tail, true) : undefined;
    if (token !== undefined) {
      this.succeed(e, token);
      return;
    }
    this.clr(e.life);
    this.clr(e.step);
    if (e.sent) this.trace(e);
    this.end(e, "failed", "login-failed");
    this.clean(e);
  }

  /** Stops every running login and clears the timers. */
  async close(): Promise<void> {
    this.closed = true;
    const jobs: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      if (e.finishing !== undefined) jobs.push(e.finishing);
      else if (e.state === "starting") e.abort?.("the server is stopping");
      else if (e.state === "pending") {
        this.end(e, "expired");
        e.finishing = this.halt(e, false);
        jobs.push(e.finishing);
      }
    }
    await Promise.all(jobs);
  }
}
