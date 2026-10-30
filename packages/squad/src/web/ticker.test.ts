import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createFileAccount } from "../accounts/add.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyHealth } from "../accounts/health.ts";
import { addAccount, putHealth, type AccountRow } from "../accounts/store.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { makeLog } from "../log.ts";
import { SETTINGS, SQUAD_NO_PRICES_ENV, SQUAD_PRICES_URL_ENV, SQUAD_TICK_S_ENV } from "../settings.ts";
import { openStore } from "../store/db.ts";
import { createTicker, startTicker, tickSteps, type TickStep, type Timers } from "./ticker.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");

/** A clock-free timer: `fire()` runs the callback by hand. */
function fakeTimers() {
  const t = { every: [] as { fn: () => void; ms: number }[], cleared: 0, fire: () => { for (const e of t.every) e.fn(); } };
  const timers: Timers = {
    every: (fn, ms) => { t.every.push({ fn, ms }); return t.every.length; },
    clear: () => { t.cleared++; },
  };
  return { t, timers };
}
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: makeLog((l) => lines.push(l)) };
};
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { p, open };
};

test("a tick runs the steps in order, one after the other", async () => {
  const seen: string[] = [];
  const mk = (name: string): TickStep => ({ name, run: async () => { seen.push(`${name}:start`); await Promise.resolve(); seen.push(`${name}:end`); } });
  const { timers } = fakeTimers();
  const tk = createTicker({ steps: [mk("a"), mk("b"), mk("c")], intervalMs: 1000, log: quiet().log, timers });
  await tk.tick();
  assert.deepEqual(seen, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("a tick that is still running makes the next one skip", async () => {
  const g = gate();
  let runs = 0;
  const { timers } = fakeTimers();
  const { lines, log } = quiet();
  const tk = createTicker({ steps: [{ name: "slow", run: async () => { runs++; await g.p; } }], intervalMs: 1000, log, timers });
  const first = tk.tick();
  await tk.tick();
  assert.equal(runs, 1);
  assert.match(lines.join("\n"), /event=tick-skipped/);
  g.open();
  await first;
  await tk.tick();
  assert.equal(runs, 2, "after it ends, the next tick runs");
});

test("a throwing step is logged and the others and the loop go on", async () => {
  const seen: string[] = [];
  const { timers } = fakeTimers();
  const { lines, log } = quiet();
  const tk = createTicker({
    steps: [
      { name: "boom", run: async () => { throw new Error("bad https://x.test/?key=SECRET"); } },
      { name: "next", run: async () => { seen.push("next"); } },
    ],
    intervalMs: 1000, log, timers,
  });
  await tk.tick();
  await tk.tick();
  assert.deepEqual(seen, ["next", "next"]);
  const l = lines.filter((x) => x.includes("event=tick-step-failed"));
  assert.equal(l.length, 2);
  assert.match(l[0]!, /step=boom/);
  assert.ok(!lines.join("\n").includes("SECRET"), "the error text is not logged");
});

test("the timer fires the tick; stop clears it and later ticks do nothing", async () => {
  let runs = 0;
  const { t, timers } = fakeTimers();
  const tk = createTicker({ steps: [{ name: "s", run: async () => { runs++; } }], intervalMs: 5000, log: quiet().log, timers });
  assert.equal(t.every[0]!.ms, 5000);
  t.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1);
  tk.stop();
  tk.stop();
  assert.equal(t.cleared, 1);
  await tk.tick();
  assert.equal(runs, 1);
});

// ---- the real steps, with fake deps ----

function rig(env: Record<string, string> = {}) {
  const home = layoutOf(join(mkdtempSync(join(tmpdir(), "ticker-")), "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const calls = { read: [] as string[], probe: [] as { id: string; model: string }[], prices: 0 };
  const { lines, log } = quiet();
  const deps = {
    env, home, store, log, now: () => NOW,
    fetch: (async () => { throw new Error("no network"); }) as unknown as typeof globalThis.fetch,
    probe: async (a: AccountRow, model: string) => { calls.probe.push({ id: a.id, model }); },
    readUsage: async (a: AccountRow) => { calls.read.push(a.id); },
    refreshPrices: async () => { calls.prices++; return "fresh" as const; },
  };
  return { deps, store, calls, lines };
}
const suspect = (store: ReturnType<typeof rig>["store"], name: string) => {
  addAccount(store.db, { runner: "codex", name, kind: "login" }, NOW);
  putHealth(store.db, { ...emptyHealth(`codex/${name}`), suspectSince: NOW.toISOString() });
};
const names = (s: TickStep[]) => s.map((x) => x.name);

test("tickSteps are reads, probes, prices, reset probes, in that order", () => {
  assert.deepEqual(names(tickSteps(rig().deps)), ["usage-read", "auto-probe", "prices", "reset-probe"]);
});

test("usage reads: a due account is read; a suspect one is not; SQUAD_NO_USAGE_READ=1 reads nothing", async () => {
  const r = rig();
  addAccount(r.store.db, { runner: "codex", name: "ok", kind: "login" }, NOW);
  suspect(r.store, "bad");
  await tickSteps(r.deps)[0]!.run();
  assert.deepEqual(r.calls.read, ["codex/ok"]);
  const off = rig({ SQUAD_NO_USAGE_READ: "1" });
  addAccount(off.store.db, { runner: "codex", name: "ok", kind: "login" }, NOW);
  await tickSteps(off.deps)[0]!.run();
  assert.deepEqual(off.calls.read, []);
});

test("auto probe: only a due account, with the model set for its runner; none set = no probe", async () => {
  const r = rig({ SQUAD_PROBE_MODEL_CODEX: "gpt-x" });
  suspect(r.store, "bad");
  addAccount(r.store.db, { runner: "codex", name: "fine", kind: "login" }, NOW);
  await tickSteps(r.deps)[1]!.run();
  assert.deepEqual(r.calls.probe, [{ id: "codex/bad", model: "gpt-x" }]);
  const nomodel = rig();
  suspect(nomodel.store, "bad");
  await tickSteps(nomodel.deps)[1]!.run();
  assert.deepEqual(nomodel.calls.probe, [], "there is no safe default model");
});

test("auto probe: SQUAD_NO_AUTO_PROBE=1 probes nothing; one account is not probed again within the hour", async () => {
  const off = rig({ SQUAD_PROBE_MODEL_CODEX: "m", SQUAD_NO_AUTO_PROBE: "1" });
  suspect(off.store, "bad");
  await tickSteps(off.deps)[1]!.run();
  assert.deepEqual(off.calls.probe, []);
  const r = rig({ SQUAD_PROBE_MODEL_CODEX: "m" });
  suspect(r.store, "bad");
  const step = tickSteps(r.deps)[1]!;
  await step.run();
  await step.run();
  assert.equal(r.calls.probe.length, 1, "a failed probe leaves the account suspect; it must not be probed every tick");
});

test("auto probe: a probe that throws is logged without its text, and the next account is still probed", async () => {
  const r = rig({ SQUAD_PROBE_MODEL_CODEX: "m" });
  suspect(r.store, "a");
  suspect(r.store, "b");
  const seen: string[] = [];
  const deps = { ...r.deps, probe: async (a: AccountRow) => { seen.push(a.id); if (a.name === "a") throw new Error("token=SECRET"); } };
  await tickSteps(deps)[1]!.run();
  assert.deepEqual(seen, ["codex/a", "codex/b"]);
  assert.match(r.lines.join("\n"), /event=auto-probe-failed account=codex\/a/);
  assert.ok(!r.lines.join("\n").includes("SECRET"));
});

test("prices: the step calls refreshPrices with the url setting; SQUAD_NO_PRICES=1 skips it", async () => {
  const urls: string[] = [];
  const r = rig();
  await tickSteps({ ...r.deps, refreshPrices: async (o) => { urls.push(o.url); return "fresh"; } })[2]!.run();
  assert.deepEqual(urls, ["https://models.dev/api.json"]);
  const off = rig({ SQUAD_NO_PRICES: "1" });
  await tickSteps(off.deps)[2]!.run();
  assert.equal(off.calls.prices, 0);
});

test("prices: after a refreshed copy the step writes the price history and rewrites models.json; a fresh copy does neither", async () => {
  const r = rig();
  createFileAccount(r.store.db, r.deps.home, { runner: "pi", name: "e1", kind: "key" }, [{ name: "auth.json", body: "{}" }, { name: "models.json", body: JSON.stringify({ providers: { engy: { baseUrl: "https://old", api: "openai-completions", models: [] } } }) }], NOW);
  const catalog = { engy: { api: "https://api.engy.ai/v1", npm: "@ai-sdk/openai-compatible", models: { a: { cost: { input: 1, output: 2 } } } } };
  const save = () => writeFileSync(join(r.deps.home.state, "prices.json"), JSON.stringify({ v: 2, fetchedAt: NOW.getTime(), catalog }));
  const count = () => (r.store.db.prepare("SELECT COUNT(*) AS n FROM price_history").get() as { n: number }).n;
  await tickSteps({ ...r.deps, refreshPrices: async () => { save(); return "fresh"; } })[2]!.run();
  assert.equal(count(), 0);
  await tickSteps({ ...r.deps, refreshPrices: async () => { save(); return "refreshed"; } })[2]!.run();
  assert.equal(count(), 1);
  const doc = JSON.parse(readFileSync(join(r.deps.home.accounts, "pi", "e1", "models.json"), "utf8"));
  assert.deepEqual([doc.providers.engy.baseUrl, doc.providers.engy.models.map((m: { id: string }) => m.id)], ["https://api.engy.ai/v1", ["a"]]);
  assert.ok(r.lines.some((l) => l.includes("models-json-updated")));
});

test("prices: a refreshed copy drops the saved logos; a fresh copy keeps them", async () => {
  const r = rig();
  const logo = join(r.deps.home.state, "logos", "engy.svg");
  mkdirSync(join(r.deps.home.state, "logos"), { recursive: true });
  writeFileSync(logo, "<svg/>");
  writeFileSync(join(r.deps.home.state, "prices.json"), JSON.stringify({ v: 2, fetchedAt: NOW.getTime(), catalog: { openai: { models: { x: { cost: { input: 3, output: 1 } } } } } }));
  await tickSteps({ ...r.deps, refreshPrices: async () => "fresh" })[2]!.run();
  assert.ok(existsSync(logo));
  await tickSteps({ ...r.deps, refreshPrices: async () => "refreshed" })[2]!.run();
  assert.ok(!existsSync(logo));
});

test("prices: the first tick prices old passes from the saved copy, even when the copy is fresh", async () => {
  const r = rig();
  writeFileSync(join(r.deps.home.state, "prices.json"), JSON.stringify({ v: 2, fetchedAt: NOW.getTime(), catalog: { openai: { models: { x: { cost: { input: 3, output: 1 } } } } } }));
  r.store.db.prepare("INSERT INTO passes (id, started_at, ended_at, project, flow, action, runner, model, outcome, input, output) VALUES ('P', ?, ?, 'p', 'f', 'a', 'codex', 'x', 'ok', 1000000, 1000000)").run(NOW.toISOString(), NOW.toISOString());
  await tickSteps({ ...r.deps, refreshPrices: async () => "fresh" })[2]!.run();
  assert.equal((r.store.db.prepare("SELECT catalog_cost_usd c FROM passes WHERE id = 'P'").get() as { c: number }).c, 4);
});

// ---- startTicker ----

test("startTicker: not under dry run, not in api-only mode; otherwise it uses SQUAD_TICK_S", () => {
  const r = rig();
  const { t, timers } = fakeTimers();
  assert.equal(startTicker({ ...r.deps, env: { SQUAD_DRY_RUN: "1" }, timers }), undefined);
  assert.equal(startTicker({ ...r.deps, apiOnly: true, timers }), undefined);
  assert.equal(t.every.length, 0);
  const tk = startTicker({ ...r.deps, env: { SQUAD_TICK_S: "7" }, timers });
  assert.ok(tk);
  assert.equal(t.every[0]!.ms, 7000);
  tk.stop();
  assert.equal(t.cleared, 1);
  const dflt = startTicker({ ...r.deps, timers });
  assert.equal(t.every[1]!.ms, 60_000);
  dflt?.stop();
});

test("startTicker: a bad SQUAD_TICK_S starts nothing and says so", () => {
  const r = rig({ SQUAD_TICK_S: "0" });
  const { t, timers } = fakeTimers();
  assert.equal(startTicker({ ...r.deps, timers }), undefined);
  assert.equal(t.every.length, 0);
  assert.match(r.lines.join("\n"), /event=ticker-off/);
});

test("the settings are in the list", () => {
  const keys = SETTINGS.map((s) => s.key);
  for (const k of [SQUAD_TICK_S_ENV.key, "SQUAD_PROBE_MODEL_CODEX", "SQUAD_PROBE_MODEL_CLAUDE", "SQUAD_PROBE_MODEL_PI", SQUAD_PRICES_URL_ENV.key, SQUAD_NO_PRICES_ENV.key]) assert.ok(keys.includes(k), k);
});

// ---- reset probe ----

const resetRig = (env: Record<string, string> = {}) => {
  const r = rig(env);
  addAccount(r.store.db, { runner: "claude", name: "c", kind: "token" }, NOW);
  r.store.db.prepare("UPDATE accounts SET consent_at = ? WHERE id = ?").run(NOW.toISOString(), "claude/c");
  putHealth(r.store.db, { ...emptyHealth("claude/c"), readAt: "2026-10-24T06:00:00.000Z", left5h: 0, resets5h: "2026-10-24T11:00:00.000Z" });
  const catalog = { anthropic: { models: { big: { cost: { input: 15, output: 75 } }, mid: { cost: { input: 3, output: 15 } }, small: { cost: { input: 1, output: 5 } }, tiny: { cost: { input: 0.5, output: 1 } } } } };
  writeFileSync(join(r.deps.home.state, "prices.json"), JSON.stringify({ v: 2, fetchedAt: NOW.getTime(), catalog }));
  return r;
};
const outcome = (model: string, failure?: { kind: string; code: string }) => ({ account: "claude/c", model, input: 1, output: 1, ms: 1, ...(failure === undefined ? {} : { failure: { ...failure, reason: "" } }) });
const resetStep = (deps: Parameters<typeof tickSteps>[0]) => tickSteps(deps).find((s) => s.name === "reset-probe")!;

test("reset probe: the cheapest model first; a clean answer stops; the same reset is not probed twice", async () => {
  const r = resetRig();
  const seen: string[] = [];
  const step = resetStep({ ...r.deps, probe: async (_a, model) => { seen.push(model); return outcome(model); } });
  await step.run();
  await step.run();
  assert.deepEqual(seen, ["tiny"]);
});

test("reset probe: a refused model moves up the ladder, at most three models", async () => {
  const r = resetRig();
  const seen: string[] = [];
  await resetStep({ ...r.deps, probe: async (_a, model) => { seen.push(model); return outcome(model, { kind: "provider", code: "404" }); } }).run();
  assert.deepEqual(seen, ["tiny", "small", "mid"]);
  const r2 = resetRig();
  const seen2: string[] = [];
  await resetStep({ ...r2.deps, probe: async (_a, model) => { seen2.push(model); return outcome(model, model === "tiny" ? { kind: "provider", code: "404" } : undefined); } }).run();
  assert.deepEqual(seen2, ["tiny", "small"]);
});

test("reset probe: any failure but a refused model stops at once", async () => {
  for (const failure of [{ kind: "auth", code: "401" }, { kind: "provider", code: "529" }, { kind: "rate-limit", code: "429" }, { kind: "busy", code: "75" }]) {
    const r = resetRig();
    const seen: string[] = [];
    await resetStep({ ...r.deps, probe: async (_a, model) => { seen.push(model); return outcome(model, failure); } }).run();
    assert.deepEqual(seen, ["tiny"], failure.code);
  }
});

test("reset probe: SQUAD_NO_RESET_PROBE=1 probes nothing; no price and no setting skips; the setting is the fallback", async () => {
  const off = resetRig({ SQUAD_NO_RESET_PROBE: "1" });
  await resetStep(off.deps).run();
  assert.deepEqual(off.calls.probe, []);
  const bare = resetRig();
  writeFileSync(join(bare.deps.home.state, "prices.json"), JSON.stringify({ v: 2, fetchedAt: NOW.getTime(), catalog: {} }));
  await resetStep(bare.deps).run();
  assert.deepEqual(bare.calls.probe, []);
  assert.ok(bare.lines.some((l) => l.includes("reset-probe-skipped")));
  const set = resetRig({ SQUAD_PROBE_MODEL_CLAUDE: "claude-x" });
  writeFileSync(join(set.deps.home.state, "prices.json"), JSON.stringify({ v: 2, fetchedAt: NOW.getTime(), catalog: {} }));
  await resetStep(set.deps).run();
  assert.deepEqual(set.calls.probe, [{ id: "claude/c", model: "claude-x" }]);
});
