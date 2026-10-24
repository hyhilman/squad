import assert from "node:assert/strict";
import { test } from "node:test";
import { accountNameError, suggestName } from "./accountName.ts";

test("a good name has no error", () => {
  for (const ok of ["alice", "a", "dev-2", "a.b_c", "0day"]) assert.equal(accountNameError(ok), undefined, ok);
});

test("a bad name has a plain error", () => {
  for (const bad of ["", "  ", "Alice", "-x", ".x", "_x", "a b", "a/b", "ü"]) assert.match(accountNameError(bad) ?? "", /name|letters/i, bad);
});

test("the text is not trimmed: a space is an error", () => {
  assert.notEqual(accountNameError(" alice"), undefined);
});

test("the suggested name is the email's part before @, cleaned to the allowed characters", () => {
  assert.equal(suggestName("jane.doe@mail.test"), "jane.doe");
  assert.equal(suggestName("Alice+Work@x.test"), "alice-work");
  assert.equal(suggestName("_x@y.test"), "x");
  assert.equal(suggestName("@y.test"), "");
  assert.equal(suggestName(undefined), "");
  for (const e of ["jane.doe@mail.test", "Alice+Work@x.test", "_x@y.test"]) assert.equal(accountNameError(suggestName(e)), undefined, e);
});
