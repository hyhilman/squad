// Web logins for a claude token account: the owner adds a claude seat from the page. The server runs
// `claude setup-token` in a container under a pseudo-terminal (the CLI prints nothing without one).
// The CLI gives its sign-in URL to $BROWSER; the image's squad-browser writes it into the mounted
// throwaway folder, and the server builds the link it shows from it. The owner signs in at claude.com,
// and pastes the code that page shows. The server types the code into the CLI. The CLI then prints a
// long-lived token; the server writes it as a token account and forgets it.
//
// The sign-in link is checked against an exact allowlist. The token is matched only by its exact
// shape. Everything lives in memory. No answer and no log line holds the code, the token or the CLI's
// raw output.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAccountUserEmail, type LoginStart, type LoginState, type LoginStatus } from "@squad/contract";
import { identityOf } from "../accounts/identity.ts";
import { AccountExists, createFileAccount } from "../accounts/add.ts";
import { replaceToken } from "../accounts/care.ts";
import { ACCOUNT_NAME, accountId, getAccount, liveAccount, setLoginEmail, type AccountRow } from "../accounts/store.ts";
import { MAX_OPENED, codeShapeError, findToken, linkFromOpened, maskedTrace, parseSetupOutput } from "../claude-token.ts";
import type { HomeLayout } from "../home.ts";
import { ulid } from "../ids.ts";
import { loginArgv } from "../login.ts";
import type { Log } from "../log.ts";
import { SQUAD_DOCKER_ENV, SQUAD_DRY_RUN_ENV, SQUAD_NO_WEB_LOGIN_ENV, envOn, envOptional } from "../settings.ts";
import type { Store } from "../store/db.ts";
import { KEEP_MS, LOGIN_LIFE_MS, LoginRefused, MAX_RUNNING, dockerLoginRunner, type LoginTimers } from "./device-login.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The CLI starts and gives its link within this time. */
export const LINK_WAIT_MS = 30_000;
/** After the code is typed, the token must come within this time. */
export const TOKEN_WAIT_MS = 60_000;
/** The CLI's input box takes a pasted chunk as text; Enter must come as its own key press after it. */
export const ENTER_DELAY_MS = 250;
/** How often the server looks for the opened URL in the staging folder. */
export const OPENED_POLL_MS = 400;
/** The screen showed a link but no file came: wait this long more, then use the screen link. */
export const SCREEN_GRACE_MS = 5_000;
/** The image's $BROWSER (images/claude/squad-browser), and the file it writes in /claude. */
export const BROWSER_SCRIPT = "/usr/local/bin/squad-browser";
export const OPENED_FILE = ".squad-opened-url";
/** What is kept of the output before the link, and of the output after the code. */
const MAX_BEFORE = 64 * 1024;
const MAX_AFTER = 16 * 1024;
/** The terminal is wide, so the CLI does not wrap the link or the token. */
export const COLS = 400;
export const ROWS = 50;

/**
 * The opened URL from the staging folder: undefined while there is none, "bad" when it is not a plain
 * small file. The container writes it, so a symlink is never followed.
 */
