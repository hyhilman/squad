// "Use limit reset": the owner of a claude account spends one of their limit resets from the page.
// squad starts the REAL claude CLI in a container on that account, under a pseudo-terminal (the
// slash command is a screen, not a `-p` command), types `/limit-reset <which>` and Enter, reads the
// screen for one of the CLI's own result lines, and stops the container. Only the real CLI talks to
// Anthropic; squad sends nothing of its own.
//
// The words come from the claude 2.1.310 binary. The UI draws a space as a cursor move, so both
// sides are compared with every space and escape removed, by exact text. A screen squad does not
// know is `unknown`, with a masked trace kept for a person to read. No answer and no log line holds
// the token or the raw screen.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMIT_RESET_WHICH, type LimitResetResult, type LimitResetWhich } from "@squad/contract";
import { endCooling, type AccountRow } from "../accounts/store.ts";
import { maskedTrace, strip } from "../claude-token.ts";
import { dockerRunArgv } from "../docker.ts";
import type { HomeLayout } from "../home.ts";
import { IMAGES } from "../images.ts";
import { ulid } from "../ids.ts";
import type { Log } from "../log.ts";
import { lockPathOf } from "../run.ts";
import { SQUAD_DRY_RUN_ENV, SQUAD_NO_LIMIT_RESET_ENV, envOn } from "../settings.ts";
import type { Store } from "../store/db.ts";
import { EXIT_LOCK_BUSY } from "../run.ts";
import { LoginRefused } from "./device-login.ts";
import { COLS, ROWS, type PtyRunner } from "./setup-token.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface Timings {
  /** The prompt is drawn and the screen has been still this long: the CLI takes input. */
  readonly quietMs: number;
  /** The input box takes a chunk as text: Enter must come as its own key press after it. */
  readonly enterDelayMs: number;
  /** A confirm screen ignores keys for a moment after it opens. */
  readonly confirmWaitMs: number;
  readonly trustWaitMs: number;
  /** After the last Escape, the container is stopped if it is still there. */
  readonly exitWaitMs: number;
  readonly timeoutMs: number;
}
// The confirm screens ignore keys for a short time after they open (500 ms by default in 2.1.310);
// the wait is longer, so the one deliberate Enter is not dropped.
export const TIMINGS: Timings = { quietMs: 1500, enterDelayMs: 250, confirmWaitMs: 2500, trustWaitMs: 1500, exitWaitMs: 3000, timeoutMs: 60_000 };

/** Text with no escape and no space at all, as both sides are compared. */
export const normalScreen = (raw: string): string => strip(raw, "").replace(/\s+/g, "");
const n = (s: string): string => s.replace(/\s+/g, "");

const DONE = "The limit reset was used. Your limit is refilled; your weekly limit still applies.";
const NOT_AVAILABLE = "No limit reset is available for this login right now. Nothing was used.";
const NEEDS_LOGIN = "Claude refused this login for a limit reset. Log in again, then try again.";
const UNKNOWN = "squad could not read the result. A reset may have been used: check your usage in Claude.";

/** The CLI's result lines (fixed parts around its placeholders), each with squad's own words. */
const LINES: readonly { readonly text: string; readonly outcome: LimitResetResult["outcome"]; readonly message: string }[] = [
  { text: "Session limit reset ·", outcome: "done", message: DONE },
  { text: "A session-limit reset isn't available right now.", outcome: "not-available", message: NOT_AVAILABLE },
  { text: "Your session limit is already being reset · one moment", outcome: "not-available", message: "A reset is already running for this login. Wait a moment, then look at your usage." },
  { text: "Your limits are already being reset · one moment", outcome: "not-available", message: "A reset is already running for this login. Wait a moment, then look at your usage." },
  { text: "Weekly reset used · available again", outcome: "not-available", message: "This week's reset was already used. Nothing was used now." },
  { text: "Couldn't reset your session limit right now · try again in a moment", outcome: "not-available", message: "Claude could not reset the limit right now. Nothing was used; try again in a moment." },
  { text: "Couldn't reset your limits · nothing was used", outcome: "not-available", message: "Claude could not reset the limits right now. Nothing was used; try again in a moment." },
  { text: "kept · run /limit-reset", outcome: "not-available", message: "The reset was kept. Nothing was used." },
  { text: "That isn't a reset name", outcome: "not-available", message: "This login does not offer that kind of reset. Nothing was used." },
  { text: "Unknown command: /limit-reset", outcome: "not-available", message: "This login has no limit reset. Nothing was used." },
  { text: "Couldn't reset your session limit with this login · run /login, then try again", outcome: "needs-login", message: NEEDS_LOGIN },
  { text: "Couldn't reset your limits with this login · run /login, then try again", outcome: "needs-login", message: NEEDS_LOGIN },
  { text: "Couldn't confirm the reset went through", outcome: "unknown", message: "Claude could not confirm the reset. A reset may have been used: check your usage in a moment." },
  { text: "Still couldn't confirm your reset", outcome: "unknown", message: "Claude could not confirm the reset. A reset may have been used: check your usage in a moment." },
];
/** A confirm screen of the newer reset kinds, and its warning that no limit is reached yet. */
const CONFIRM_YES = n("Yes, use my");
const EARLY = [n("anyway?")];
/** The new kinds' success line: "{done} · your weekly reset day stays {week} · ..." (the confirm body says it too). */
const NEW_DONE = n("· your weekly reset day stays");
const NOT_LOGGED_IN = n("Not logged in · Run /login");
const TRUST = n("Quick safety check:");
const PROMPT = "❯";

