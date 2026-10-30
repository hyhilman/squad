// The limit reset against a fake terminal. NOT A REAL CAPTURE: a real `/limit-reset` spends one of
// the person's resets, so it is never run for a test. Each transcript is SHAPED like the messages in
// the claude 2.1.310 binary (read with grep from the image), with the cursor moves that the Ink UI
// puts in place of spaces.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";
import { addAccount, getAccount, getHealth } from "../accounts/store.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { makeLog } from "../log.ts";
import { openStore } from "../store/db.ts";
import { LimitResets, outcomeOf, normalScreen } from "./limit-reset.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
/** How the Ink UI draws a space: a cursor move, as in the setup-token captures. */
const ink = (s: string): string => s.replaceAll(" ", "\u001b[1C");
const PROMPT = `\u001b[2J${ink(" ▐▛███▜▌ Claude Code v2.1.310")}\r\n${"─".repeat(40)}\r\n❯ \r\n${"─".repeat(40)}\r\n`;
const FAST = { quietMs: 20, enterDelayMs: 5, confirmWaitMs: 20, trustWaitMs: 20, exitWaitMs: 30, timeoutMs: 400 };

function rig(env: Record<string, string> = {}, timings: Partial<typeof FAST> = {}) {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "lr-")), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const logs: string[] = [];
  const procs: { argv: string[]; name: string; writes: string[]; say: (s: string) => void; exit: (c: number) => void }[] = [];
  const stops: string[] = [];
  /** What the fake CLI says after each write; `script` maps a write to the next screen. */
  let script: (write: string, all: string[]) => string | number | undefined = () => undefined;
  const resets = new LimitResets({
    env, home, store, log: makeLog((l) => logs.push(l)), now: () => NOW, docker: "docker", user: null, timings: { ...FAST, ...timings },
    start: (argv, name) => {
      let cb: (s: string) => void = () => {};
      let end: (c: number) => void = () => {};
      const exited = new Promise<number>((r) => { end = r; });
      const writes: string[] = [];
      const p = { argv, name, writes, say: (s: string) => cb(s), exit: (c: number) => end(c) };
      procs.push(p);
      queueMicrotask(() => cb(PROMPT));
      return {
        onOutput: (f) => { cb = f; },
        write: (s) => {
          writes.push(s);
          const next = script(s, writes);
          if (typeof next === "number") queueMicrotask(() => end(next));
          else if (next !== undefined) queueMicrotask(() => cb(next));
        },
        exited,
      };
    },
    stop: async (n) => { stops.push(n); procs.find((p) => p.name === n)?.exit(143); },
  });
  const token = addAccount(store.db, { runner: "claude", name: "t", kind: "token", ownerEmail: "o@x.test" }, NOW);
  return { home, store, logs, procs, stops, resets, token, setScript: (f: typeof script) => { script = f; } };
}

/** The CLI answers the typed command (after its Enter) with `screen`; the stop ends it. */
const answers = (screen: string) => (w: string, all: string[]) => {
  if (w === "\r" && all.at(-2)?.startsWith("/limit-reset")) return `\r\n${ink(screen)}\r\n`;
  return undefined;
};
/** The Enter keys squad sent after its command's own Enter. */
const enters = (writes: readonly string[]): number => writes.slice(2).filter((w) => w.includes("\r")).length;

test("normalScreen drops escapes and every space, so the Ink text matches the binary's words", () => {
  assert.equal(normalScreen(ink("A session-limit reset isn't available right now.")), "Asession-limitresetisn'tavailablerightnow.");
  assert.equal(normalScreen("\u001b[31mYour session\u001b[0m limit"), "Yoursessionlimit");
});

test("outcomeOf maps each message of the binary to done, not-available, needs-login or unknown, and nothing else", () => {
  const cases: [string, string | undefined][] = [
    ["Session limit reset · next reset available Nov 1 · your weekly limit still applies", "done"],
    ["A session-limit reset isn't available right now.", "not-available"],
    ["Your session limit is already being reset · one moment", "not-available"],
    ["Your limits are already being reset · one moment", "not-available"],
    ["Weekly reset used · available again Nov 1", "not-available"],
    ["Couldn't reset your session limit right now · try again in a moment", "not-available"],
    ["Couldn't reset your limits · nothing was used · try again in a moment", "not-available"],
    ["Unknown command: /limit-reset", "not-available"],
    ["Couldn't reset your session limit with this login · run /login, then try again", "needs-login"],
    ["Couldn't reset your limits with this login · run /login, then try again", "needs-login"],
    ["Couldn't confirm the reset went through · if you're still at the limit in a moment, try again", "unknown"],
    ["Hello there", undefined],
  ];
  for (const [text, want] of cases) assert.equal(outcomeOf(normalScreen(ink(text)))?.outcome, want, text);
});

