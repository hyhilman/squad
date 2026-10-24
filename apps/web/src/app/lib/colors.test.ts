import assert from "node:assert/strict";
import { test } from "node:test";
import { colorMap, OTHER } from "./colors.ts";

const P = ["#1", "#2", "#3"] as const;

test("colorMap: fixed order over the sorted, distinct ids", () => {
  assert.deepEqual(colorMap(["codex/b", "claude/a", "codex/b"], P), { "claude/a": "#1", "codex/b": "#2" });
});

test("colorMap: an id past the palette gets the Other grey, never a cycled colour", () => {
  const m = colorMap(["a", "b", "c", "d", "e"], P);
  assert.equal(m["c"], "#3");
  assert.equal(m["d"], OTHER);
  assert.equal(m["e"], OTHER);
});

test("colorMap: a colour follows the id, not the list it comes from", () => {
  const all = colorMap(["a", "b", "c"], P);
  assert.equal(all["c"], "#3");
});
