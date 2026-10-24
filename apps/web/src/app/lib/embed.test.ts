import { test } from "node:test";
import assert from "node:assert/strict";
import { inFrame } from "./embed.ts";

test("inFrame: a top-level page is not in a frame; a page whose top is another window, or cannot be read, is", () => {
  const w = {};
  assert.equal(inFrame({ top: w, self: w }), false);
  assert.equal(inFrame({ top: {}, self: {} }), true);
  assert.equal(inFrame({ top: null, self: {} }), true);
});
