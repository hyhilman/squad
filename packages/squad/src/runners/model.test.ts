import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkModel } from "./model.ts";

test("a pinned model passes", () => {
  for (const m of ["gpt-5.1-codex", "claude-opus-4-1-20250805", "openai/gpt-5.4", "a.b_c-1"]) assert.equal(checkModel(m), m);
});

test("floating aliases and bad shapes are refused", () => {
  for (const m of ["latest", "default", "opus", "sonnet", "haiku", "best", "", "-x", "Opus", "a b", "a;b", "../x"]) assert.throws(() => checkModel(m), /model/, m);
});
