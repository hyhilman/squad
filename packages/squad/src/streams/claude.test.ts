import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClaudeStream, parseClaudeStream } from "./claude.ts";

const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/captures/claude/${name}`, import.meta.url), "utf8");

const room = {
  left5h: 92,
  leftWeek: 70,
  resets5h: new Date(1792845000 * 1000).toISOString(),
  resetsWeek: new Date(1793246400 * 1000).toISOString(),
};

test("claude opus capture", () => {
  const o = parseClaudeStream(fixture("ok-opus-5-5.jsonl"));
  assert.equal(o.text, "ok");
  assert.deepEqual(o.texts, ["ok"]);
  assert.equal(o.turns, 1);
  assert.equal(o.ended, true);
  assert.equal(o.model, "claude-opus-5-5");
  assert.deepEqual(o.usage, { input: 2, output: 4, cacheRead: 11333, cacheWrite: 5672, reasoning: 0 });
  assert.deepEqual(o.room, room);
  assert.equal(o.failure, undefined);
  assert.equal(o.badLines, 0);
});

test("claude sonnet capture", () => {
  const o = parseClaudeStream(fixture("ok-sonnet-5-5.jsonl"));
  assert.equal(o.text, "ok");
  assert.equal(o.model, "claude-sonnet-5-5");
  assert.deepEqual(o.usage, { input: 2, output: 4, cacheRead: 11333, cacheWrite: 5680, reasoning: 0 });
  assert.equal(o.failure, undefined);
});

test("7-byte chunks give the same outcome as one shot", () => {
  for (const name of ["ok-opus-5-5.jsonl", "ok-sonnet-5-5.jsonl"]) {
    const text = fixture(name);
    const s = new ClaudeStream();
    for (let i = 0; i < text.length; i += 7) s.push(text.slice(i, i + 7));
    s.end();
    assert.deepEqual(s.outcome(), parseClaudeStream(text), name);
  }
});

const line = (o: unknown): string => JSON.stringify(o) + "\n";

// Shape tests, not captures. Replace them with a real capture of a claude error when we have one.
test("shape: an error result with an HTTP status uses the status table", () => {
  const o = parseClaudeStream(line({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 401, result: "bad", num_turns: 1, usage: {} }));
  assert.deepEqual(o.failure, { kind: "auth", code: "401", message: "bad" });
  assert.equal(o.ended, true);
});

test("shape: an error result with no status is a provider failure coded by its subtype", () => {
  const o = parseClaudeStream(line({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3, usage: {} }));
  assert.equal(o.failure?.kind, "provider");
  assert.equal(o.failure?.code, "error_max_turns");
  assert.equal(o.turns, 3);
});

test("no rate_limit_event means no room; a stream with no result is not ended", () => {
  const o = parseClaudeStream(line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));
  assert.equal(o.room, undefined);
  assert.equal(o.ended, false);
  assert.deepEqual(o.texts, ["hi"]);
  assert.equal(o.text, "");
});

test("non-JSON lines are counted, not fatal", () => {
  assert.equal(parseClaudeStream("nope\n{x\n").badLines, 2);
});

test("claude: the CLI cost is the result event's total_cost_usd", () => {
  assert.equal(parseClaudeStream(fixture("ok-sonnet-5-5.jsonl")).cliCostUsd, 0.0238973);
  assert.equal(parseClaudeStream(fixture("ok-opus-5-5.jsonl")).cliCostUsd, 0.0477306);
  assert.equal(parseClaudeStream("").cliCostUsd, undefined);
});
