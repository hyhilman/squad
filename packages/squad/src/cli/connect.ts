// `squad connect --url <origin> --pair <code>`: runs on a person's own computer. It runs their real
// `claude setup-token`, so their own browser opens and the CLI's localhost callback finishes on this
// computer: no code to copy. It reads the token from the CLI's output by its exact shape, and sends it
// once to the squad server that gave the pair code.
//
// The token is never printed, written to a file or logged here. The CLI runs with a throwaway config
// folder, removed at the end, so the person's own claude setup is not touched. This verb needs no squad
// home and makes none.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiFailure, call } from "@squad/contract";
import { codeShapeError, findToken, parseSetupOutput } from "../claude-token.ts";

/** The person signs in within this time, or the helper stops. */
export const CONNECT_WAIT_MS = 5 * 60_000;
/** The CLI's input box takes a pasted chunk as text; Enter must come as its own key press after it. */
const ENTER_DELAY_MS = 250;
/** What is kept of the CLI's output: enough for the link and the token. */
const MAX_OUTPUT = 64 * 1024;
const PAIR_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/;
const ACCOUNT = /^claude\/[a-z0-9][a-z0-9._-]*$/;
/** The terminal is wide, so the CLI does not wrap the token. */
const PTY_LINE = "stty cols 400 rows 50; exec 'claude' 'setup-token'";

export interface ConnectIo {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly fetch?: typeof globalThis.fetch;
  /** Lines the person types: a code, when the browser did not open. Tests leave it out. */
  readonly stdin?: () => NodeJS.ReadableStream;
  readonly waitMs?: number;
}

/** The `script` argv that gives the CLI a pseudo-terminal, or undefined where squad cannot do it yet. */
export function scriptArgv(platform: NodeJS.Platform): string[] | undefined {
  if (platform === "linux") return ["-qfc", PTY_LINE, "/dev/null"];
  // BSD script runs its command as is, with no shell, so the terminal size needs one.
  if (platform === "darwin") return ["-q", "/dev/null", "/bin/sh", "-c", PTY_LINE];
  return undefined;
}

/** The server origin: https, or plain http for this computer only. No path, user, query or fragment. */
export function originOf(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) return undefined;
  if (u.username !== "" || u.password !== "" || u.pathname !== "/" || u.search !== "" || u.hash !== "" || raw.includes("?") || raw.includes("#")) return undefined;
  return u.origin;
}

class Stop extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function parseArgs(args: readonly string[]): { origin: string; pair: string } {
  const use = "use: squad connect --url <squad web address> --pair <code from the web page>";
  if (args.length !== 4) throw new Stop(2, use);
  const opts = new Map<string, string>();
  for (let i = 0; i < 4; i += 2) {
    const k = args[i]!;
    if ((k !== "--url" && k !== "--pair") || opts.has(k)) throw new Stop(2, use);
    opts.set(k, args[i + 1]!);
  }
  const origin = originOf(opts.get("--url")!);
  if (origin === undefined) throw new Stop(2, "--url must be the https address of squad web, such as https://squad.example.com");
  const pair = opts.get("--pair")!;
  if (!PAIR_SHAPE.test(pair)) throw new Stop(2, "--pair must be the code from the web page, copied whole");
  return { origin, pair };
}

