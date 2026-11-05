import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cliArgs } from "./codex.ts";

const req = { model: "gpt-5.1-codex", effort: null, prompt: "do it", skill: null, cwd: "/w/tree", outDir: "/o" };

test("minimal args, prompt on stdin", () => {
  const r = cliArgs(req);
  assert.deepEqual(r.args, [
    "exec", "--json", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
    "-C", "/w/tree", "-m", "gpt-5.1-codex", "-o", "/squad/out/last-message.txt", "-",
  ]);
  assert.equal(r.stdin, "do it");
  assert.deepEqual(r.mounts, [{ host: "/o", container: "/squad/out", ro: false }]);
});

test("effort goes before -o", () => {
  const a = cliArgs({ ...req, effort: "high" }).args;
  assert.deepEqual(a.slice(a.indexOf("-m"), a.indexOf("-m") + 4), ["-m", "gpt-5.1-codex", "-c", "model_reasoning_effort=high"]);
  assert.equal(a.at(-1), "-");
});

test("the skill text replaces the /<skill> line, without its front matter", () => {
  const text = "---\nname: fix\n---\n\nStep one.\nStep two.\n";
  const r = cliArgs({ ...req, prompt: "guide\n\n/fix\n\nk=v", skill: { name: "fix", text } });
  assert.equal(r.stdin, "guide\n\nStep one.\nStep two.\n\nk=v");
});

test("a prompt with no skill line stays as it came", () => {
  assert.equal(cliArgs({ ...req, prompt: "plain", skill: { name: "fix", text: "x" } }).stdin, "plain");
});

test("a floating model alias is refused", () => {
  assert.throws(() => cliArgs({ ...req, model: "default" }), /model/);
});

const T = "00000000-0000-7000-8000-000000000003";

test("a conversation keeps its rollout: the first turn drops --ephemeral; a later one resumes the thread with the same flags", () => {
  const first = cliArgs({ ...req, history: { resume: null } }).args;
  const later = cliArgs({ ...req, effort: "high", history: { resume: T } });
  assert.deepEqual(first, ["exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", "/w/tree", "-m", "gpt-5.1-codex", "-o", "/squad/out/last-message.txt", "-"]);
  assert.deepEqual(later.args, [
    "exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
    "-C", "/w/tree", "-m", "gpt-5.1-codex", "-c", "model_reasoning_effort=high", "-o", "/squad/out/last-message.txt", "resume", T, "-",
  ]);
  assert.equal(later.stdin, "do it");
  for (const bad of ["--last", "x", "0000000A-0000-7000-8000-000000000003"]) assert.throws(() => cliArgs({ ...req, history: { resume: bad } }), /UUID/);
});