test("a token account: the real CLI under a terminal, a scratch config at /claude, the command then Enter as its own write, the outcome, then /exit", async () => {
  const r = rig();
  r.setScript(answers("Session limit reset · next reset available Nov 1 · your weekly limit still applies"));
  const res = await r.resets.run(r.token, "5-hour");
  assert.ok(res !== "busy");
  assert.equal(res.outcome, "done");
  const p = r.procs[0]!;
  assert.deepEqual(p.writes.slice(0, 2), ["/limit-reset 5-hour", "\r"]);
  assert.deepEqual(p.writes.slice(2), ["\u001b", "\u001b"], "it ends with Escape, never another Enter");
  assert.deepEqual(r.stops, [p.name], "then the container is stopped");
  assert.ok(p.argv.includes("-it"));
  assert.ok(p.argv.some((a) => a.endsWith("target=/squad/token,readonly")));
  const cfg = p.argv.find((a) => a.endsWith("target=/claude"));
  assert.ok(cfg !== undefined && !cfg.includes(r.home.root), "a scratch config outside the home");
  assert.equal(p.argv.at(-1), "squad-claude:2.1.310-r2", "no CLI args: the interactive claude");
  assert.ok(!p.argv.join(" ").includes("oat01"));
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(existsSync(cfg!.split(",")[1]!.replace("source=", "")), false, "the scratch config is removed");
  assert.equal(getHealth(r.store.db, "claude/t").lastFailCode, null, "a limit reset changes no health");
});

test("a login account mounts its own folder under its lock; exit 75 is busy", async () => {
  const r = rig();
  const login = addAccount(r.store.db, { runner: "claude", name: "l", kind: "login" }, NOW);
  r.setScript(() => undefined);
  const run = r.resets.run(login, "weekly");
  await new Promise((ok) => setTimeout(ok, 5));
  const p = r.procs[0]!;
  assert.ok(p.argv.some((a) => a.includes(`${join(r.home.accounts, "claude", "l")},target=/claude`)));
  assert.ok(p.argv.some((a) => a.endsWith("target=/squad/lock,readonly")));
  assert.ok(!p.argv.some((a) => a.includes("squad-lrcfg")), "no scratch config for a login");
  p.exit(75);
  assert.equal(await run, "busy");
});

test("each known answer maps to its outcome and squad's own words; the screen text is never the message", async () => {
  for (const [screen, outcome] of [
    ["A session-limit reset isn't available right now.", "not-available"],
    ["Couldn't reset your limits with this login · run /login, then try again", "needs-login"],
    ["Unknown command: /limit-reset", "not-available"],
  ] as const) {
    const r = rig();
    r.setScript(answers(screen));
    const res = await r.resets.run(r.token, "full");
    assert.ok(res !== "busy");
    assert.equal(res.outcome, outcome, screen);
    assert.notEqual(res.message, screen);
    assert.equal(findForbidden(res), undefined);
  }
});

test("new mode: a confirm screen is answered with Enter after it settles, then the success line is read", async () => {
  const r = rig();
  r.setScript((w, all) => {
    if (w === "\r" && all.at(-2)?.startsWith("/limit-reset")) return ink("Use a full reset?\r\nRefills your 5-hour and weekly limits now · your weekly reset day stays Tuesday\r\n2 full resets left · use by Nov 30\r\n❯ Yes, use my full reset\r\n  No, keep it\r\n");
    if (w === "\r" && all.at(-2) === "\r") return ink("\r\nFull reset used · your weekly reset day stays Tuesday · 1 full reset left\r\n");
    return undefined;
  });
  const res = await r.resets.run(r.token, "full");
  assert.ok(res !== "busy");
  assert.equal(res.outcome, "done");
  assert.deepEqual(r.procs[0]!.writes.slice(0, 3), ["/limit-reset full", "\r", "\r"]);
  assert.equal(enters(r.procs[0]!.writes), 1, "exactly one deliberate Enter on the confirm");
});

test("new mode: a confirm that warns the limit is not reached is cancelled with Escape; nothing is used", async () => {
  const r = rig();
  r.setScript((w, all) => {
    if (w === "\r" && all.at(-2)?.startsWith("/limit-reset")) return ink("Use a 5-hour reset?\r\nYou still have 64% of your 5-hour limit left — use your 5-hour reset anyway?\r\n❯ Yes, use my 5-hour reset\r\n  No, keep it\r\n");
    return undefined;
  });
  const res = await r.resets.run(r.token, "5-hour");
  assert.ok(res !== "busy");
  assert.equal(res.outcome, "not-available");
  assert.match(res.message, /not reached/);
  assert.equal(r.procs[0]!.writes[2], "\u001b");
  assert.equal(enters(r.procs[0]!.writes), 0, "no Enter after the confirm appeared");
});