/** Runs the CLI until it prints a token. Resolves with it, or throws a Stop. The child is stopped either way. */
function captureToken(io: ConnectIo, argv: string[], configDir: string, running: { child?: ChildProcess }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("script", argv, { env: { ...io.env, CLAUDE_CONFIG_DIR: configDir }, stdio: ["pipe", "pipe", "ignore"] });
    running.child = child;
    let buf = "";
    let shown = false;
    let sent = false;
    let done = false;
    let line = "";
    const input = io.stdin?.();
    const onInput = (chunk: string | Buffer): void => {
      line += chunk.toString();
      const nl = line.indexOf("\n");
      if (nl < 0) return;
      const code = line.slice(0, nl).trim();
      line = "";
      if (sent || codeShapeError(code) !== undefined) return;
      sent = true;
      child.stdin!.write(code);
      setTimeout(() => { if (!done) child.stdin!.write("\r"); }, ENTER_DELAY_MS).unref();
    };
    const finish = (err: Stop | undefined, token?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      buf = "";
      input?.removeListener("data", onInput);
      input?.pause();
      if (child.exitCode === null) child.kill("SIGTERM");
      if (err !== undefined) reject(err);
      else resolve(token!);
    };
    const timer = setTimeout(() => finish(new Stop(1, "no sign-in in time. Start again from the web page.")), io.waitMs ?? CONNECT_WAIT_MS);
    child.stdin!.on("error", () => {});
    child.on("error", () => finish(new Stop(1, "cannot start `script`, which gives claude a terminal. Install it (util-linux on Linux).")));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (s: string) => {
      if (done) return;
      buf = (buf + s).slice(-MAX_OUTPUT);
      const token = findToken(buf, false);
      if (token !== undefined) return finish(undefined, token);
      if (!shown) {
        const got = parseSetupOutput(buf);
        if (got.kind === "ready" && input !== undefined) {
          shown = true;
          io.stdout(`If no browser opened, open this link on this computer:\n${got.url}\nThen paste the code it shows here and press Enter.\n`);
          input.on("data", onInput);
          input.resume();
        }
      }
    });
    child.on("close", (code) => {
      // A token that was the last thing printed has no terminator, so the end counts.
      const token = code === 0 ? findToken(buf, true) : undefined;
      if (token !== undefined) finish(undefined, token);
      else finish(new Stop(1, "the sign-in did not finish. Nothing was sent."));
    });
  });
}

async function send(io: ConnectIo, origin: string, pair: string, token: string): Promise<string> {
  const f = io.fetch ?? globalThis.fetch;
  try {
    // A redirect would send the body, the token, again to wherever it points.
    const res = await call((u, init) => f(u, { ...init, redirect: "error" }), origin, "connectToken", { params: { pairCode: pair }, body: { token } });
    if (!ACCOUNT.test(res.account)) throw new Stop(1, `squad at ${origin} gave an odd answer.`);
    return res.account;
  } catch (e) {
    if (e instanceof Stop) throw e;
    if (e instanceof ApiFailure) {
      if (e.status === 404) throw new Stop(1, "the pair code is wrong, used or expired. Start again from the web page.");
      if (e.status === 409) throw new Stop(1, "squad already has an account with this name. Start again from the web page with another name.");
      if (e.status === 429) throw new Stop(1, "too many tries. Wait a minute, then start again from the web page.");
      if (e.status === 501) throw new Stop(1, "sign-in is off on this squad server.");
    }
    throw new Stop(1, `could not send the token to squad at ${origin}.`);
  }
}

/** Exit codes: 0 done, 1 failed, 2 wrong use. */
export async function runConnect(args: readonly string[], io: ConnectIo): Promise<number> {
  const configDir = { path: "" };
  const running: { child?: ChildProcess } = {};
  // Ctrl-C ends the process with no `finally`: stop the CLI and remove the folder here.
  const onSignal = (): void => {
    if (running.child?.exitCode === null) running.child.kill("SIGTERM");
    if (configDir.path !== "") rmSync(configDir.path, { recursive: true, force: true });
    io.stderr("\nsquad connect: stopped. Nothing was sent.\n");
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const { origin, pair } = parseArgs(args);
    const platform = io.platform ?? process.platform;
    const argv = scriptArgv(platform);
    if (argv === undefined) throw new Stop(1, platform === "win32" ? "this does not work on Windows yet. Use another sign-in way on the web page." : `this does not work on ${platform} yet. Use another sign-in way on the web page.`);
    const version = spawnSync("claude", ["--version"], { env: io.env, stdio: "ignore", timeout: 30_000 });
    if (version.error !== undefined || version.status !== 0) throw new Stop(1, "claude is not installed here. Install Claude Code first (npm install -g @anthropic-ai/claude-code).");
    configDir.path = mkdtempSync(join(tmpdir(), "squad-connect-"));
    io.stdout("A browser window opens on this computer. Sign in with Claude there.\n");
    const token = await captureToken(io, argv, configDir.path, running);
    const account = await send(io, origin, pair, token);
    io.stdout(`Signed in. ${account} is ready in squad.\n`);
    return 0;
  } catch (e) {
    io.stderr(`squad connect: ${e instanceof Stop ? e.message : "failed."}\n`);
    return e instanceof Stop ? e.code : 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (configDir.path !== "") rmSync(configDir.path, { recursive: true, force: true });
  }
}