/**
 * The result line in a normalised screen, or undefined. The newer kinds' success line is taken only
 * after squad answered their confirm screen (`afterConfirm`): that screen's body has the same words.
 */
export function outcomeOf(screen: string, afterConfirm = false): LimitResetResult | undefined {
  for (const l of LINES) if (screen.includes(n(l.text))) return { outcome: l.outcome, message: l.message };
  if (afterConfirm && screen.indexOf(NEW_DONE, screen.lastIndexOf(CONFIRM_YES) + 1) >= 0) return { outcome: "done", message: DONE };
  return undefined;
}

export interface LimitResetDeps extends PtyRunner {
  readonly env: Env;
  readonly home: HomeLayout;
  readonly store: Store;
  readonly log: Log;
  readonly now: () => Date;
  readonly user: { readonly uid: number; readonly gid: number } | null;
  readonly docker: string;
  readonly timings?: Partial<Timings>;
}

const MAX_SCREEN = 64 * 1024;

export class LimitResets {
  private readonly d: LimitResetDeps;
  private readonly t: Timings;
  private readonly running = new Set<string>();
  /** The containers of the resets that run now. */
  private readonly live = new Set<string>();

  constructor(d: LimitResetDeps) {
    this.d = d;
    this.t = { ...TIMINGS, ...d.timings };
  }