test("new mode: the warning that comes in a later chunk still cancels the confirm; a CLI that drops the first Escape gets no Enter either", async () => {
  const r = rig();
  r.setScript((w, all) => {
    if (w === "\r" && all.at(-2)?.startsWith("/limit-reset")) {
      setTimeout(() => r.procs[0]!.say(ink("You haven't reached a limit yet — use your 5-hour reset anyway?\r\n")), 5);
      return ink("Use a 5-hour reset?\r\n❯ Yes, use my 5-hour reset\r\n  No, keep it\r\n");
    }
    return undefined;
  });
  const res = await r.resets.run(r.token, "5-hour");
  assert.ok(res !== "busy");
  assert.equal(res.outcome, "not-available");
  assert.equal(enters(r.procs[0]!.writes), 0);
  assert.deepEqual(r.procs[0]!.writes.slice(2), ["\u001b", "\u001b"], "Escape twice: once at once, once after the refuse window");
});

test("the deadline while a confirm is on screen ends with Escape and a stop, never an Enter", async () => {
  const r = rig({}, { confirmWaitMs: 300, timeoutMs: 80, exitWaitMs: 20 });
  r.setScript((w, all) => (w === "\r" && all.at(-2)?.startsWith("/limit-reset") ? ink("Use a full reset?\r\n❯ Yes, use my full reset\r\n  No, keep it\r\n") : undefined));
  const res = await r.resets.run(r.token, "full");
  assert.ok(res !== "busy");
  assert.equal(res.outcome, "unknown");
  await new Promise((ok) => setTimeout(ok, 350));
  assert.equal(enters(r.procs[0]!.writes), 0);
  assert.equal(r.stops.length, 1);
});

test("an escape sequence split across two reads still matches the line", async () => {
  const r = rig();
  const line = ink("A session-limit reset isn't available right now.");
  const cut = line.indexOf("\u001b[1C") + 2;
  r.setScript((w, all) => {
    if (w === "\r" && all.at(-2)?.startsWith("/limit-reset")) {
      setTimeout(() => r.procs[0]!.say(line.slice(cut)), 5);
      return line.slice(0, cut);
    }
    return undefined;
  });
  const res = await r.resets.run(r.token, "5-hour");
  assert.ok(res !== "busy");
  assert.equal(res.outcome, "not-available");
});

test("close stops a reset that still runs", async () => {
  const r = rig({}, { timeoutMs: 5000 });
  r.setScript(() => undefined);
  const run = r.resets.run(r.token, "5-hour");
  await new Promise((ok) => setTimeout(ok, 10));
  await r.resets.close();
  assert.equal(r.stops.length, 1);
  const res = await run;
  assert.ok(res !== "busy" && res.outcome === "unknown");
});

test("not logged in at start: needs-login, and nothing is typed", async () => {
  const r = rig();
  r.setScript(() => undefined);
  const run = r.resets.run(r.token, "5-hour");
  await new Promise((ok) => setTimeout(ok, 2));
  r.procs[0]!.say(ink(" ⏵⏵ auto mode on · Not logged in · Run /login\r\n"));
  const res = await run;
  assert.ok(res !== "busy");
  assert.equal(res.outcome, "needs-login");
  assert.ok(!r.procs[0]!.writes.some((w) => w.startsWith("/limit-reset")));
});

test("no known answer in time: unknown, the container is stopped, and a masked trace is kept with no token in it", async () => {
  const r = rig();
  r.setScript((w, all) => (w === "\r" && all.at(-2)?.startsWith("/limit-reset") ? ink("Something new sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE here\r\n") : undefined));
  const res = await r.resets.run(r.token, "5-hour");
  assert.ok(res !== "busy");
  assert.equal(res.outcome, "unknown");
  assert.equal(r.stops.length, 1);
  const dir = join(r.home.state, "debug");
  const files = readdirSync(dir).filter((f) => f.startsWith("limit-reset-"));
  assert.equal(files.length, 1);
  const trace = readFileSync(join(dir, files[0]!), "utf8");
  assert.ok(!trace.includes("oat01") && !trace.includes("FAKEFAKE"));
  assert.match(trace, /Something new/);
});

test("the kill switch, a dry run, a bad which, another runner and a second run at once are refused", async () => {
  const off = rig({ SQUAD_NO_LIMIT_RESET: "1" });
  await assert.rejects(off.resets.run(off.token, "5-hour"), /SQUAD_NO_LIMIT_RESET/);
  const dry = rig({ SQUAD_DRY_RUN: "1" });
  await assert.rejects(dry.resets.run(dry.token, "5-hour"), /DRY_RUN/);
  const r = rig();
  await assert.rejects(r.resets.run(r.token, "all" as never), /which/);
  const codex = addAccount(r.store.db, { runner: "codex", name: "c", kind: "login" }, NOW);
  await assert.rejects(r.resets.run(codex, "5-hour"), /claude/);
  r.setScript(answers("A session-limit reset isn't available right now."));
  const first = r.resets.run(r.token, "5-hour");
  await assert.rejects(r.resets.run(getAccount(r.store.db, "claude/t")!, "5-hour"), /already running/);
  await first;
  assert.equal(r.procs.length, 1);
});
