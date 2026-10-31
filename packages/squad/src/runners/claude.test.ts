import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cliArgs } from "./claude.ts";

const req = { model: "claude-opus-4-1-20250805", effort: null, prompt: "do it", skill: null };
const base = ["-p", "--output-format", "stream-json", "--verbose", "--model", "claude-opus-4-1-20250805"];
const tail = ["--permission-mode", "bypassPermissions", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""];

test("minimal args, prompt on stdin", () => {
  const r = cliArgs(req);
  assert.deepEqual(r.args, [...base, ...tail]);
  assert.equal(r.stdin, "do it");
  assert.deepEqual(r.mounts, []);
});

test("effort and skill: the skill text joins the system prompt and the prompt goes once, as written", () => {
  const r = cliArgs({ ...req, effort: "high", system: "be brief", skill: "Review the diff." });
  assert.deepEqual(r.args, [...base, "--effort", "high", "--append-system-prompt", "be brief\n\nReview the diff.", ...tail]);
  assert.equal(r.stdin, "do it");
  assert.deepEqual(r.mounts, []);
  assert.ok(!r.args.includes("--plugin-dir"));
});

test("a floating model alias is refused", () => {
  for (const m of ["opus", "sonnet", "haiku", "best"]) assert.throws(() => cliArgs({ ...req, model: m }), /model/);
});
