import assert from "node:assert/strict";
import { test } from "node:test";
import { accountNameError } from "./accountName.ts";

test("a good name has no error", () => {
  for (const ok of ["alice", "a", "dev-2", "a.b_c", "0day"]) assert.equal(accountNameError(ok), undefined, ok);
});

test("a bad name has a plain error", () => {
  for (const bad of ["", "  ", "Alice", "-x", ".x", "_x", "a b", "a/b", "ü"]) assert.match(accountNameError(bad) ?? "", /name|letters/i, bad);
});

test("the text is not trimmed: a space is an error", () => {
  assert.notEqual(accountNameError(" alice"), undefined);
});
