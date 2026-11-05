import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cliArgs, isProjectDirOf } from "./claude.ts";

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

const U = "01930d55-2c17-f000-c000-00000000014b";

test("a conversation keeps its transcript: --session-id on the first turn, --resume after, never --no-session-persistence", () => {
  const first = cliArgs({ ...req, system: "be brief", history: { id: U, resume: false } });
  const later = cliArgs({ ...req, prompt: "next", system: "be brief", history: { id: U, resume: true } });
  const keep = ["--permission-mode", "bypassPermissions"];
  const end = ["--strict-mcp-config", "--setting-sources", ""];
  assert.deepEqual(first.args, [...base, "--append-system-prompt", "be brief", ...keep, "--session-id", U, ...end]);
  assert.deepEqual(later.args, [...base, "--append-system-prompt", "be brief", ...keep, "--resume", U, ...end]);
  // Only the new text: the history is in the transcript.
  assert.equal(later.stdin, "next");
  for (const bad of ["--x", "0193", U.toUpperCase()]) assert.throws(() => cliArgs({ ...req, history: { id: bad, resume: true } }), /UUID/);
});

test("isProjectDirOf: claude's folder name for a cwd, as seen in the claude 2.1.310 container", () => {
  assert.equal(isProjectDirOf("-work-repo", "/work/repo"), true);
  assert.equal(isProjectDirOf("-work-a-b-c-d", "/work/a.b_c-d"), true);
  assert.equal(isProjectDirOf("-work-other", "/work/repo"), false);
  assert.equal(isProjectDirOf("-work-repo-x", "/work/repo"), false);
  // Seen: a 244-character slug became its first 200 characters, `-`, and `f1rdiq`.
  const long = `/work/a.b_c-d/${"x".repeat(230)}`;
  const cut = long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200);
  assert.equal(isProjectDirOf(`${cut}-f1rdiq`, long), true);
  assert.equal(isProjectDirOf(cut, long), false);
});
