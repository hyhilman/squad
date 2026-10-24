import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "../home.ts";
import { makeLog } from "../log.ts";
import { parseClaudeStream } from "../streams/claude.ts";
import { parseCodexStream } from "../streams/codex.ts";
import { claudeExport, codexExport, piExport, writeUsageExport } from "./export.ts";

const capture = (runner: string, name: string): string => readFileSync(new URL(`../../test/fixtures/captures/${runner}/${name}`, import.meta.url), "utf8");
const meta = { passId: "PASS1", project: "proj", flow: "fix", action: "fix:pi", at: new Date("2026-10-24T12:00:00.000Z") };

// These two lines are doppelganger's exportLine(line, "PASS1:<n>") on the same capture, byte for byte.
// The header differs on purpose: its id is the pass id and its cwd is project/flow/action.
const HEADER = '{"type":"session","version":3,"id":"PASS1","timestamp":"2026-10-04T08:22:41.951Z","cwd":"proj/fix/fix:pi"}';
const MESSAGE =
  '{"type":"message","id":"PASS1:6","parentId":null,"timestamp":"2026-10-04T08:22:42.009Z","message":{"role":"assistant","provider":"opencode-go","model":"hy4-preview","api":"openai-completions","usage":{"input":1493,"output":71,"cacheRead":64,"cacheWrite":0,"reasoning":68,"totalTokens":1628,"cost":{"input":0.001245162,"output":0.00017757099999999998,"cacheRead":0.0000026880000000000004,"cacheWrite":0,"total":0.001425421}},"stopReason":"stop","timestamp":1791102162009,"content":[]}}';

test("pi: the pi capture gives the session header and the message line doppelganger gives", () => {
  assert.equal(piExport(capture("pi", "ok.jsonl"), meta), `${HEADER}\n${MESSAGE}\n`);
});

test("pi: no text and no host path in the output", () => {
  const out = piExport(capture("pi", "ok.jsonl"), meta);
  assert.ok(!out.includes('"text"'));
  assert.ok(!out.includes("/work"));
  for (const l of out.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(l));
});

test("pi: a stream with no session line still gets a header, stamped with the pass time", () => {
  const lines = capture("pi", "ok.jsonl").split("\n").filter((l) => !l.startsWith('{"type":"session"'));
  const out = piExport(lines.join("\n"), meta).split("\n");
  assert.equal(out[0], '{"type":"session","version":3,"id":"PASS1","timestamp":"2026-10-24T12:00:00.000Z","cwd":"proj/fix/fix:pi"}');
  assert.equal(out[1], MESSAGE.replace("PASS1:6", "PASS1:5"));
});

test("pi: a pass with no assistant reply exports nothing", () => {
  assert.equal(piExport('{"type":"agent_start"}\nnot json\n', meta), "");
});

test("claude: one message line from the result usage, counted once, cost zero", () => {
  const o = parseClaudeStream(capture("claude", "ok-sonnet-5-5.jsonl"));
  const lines = claudeExport(o, { ...meta, action: "fix:claude" }).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { type: "session", version: 3, id: "PASS1", timestamp: "2026-10-24T12:00:00.000Z", cwd: "proj/fix/fix:claude" });
  assert.deepEqual(JSON.parse(lines[1]!), {
    type: "message",
    id: "PASS1:1",
    parentId: null,
    timestamp: "2026-10-24T12:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      api: "anthropic-messages",
      usage: { input: 2, output: 4, cacheRead: 11333, cacheWrite: 5680, totalTokens: 17019, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.parse("2026-10-24T12:00:00.000Z"),
      content: [],
    },
  });
});

test("claude: no usage exports nothing", () => {
  const o = parseClaudeStream("");
  assert.equal(claudeExport(o, meta), "");
});

test("codex: one message line, provider openai, the requested model, fresh input and cache counted apart", () => {
  const o = parseCodexStream(capture("codex", "ok-gpt-6-1-sol.jsonl"));
  const lines = codexExport(o, { ...meta, action: "fix:codex", model: "gpt-6.1-sol" }).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { type: "session", version: 3, id: "PASS1", timestamp: "2026-10-24T12:00:00.000Z", cwd: "proj/fix/fix:codex" });
  const m = JSON.parse(lines[1]!);
  assert.equal(m.id, "PASS1:1");
  assert.equal(m.message.provider, "openai");
  assert.equal(m.message.model, "gpt-6.1-sol");
  assert.deepEqual(m.message.usage, { input: 14081, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 14086, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.deepEqual(m.message.content, []);
});

test("codex: no usage exports nothing", () => {
  assert.equal(codexExport(parseCodexStream(""), meta), "");
});

test("writeUsageExport: the file is <passId>.jsonl, mode 0600, with no temp file left", () => {
  const home = layoutOf(join(mkdtempSync(join(tmpdir(), "exp-")), "home"), {});
  ensureHome(home);
  writeUsageExport(home, "PASS1", `${HEADER}\n`);
  assert.deepEqual(readdirSync(home.usageExport), ["PASS1.jsonl"]);
  const f = join(home.usageExport, "PASS1.jsonl");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(readFileSync(f, "utf8"), `${HEADER}\n`);
});

test("writeUsageExport: a write failure is a warning, never a throw", () => {
  const home = layoutOf(join(mkdtempSync(join(tmpdir(), "exp-")), "home"), {});
  ensureHome(home);
  // A plain file stands where the parent folder should be, so mkdir fails.
  writeFileSync(join(home.root, "blocker"), "");
  const lines: string[] = [];
  writeUsageExport({ ...home, usageExport: join(home.root, "blocker", "pi") }, "PASS1", "x\n", makeLog((l) => lines.push(l)));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /level=warn event=usage-export-failed/);
});
