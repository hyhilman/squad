import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyHealth, type HealthRow } from "./health.ts";
import { dueProbes, dueResetProbes, LADDER_MAX, probeLadder } from "./probe.ts";
import type { AccountRow } from "./store.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const ago = (s: number): string => new Date(NOW.getTime() - s * 1000).toISOString();
const acct = (name: string, more: Partial<AccountRow> = {}): AccountRow => ({ id: `codex/${name}`, runner: "codex", name, kind: "login", ownerEmail: null, state: "active", deadCode: null, deadAt: null, floor5h: null, floorWeek: null, createdAt: "x", consentAt: "2026-01-01T00:00:00.000Z", loginEmail: null, consentBy: "cli", cap5h: null, capWeek: null, cap30d: null, balanceUsd: null, balanceAt: null, ...more });
const hm = (...rows: HealthRow[]) => new Map(rows.map((r) => [r.account, r]));

test("dueProbes: suspect accounts with no pass in the last hour", () => {
  const accounts = [acct("a"), acct("b"), acct("c"), acct("d"), acct("e", { state: "dead" }), acct("f")];
  const h = hm(
    { ...emptyHealth("codex/a"), suspectSince: ago(10), lastUsedAt: ago(7200) },
    { ...emptyHealth("codex/b"), suspectSince: ago(10), lastUsedAt: ago(600) },
    { ...emptyHealth("codex/c"), suspectSince: ago(10) },
    { ...emptyHealth("codex/d"), lastUsedAt: ago(7200) },
    { ...emptyHealth("codex/e"), suspectSince: ago(10) },
    { ...emptyHealth("codex/f"), suspectSince: ago(10), lastUsedAt: ago(3600) },
  );
  assert.deepEqual(dueProbes(accounts, h, NOW).map((a) => a.id), ["codex/a", "codex/c", "codex/f"]);
});

test("dueProbes is empty when SQUAD_NO_AUTO_PROBE=1", () => {
  const h = hm({ ...emptyHealth("codex/a"), suspectSince: ago(10) });
  assert.deepEqual(dueProbes([acct("a")], h, NOW, { SQUAD_NO_AUTO_PROBE: "1" }), []);
});

test("dueProbes leaves out an account its owner does not share: a probe there would only be refused", () => {
  const h = hm({ ...emptyHealth("codex/a"), suspectSince: ago(10) }, { ...emptyHealth("codex/b"), suspectSince: ago(10) });
  assert.deepEqual(dueProbes([acct("a", { consentAt: null, consentBy: null }), acct("b")], h, NOW).map((a) => a.id), ["codex/b"]);
});

const claude = (name: string, more: Partial<AccountRow> = {}): AccountRow => acct(name, { id: `claude/${name}`, runner: "claude", kind: "token", ...more });
const later = (s: number): string => new Date(NOW.getTime() + s * 1000).toISOString();

test("dueResetProbes: a window at or under its floor that reset after the last read", () => {
  const accounts = [claude("passed"), claude("fresh"), claude("future"), claude("never"), claude("week"), claude("roomy"), claude("own", { floor5h: 30 })];
  const h = hm(
    { ...emptyHealth("claude/passed"), readAt: ago(7200), left5h: 10, resets5h: ago(600) },
    { ...emptyHealth("claude/fresh"), readAt: ago(60), left5h: 0, resets5h: ago(600) },
    { ...emptyHealth("claude/future"), readAt: ago(7200), left5h: 0, resets5h: later(600) },
    { ...emptyHealth("claude/never") },
    { ...emptyHealth("claude/week"), readAt: ago(9000), left5h: 0, resets5h: ago(8000), leftWeek: 0, resetsWeek: ago(60) },
    { ...emptyHealth("claude/roomy"), readAt: ago(7200), left5h: 11, resets5h: ago(600), leftWeek: 80, resetsWeek: ago(300) },
    { ...emptyHealth("claude/own"), readAt: ago(7200), left5h: 30, resets5h: ago(600) },
  );
  assert.deepEqual(dueResetProbes(accounts, h, NOW).map((p) => [p.account.id, p.reset]), [["claude/passed", ago(600)], ["claude/week", ago(60)], ["claude/own", ago(600)]]);
});