  /** One reset. `busy`: a pass holds the login's lock. Refusals are LoginRefused with their status. */
  async run(a: AccountRow, which: LimitResetWhich): Promise<LimitResetResult | "busy"> {
    const { env, home, log } = this.d;
    if (envOn(SQUAD_NO_LIMIT_RESET_ENV, env)) throw new LoginRefused(501, "disabled", "the limit reset is off (SQUAD_NO_LIMIT_RESET=1)");
    if (envOn(SQUAD_DRY_RUN_ENV, env)) throw new LoginRefused(501, "disabled", "the limit reset starts no container while SQUAD_DRY_RUN=1");
    if (!(LIMIT_RESET_WHICH as readonly string[]).includes(which)) throw new LoginRefused(400, "bad-request", `which must be one of ${LIMIT_RESET_WHICH.join(", ")}`);
    if (a.runner !== "claude" || (a.kind !== "token" && a.kind !== "login")) throw new LoginRefused(400, "bad-request", "the limit reset is for claude accounts only");
    if (this.running.has(a.id)) throw new LoginRefused(409, "conflict", "a limit reset is already running for this account");
    this.running.add(a.id);
    const passId = ulid(this.d.now().getTime());
    const id = randomBytes(8).toString("hex");
    // The cwd is outside the scratch tree: docker makes the parents of a mount target as root.
    const cwd = mkdtempSync(join(tmpdir(), "squad-lrwork-"));
    const scratch = a.kind === "token" ? mkdtempSync(join(tmpdir(), "squad-lrcfg-")) : undefined;
    if (scratch !== undefined) {
      // The first-run screens (theme, trust of the folder) would take the typed command.
      writeFileSync(join(scratch, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects: { [cwd]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
    }
    const argv = dockerRunArgv({
      runner: "claude", image: IMAGES.claude.tag, name: `squad-limit-${passId.toLowerCase()}`, passId, purpose: "shell",
      caller: { project: "squad-web", flow: "limit-reset" }, user: this.d.user, cwd, gitDir: join(cwd, ".git"),
      mounts: [], overlays: [], session: null,
      account: { name: a.name, kind: a.kind, dir: join(home.accounts, a.runner, a.name) },
      lockFile: a.kind === "login" ? lockPathOf(home, a) : null,
      identity: { name: "squad", email: "squad@localhost" }, ghDir: null, home: home.root,
      env: { COLUMNS: String(COLS), LINES: String(ROWS) }, args: [], tty: true,
      ...(scratch === undefined ? {} : { claudeConfig: scratch }),
    });
    const container = argv[argv.indexOf("--name") + 1]!;
    log.info("limit_reset_started", { account: a.id, which });
    const proc = this.d.start(argv, container);
    this.live.add(container);
    try {
      const res = await this.drive(proc, container, which, id);
      log.info("limit_reset_ended", { account: a.id, outcome: res === "busy" ? "busy" : res.outcome });
      // The account may rest until the window it used up resets; a spent reset ends that rest now.
      // If another window is still empty, the next pass's 429 starts a new rest.
      if (res !== "busy" && res.outcome === "done") endCooling(this.d.store.db, a.id);
      return res;
    } finally {
      this.running.delete(a.id);
      rmSync(cwd, { recursive: true, force: true });
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Types the command and reads the answer. The only Enter keys squad sends are the one after the
   * command and the one that answers a confirm screen on purpose: any other key could pick an
   * option that spends a reset. Every run ends with Escape and a stop of the container.
   */
  private drive(proc: ReturnType<PtyRunner["start"]>, container: string, which: LimitResetWhich, id: string): Promise<LimitResetResult | "busy"> {
    const t = this.t;
    return new Promise((resolve) => {
      let raw = "";
      /** The output since the last key squad sent, normalised whole: an escape can be split across two reads. */
      let since = "";
      let phase: "starting" | "sent" | "confirmed" | "ending" = "starting";
      let quiet: NodeJS.Timeout | undefined;
      let trusted = false;
      let confirmed = false;
      let result: LimitResetResult | "busy" | undefined;
      let exited = false;
      const timers: NodeJS.Timeout[] = [];
      const later = (fn: () => void, ms: number): void => void timers.push(setTimeout(fn, ms));
      const screen = (): string => normalScreen(since);
      const key = (s: string): void => {
        if (exited) return;
        since = "";
        proc.write(s);
      };
      const finish = (r: LimitResetResult | "busy"): void => {
        if (result !== undefined) return;
        result = r;
        if (r !== "busy" && r.outcome === "unknown") this.trace(raw, id);
        phase = "ending";
        if (quiet !== undefined) clearTimeout(quiet);
        // Escape closes a dialog without choosing; a second one after the refuse window, in case the
        // first came too early. Then stop before kill, as for every container.
        key("\u001b");
        later(() => key("\u001b"), t.confirmWaitMs);
        later(() => {
          if (!exited) void this.d.stop(container).catch(() => {});
        }, t.confirmWaitMs + t.exitWaitMs);
      };
      const deadline = setTimeout(() => finish({ outcome: "unknown", message: UNKNOWN }), t.timeoutMs);
      const typeCommand = (): void => {
        if (phase !== "starting" || result !== undefined) return;
        phase = "sent";
        key(`/limit-reset ${which}`);
        later(() => {
          if (result === undefined) key("\r");
        }, t.enterDelayMs);
      };
      const early = (): boolean => EARLY.some((e) => screen().includes(e));
      proc.onOutput((chunk) => {
        if (result !== undefined) return;
        raw = (raw + chunk).slice(-MAX_SCREEN);
        since = (since + chunk).slice(-MAX_SCREEN);
        const now = screen();
        if (phase === "starting") {
          if (now.includes(NOT_LOGGED_IN)) return finish({ outcome: "needs-login", message: NEEDS_LOGIN });
          if (!trusted && now.includes(TRUST)) {
            // The trust screen has "No, exit" first and in focus. An empty throwaway folder is safe to trust.
            trusted = true;
            later(() => key("\u001b[B"), t.trustWaitMs);
            later(() => key("\r"), t.trustWaitMs + t.enterDelayMs);
            return;
          }
          if (now.includes(PROMPT)) {
            if (quiet !== undefined) clearTimeout(quiet);
            quiet = setTimeout(typeCommand, t.quietMs);
          }
          return;
        }
        const got = outcomeOf(now, phase === "confirmed");
        if (got !== undefined) return finish(got);
        if (phase === "sent" && !confirmed && now.includes(CONFIRM_YES)) {
          confirmed = true;
          later(() => {
            if (result !== undefined) return;
            // The person agreed on the page to spend a reset, not to spend one before a limit is
            // reached. The warning may come in a later chunk, so it is checked again here.
            if (early()) return finish({ outcome: "not-available", message: "The limit is not reached yet, so the reset was kept. Nothing was used." });
            phase = "confirmed";
            key("\r");
          }, t.confirmWaitMs);
        }
      });
      // The answer waits for the container to be gone, so its folders can be removed after it.
      void proc.exited.then((code) => {
        exited = true;
        if (result === undefined) finish(code === EXIT_LOCK_BUSY && phase === "starting" ? "busy" : { outcome: "unknown", message: UNKNOWN });
        clearTimeout(deadline);
        if (quiet !== undefined) clearTimeout(quiet);
        for (const x of timers) clearTimeout(x);
        this.live.delete(container);
        resolve(result!);
      });
    });
  }

  /** Stops every running reset (stop before kill), as the server stops. */
  async close(): Promise<void> {
    await Promise.all([...this.live].map((c) => this.d.stop(c).catch(() => {})));
  }

  /** Keeps what the CLI showed, with every run of 20 or more token characters replaced. */
  private trace(raw: string, id: string): void {
    try {
      const dir = join(this.d.home.state, "debug");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `limit-reset-${id}.txt`), maskedTrace(raw), { mode: 0o600 });
    } catch {
      // A trace is a help, never a reason for the answer to change.
    }
  }
}
