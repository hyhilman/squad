import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiFailure } from "@squad/contract";
import { failureText, isNotReady } from "./errors.ts";

test("an ApiFailure becomes plain words", () => {
  assert.equal(failureText(new ApiFailure(403, { error: "forbidden", message: "x" })), "You may not do this.");
  assert.equal(failureText(new ApiFailure(400, { error: "bad-request", message: "floor5h must be 0 to 100" })), "The server refused the request: floor5h must be 0 to 100");
  assert.equal(failureText(new ApiFailure(409, { error: "conflict", message: "busy" })), "This conflicts with the current state: busy");
  assert.equal(failureText(new Error("boom")), "Something went wrong. Try again.");
});

test("isNotReady matches the 501", () => {
  assert.equal(isNotReady(new ApiFailure(501, { error: "disabled", message: "m" })), true);
  assert.equal(isNotReady(new ApiFailure(500, { error: "internal", message: "m" })), false);
  assert.equal(isNotReady(new Error("x")), false);
});
