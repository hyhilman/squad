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

test("effort and skill", () => {
  const r = cliArgs({ ...req, effort: "high", skill: { name: "fix", dir: "/s/fix" } });
  assert.deepEqual(r.args, [...base, "--effort", "high", ...tail, "--add-dir", "/squad/skills"]);
  assert.deepEqual(r.mounts, [{ host: "/s/fix", container: "/squad/skills/.claude/skills/fix", ro: true }]);
});

test("a floating model alias is refused", () => {
  for (const m of ["opus", "sonnet", "haiku", "best"]) assert.throws(() => cliArgs({ ...req, model: m }), /model/);
});