export function readOpened(dir: string): string | "bad" | undefined {
  let fd: number;
  try {
    fd = openSync(join(dir, OPENED_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "bad";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_OPENED) return "bad";
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export { codeShapeError } from "../claude-token.ts";

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
  /** The account name; a new account does not exist until the token comes. */
  readonly name: string;
  /** A new token for this existing account, in place of a new account. */
  readonly replace: boolean;
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

  /** A new token for the owner's own claude token account. A good end clears its health and is their consent. */
  startReplace(email: string, a: AccountRow): Promise<LoginStart> {
    if (a.runner !== "claude" || a.kind !== "token") return Promise.reject(new LoginRefused(400, "bad-request", "a new token is for a claude token account only"));
    if (a.state === "moved" || a.state === "removed") return Promise.reject(new LoginRefused(409, "conflict", `the account is ${a.state}`));
    return this.start(email, a.name, true);
  }

  /** A login for a NEW claude token account (or, with `replace`, a new token for one). The person owns it. */
  start(email: string, name: string, replace = false): Promise<LoginStart> {
    const { env, home, log } = this.d;
    if (envOn(SQUAD_NO_WEB_LOGIN_ENV, env)) return Promise.reject(new LoginRefused(501, "disabled", "web login is off (SQUAD_NO_WEB_LOGIN=1)"));
    if (envOn(SQUAD_DRY_RUN_ENV, env)) return Promise.reject(new LoginRefused(501, "disabled", "web login starts no container while SQUAD_DRY_RUN=1"));
    if (!ACCOUNT_NAME.test(name)) return Promise.reject(new LoginRefused(400, "bad-request", "the name must be lower-case letters, digits, dot, dash or underscore, and start with a letter or digit"));
    if (this.closed) return Promise.reject(new LoginRefused(501, "disabled", "the server is stopping"));
    const aid = accountId("claude", name);
    if (!replace && liveAccount(this.d.store.db, aid) !== undefined) return Promise.reject(new LoginRefused(409, "conflict", "an account with this name exists"));
    this.sweep();
    const prev = [...this.entries.values()].find((e) => this.live(e) && e.accountId === aid);
    if (prev !== undefined) {
      // A closed page leaves its login waiting. The same person may start again, and the old one
      // stops, but not once a code was sent: the token may be on its way.
      if (prev.owner !== email.toLowerCase() || prev.state !== "pending" || prev.sent || prev.finishing !== undefined) return Promise.reject(new LoginRefused(409, "conflict", "a login is already running for this account"));
      this.end(prev, "expired");
      void this.halt(prev, false);
    }
    const running = [...this.entries.values()].filter((e) => this.live(e));
    if (running.length >= MAX_RUNNING) return Promise.reject(new LoginRefused(409, "conflict", "too many logins are running: try again soon"));

    const passId = ulid(this.d.now().getTime());
    const id = randomBytes(16).toString("base64url");
    const staging = join(home.staging, passId);
    const cwd = join(tmpdir(), `squad-login-${passId}`);
    const argv = loginArgv("claude", {
      cwd, passId, project: "squad-web", user: this.d.user, home: home.root, staging, name, tty: true,
      args: ["setup-token"], env: { COLUMNS: String(COLS), LINES: String(ROWS), BROWSER: BROWSER_SCRIPT },
    });
    const container = argv[argv.indexOf("--name") + 1]!;
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    const proc = this.d.start(argv, container);
    const e: Entry = { id, owner: email.toLowerCase(), ownerAs: email, name, replace, accountId: aid, container, staging, cwd, proc, state: "starting", sent: false, tail: "" };
    this.entries.set(id, e);
    log.info("web_login_started", { account: aid, login: id });

    return new Promise<LoginStart>((resolve, reject) => {
      let buf = "";
      let exited = false;
      let screen: string | undefined;
      let poll: unknown;
      let grace: unknown;
      const fail = (msg: string): void => {
        if (e.state !== "starting") return;
        this.clr(e.step);
        this.clr(poll);
        this.clr(grace);
        this.entries.delete(id);
        log.warn("web_login_start_failed", { account: aid, login: id });
        void this.halt(e, exited);
        reject(new LoginRefused(502, "internal", `the login did not start: ${msg}`));
      };
      const ready = (url: string): void => {
        if (e.state !== "starting") return;
        buf = "";
        this.clr(e.step);
        this.clr(poll);
        this.clr(grace);
        e.state = "pending";
        e.life = this.t.after(() => void this.expire(e), LOGIN_LIFE_MS);
        resolve({ loginId: id, verifyUrl: url, needsCode: true, expiresAt: new Date(this.d.now().getTime() + LOGIN_LIFE_MS).toISOString() });
      };
      const look = (): void => {
        if (e.state !== "starting") return;
        const raw = readOpened(staging);
        if (raw === undefined) {
          poll = this.t.after(look, OPENED_POLL_MS);
          return;
        }
        // A file that is there but wrong is not the CLI's: the screen is no fallback then.
        const url = raw === "bad" ? undefined : linkFromOpened(raw);
        if (url === undefined) return fail("unexpected-output");
        ready(url);
      };
      e.abort = fail;
      e.step = this.t.after(() => fail("no link in time"), LINK_WAIT_MS);
      poll = this.t.after(look, OPENED_POLL_MS);
      proc.onOutput((chunk) => {
        if (e.state === "starting") {
          if (screen !== undefined) return;
          buf += chunk;
          const got = parseSetupOutput(buf);
          if (got.kind === "bad") return fail("unexpected-output");
          if (got.kind === "wait") return buf.length > MAX_BEFORE ? fail("unexpected-output") : undefined;
          screen = got.url;
          grace = this.t.after(() => {
            if (e.state !== "starting") return;
            log.warn("setup_link_from_screen", { account: aid, login: id });
            ready(got.url);
          }, SCREEN_GRACE_MS);
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

  /** Runs once the CLI has ended or was stopped. */
  private clean(e: Entry): void {
    // The CLI may write its config as it exits, so the account user is read again here, before the
    // folder goes.
    if (e.state === "done" && existsSync(e.staging)) {
      const seat = this.seatOf(e);
      if (seat !== undefined) setLoginEmail(this.d.store.db, e.accountId, seat);
    }
    rmSync(e.staging, { recursive: true, force: true });
    rmSync(e.cwd, { recursive: true, force: true });
  }

  private async halt(e: Entry, alreadyExited: boolean): Promise<void> {
    this.clr(e.life);
    this.clr(e.step);
    if (!alreadyExited) await this.d.stop(e.container).catch(() => {});
    this.clean(e);
  }

  /** The seat's email from the CLI's throwaway config (CLAUDE_CONFIG_DIR=/claude, the staging folder). No call to the provider. */
  private seatOf(e: Entry): string | undefined {
    const seat = identityOf("claude", "login", e.staging)?.email;
    return isAccountUserEmail(seat) ? seat : undefined;
  }

  /** The token came: write the account, then stop the container. The token is not kept. */
  private succeed(e: Entry, token: string): void {
    if (e.state !== "pending" || e.finishing !== undefined) return;
    this.clr(e.life);
    this.clr(e.step);
    try {
      const row = e.replace ? getAccount(this.d.store.db, e.accountId) : undefined;
      if (e.replace && (row === undefined || row.state === "removed" || row.ownerEmail?.toLowerCase() !== e.owner)) throw new AccountExists("the account is gone");
      const loginEmail = this.seatOf(e);
      if (row !== undefined) replaceToken(this.d.store, this.d.home, row, token, e.owner, this.d.now(), loginEmail ?? null);
      else createFileAccount(this.d.store.db, this.d.home, { runner: "claude", name: e.name, kind: "token", ownerEmail: e.ownerAs.toLowerCase(), ...(loginEmail === undefined ? {} : { loginEmail }), consent: { by: e.ownerAs.toLowerCase() } }, [{ name: "token", body: token }], this.d.now());
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
      writeFileSync(join(dir, `setup-token-${e.id}.txt`), maskedTrace(e.tail), { mode: 0o600 });
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
