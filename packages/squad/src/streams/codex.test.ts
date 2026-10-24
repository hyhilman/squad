import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CodexStream, parseCodexStream } from "./codex.ts";

const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/captures/codex/${name}`, import.meta.url), "utf8");
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

test("codex ok capture", () => {
  const o = parseCodexStream(fixture("ok-gpt-6-1-sol.jsonl"));
  assert.equal(o.text, "ok");
  assert.deepEqual(o.texts, ["ok"]);
  assert.equal(o.turns, 1);
  assert.equal(o.ended, true);
  assert.equal(o.model, null);
  assert.deepEqual(o.usage, { input: 14081, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.equal(o.failure, undefined);
  assert.equal(o.badLines, 0);
});

test("codex model-not-found capture", () => {
  const o = parseCodexStream(fixture("model-not-found.jsonl"));
  assert.deepEqual(o.failure, { kind: "provider", code: "model_not_found", message: "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." });
  assert.equal(o.ended, true);
  assert.equal(o.turns, 0);
  assert.equal(o.text, "");
});

test("the warning item of type error is not a failure", () => {
  const s = line({ type: "item.completed", item: { id: "i", type: "error", message: "Model metadata not found" } }) + line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  const o = parseCodexStream(s);
  assert.equal(o.failure, undefined);
  assert.equal(o.ended, true);
});

test("usage sums over turns, and input is fresh input only (codex counts the cached ones in input_tokens)", () => {
  const u = (i: number, c: number) => ({ type: "turn.completed", usage: { input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } });
  const o = parseCodexStream(line(u(100, 40)) + line(u(50, 60)));
  assert.deepEqual(o.usage, { input: 60, cacheRead: 100, cacheWrite: 4, output: 6, reasoning: 2 });
  assert.equal(o.turns, 2);
});

test("texts keep every agent_message in order, text is the last", () => {
  const m = (t: string) => line({ type: "item.completed", item: { id: "i", type: "agent_message", text: t } });
  const o = parseCodexStream(m("one") + line({ type: "item.completed", item: { id: "x", type: "reasoning", text: "no" } }) + m("two"));
  assert.deepEqual(o.texts, ["one", "two"]);
  assert.equal(o.text, "two");
  assert.equal(o.ended, false);
});

test("a chunk may end in the middle of a line", () => {
  const s = new CodexStream();
  const all = fixture("ok-gpt-6-1-sol.jsonl");
  s.push(all.slice(0, 50));
  s.push(all.slice(50));
  s.end();
  assert.equal(s.outcome().text, "ok");
});

test("turn.failed beats an earlier top-level error; the top-level error is the fallback", () => {
  const msg = (code: string, status: number) => JSON.stringify({ type: "error", status, error: { type: "t", message: `m-${code}`, code } });
  const both = parseCodexStream(line({ type: "error", message: msg("a", 400) }) + line({ type: "turn.failed", error: { message: msg("usage_limit_reached", 429) } }));
  assert.deepEqual(both.failure, { kind: "quota", code: "usage_limit_reached", message: "m-usage_limit_reached" });
  const only = parseCodexStream(line({ type: "error", message: msg("rate_limit_exceeded", 429) }));
  assert.equal(only.failure?.kind, "rate-limit");
  assert.equal(only.ended, false);
});

test("a code that is not a string falls back to the status, and the status table decides the kind", () => {
  // shape test: invented inline; no capture has a code-less error.
  const body = JSON.stringify({ type: "error", status: 401, error: { message: "nope" } });
  const o = parseCodexStream(line({ type: "turn.failed", error: { message: body } }));
  assert.deepEqual(o.failure, { kind: "auth", code: "401", message: "nope" });
});

test("a permanent auth code is kind auth", () => {
  // shape test: invented inline.
  const body = JSON.stringify({ type: "error", status: 401, error: { message: "gone", code: "refresh_token_reused" } });
  assert.equal(parseCodexStream(line({ type: "turn.failed", error: { message: body } })).failure?.kind, "auth");
});

test("a failure message that is not JSON is a provider failure with no code", () => {
  // shape test: invented inline.
  const o = parseCodexStream(line({ type: "turn.failed", error: { message: "plain words" } }));
  assert.deepEqual(o.failure, { kind: "provider", code: "", message: "plain words" });
});

test("codex has no CLI cost", () => {
  assert.equal(parseCodexStream(fixture("ok-gpt-6-1-sol.jsonl")).cliCostUsd, undefined);
});