test("dueResetProbes: the room a probe brings back makes the next reset not due, so idle accounts are not probed every 5 hours", () => {
  const h = hm({ ...emptyHealth("claude/a"), readAt: ago(18_000), left5h: 99, leftWeek: 70, resets5h: ago(1), resetsWeek: later(86_400) });
  assert.deepEqual(dueResetProbes([claude("a")], h, NOW), []);
});

test("dueResetProbes leaves out a codex login, a key, an unshared, a suspect and a cooling account", () => {
  const passed = (id: string, more = {}) => ({ ...emptyHealth(id), readAt: ago(7200), left5h: 0, resets5h: ago(600), ...more });
  const accounts = [acct("cx"), claude("k", { kind: "key" }), claude("u", { consentAt: null, consentBy: null }), claude("s"), claude("c"), claude("ok")];
  const h = hm(passed("codex/cx"), passed("claude/k"), passed("claude/u"), passed("claude/s", { suspectSince: ago(10) }), passed("claude/c", { coolUntil: later(60) }), passed("claude/ok"));
  assert.deepEqual(dueResetProbes(accounts, h, NOW).map((p) => p.account.id), ["claude/ok"]);
});

test("dueResetProbes is empty when SQUAD_NO_RESET_PROBE=1 or SQUAD_NO_AUTO_PROBE=1", () => {
  const h = hm({ ...emptyHealth("claude/a"), readAt: ago(7200), left5h: 0, resets5h: ago(600) });
  assert.equal(dueResetProbes([claude("a")], h, NOW).length, 1);
  assert.deepEqual(dueResetProbes([claude("a")], h, NOW, { SQUAD_NO_RESET_PROBE: "1" }), []);
  assert.deepEqual(dueResetProbes([claude("a")], h, NOW, { SQUAD_NO_AUTO_PROBE: "1" }), []);
});

test("probeLadder: priced models cheapest first, at most LADDER_MAX; unpriced ones left out", () => {
  const prices = new Map([
    ["anthropic/big", { input: 15, output: 75 }],
    ["anthropic/mid", { input: 3, output: 15 }],
    ["anthropic/small", { input: 1, output: 5 }],
    ["anthropic/small-b", { input: 1, output: 4 }],
  ]);
  assert.deepEqual(probeLadder("claude", ["big", "mid", "small", "small-b", "nopriced"], prices, "fallback"), ["small-b", "small", "mid"]);
  assert.equal(LADDER_MAX, 3);
});

test("probeLadder: one model per price, so each step is a bigger model; the newer id of a tie wins", () => {
  const prices = new Map([
    ["anthropic/claude-haiku-4-5", { input: 1, output: 5 }],
    ["anthropic/claude-haiku-4-5-20251001", { input: 1, output: 5 }],
    ["anthropic/claude-haiku-5-5", { input: 1, output: 5 }],
    ["anthropic/claude-sonnet-5-5", { input: 3, output: 15 }],
    ["anthropic/claude-opus-5-5", { input: 5, output: 25 }],
  ]);
  const served = ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"];
  assert.deepEqual(probeLadder("claude", served, prices, undefined), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
});

test("probeLadder: with no priced model, only the probe model setting; with neither, nothing", () => {
  assert.deepEqual(probeLadder("claude", ["x"], new Map(), "set"), ["set"]);
  assert.deepEqual(probeLadder("claude", ["x"], new Map(), undefined), []);
  assert.deepEqual(probeLadder("claude", ["x"], new Map(), ""), []);
  assert.deepEqual(probeLadder("pi", ["engy/a", "engy/b"], new Map([["engy/b", { input: 0.1, output: 0.2 }], ["engy/a", { input: 1, output: 2 }]]), undefined), ["engy/b", "engy/a"]);
});
