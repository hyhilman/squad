import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cliArgs } from "./pi.ts";

const req = { model: "m-1", effort: null, prompt: "do it", skill: null, sessionId: null, guidance: null };

test("minimal args, prompt on stdin", () => {
  const r = cliArgs(req);
  assert.deepEqual(r.args, ["-p", "--mode", "json", "--no-context-files", "--no-extensions", "--no-prompt-templates", "--no-themes", "--model", "m-1"]);
  assert.deepEqual(r.mounts, []);
  assert.equal(r.stdin, "do it");
});

test("effort, skill, session and guidance", () => {
  const r = cliArgs({ ...req, effort: "high", skill: { name: "fix-bug", dir: "/s/fix-bug" }, sessionId: "sid", guidance: "be brief", prompt: "-rm" });
  assert.deepEqual(r.args, [
    "-p", "--mode", "json", "--no-context-files", "--no-extensions", "--no-prompt-templates", "--no-themes", "--model", "m-1",
    "--thinking", "high", "--skill", "/skills/fix-bug", "--session-dir", "/squad/sessions", "--session-id", "sid",
    "--append-system-prompt", "be brief",
  ]);
  assert.equal(r.stdin, "-rm");
  assert.deepEqual(r.mounts, [{ host: "/s/fix-bug", container: "/skills/fix-bug", ro: true }]);
});

test("a floating model alias is refused", () => {
  assert.throws(() => cliArgs({ ...req, model: "latest" }), /model/);
});

test("an unsafe skill name is refused", () => {
  assert.throws(() => cliArgs({ ...req, skill: { name: "../x", dir: "/s" } }), /skill/);
});
