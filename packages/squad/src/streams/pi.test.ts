import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePiStream, PiStream } from "./pi.ts";

const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/captures/pi/${name}`, import.meta.url), "utf8");

test("pi ok capture", () => {
  const o = parsePiStream(fixture("ok.jsonl"));
  assert.equal(o.text, "ok");
  assert.deepEqual(o.texts, ["ok"]);
  assert.equal(o.turns, 1);
  assert.equal(o.ended, true);
  assert.equal(o.model, "opencode-go/hy4-preview");
  assert.deepEqual(o.usage, { input: 1493, output: 71, cacheRead: 64, cacheWrite: 0, reasoning: 68 });
  assert.equal(o.failure, undefined);
  assert.equal(o.badLines, 0);
});

test("pi auth-error capture", () => {
  const o = parsePiStream(fixture("auth-error.jsonl"));
  assert.equal(o.text, "");
  assert.equal(o.ended, true);
  assert.deepEqual(o.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.deepEqual(o.failure, { kind: "auth", code: "401:AuthError", message: "Invalid API key." });
});

test("pi free-tier capture is a provider failure, not auth", () => {
  const o = parsePiStream(fixture("free-tier-error.jsonl"));
  assert.equal(o.failure?.kind, "provider");
  assert.equal(o.failure?.code, "403:FreeTierError");
});

test("7-byte chunks give the same outcome as one shot", () => {
  for (const name of ["ok.jsonl", "auth-error.jsonl"]) {
    const text = fixture(name);
    const s = new PiStream();
    for (let i = 0; i < text.length; i += 7) s.push(text.slice(i, i + 7));
    s.end();
    assert.deepEqual(s.outcome(), parsePiStream(text), name);
  }
});

const line = (o: unknown): string => JSON.stringify(o) + "\n";
const usage = (n: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n, reasoning: n });
const asst = (text: string, n: number, extra: object = {}) => ({
  type: "message_end",
  message: { role: "assistant", content: text === "" ? [] : [{ type: "text", text }], provider: "p", model: "m", usage: usage(n), stopReason: "stop", ...extra },
});

test("tokens count from message_end only; agent_end and turn_end are not added", () => {
  const a = asst("one", 1);
  const b = asst("two", 2);
  const s =
    line({ type: "agent_start" }) +
    line(a) +
    line({ type: "turn_end", message: a.message }) +
    line(asst("", 5)) +
    line(b) +
    line({ type: "turn_end", message: b.message }) +
    line({ type: "agent_end", messages: [a.message, b.message] });
  const o = parsePiStream(s);
  assert.deepEqual(o.usage, usage(8));
  assert.equal(o.text, "two");
  assert.deepEqual(o.texts, ["one", "two"]);
  assert.equal(o.turns, 2);
});

test("a user message is not an answer and not counted", () => {
  const o = parsePiStream(line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }], usage: usage(9) } }));
  assert.equal(o.text, "");
  assert.deepEqual(o.usage, usage(0));
});

test("an aborted last message is a failure; a stream with no agent_end is just not ended", () => {
  const o = parsePiStream(line(asst("", 0, { stopReason: "aborted", errorMessage: "529: overloaded" })));
  assert.equal(o.ended, false);
  assert.deepEqual(o.failure, { kind: "provider", code: "529", message: "overloaded" });
  const ok = parsePiStream(line(asst("hi", 1)));
  assert.equal(ok.ended, false);
  assert.equal(ok.failure, undefined);
});

test("non-JSON lines are counted, not fatal", () => {
  const o = parsePiStream("garbage\n" + line(asst("ok", 1)) + "{broken\n");
  assert.equal(o.badLines, 2);
  assert.equal(o.text, "ok");
});

test("pi: the CLI cost is the sum of the assistant message_end costs, not repeated by turn_end or agent_end", () => {
  const o = parsePiStream(fixture("ok.jsonl"));
  assert.ok(Math.abs((o.cliCostUsd ?? NaN) - 0.001425421) < 1e-12);
});
