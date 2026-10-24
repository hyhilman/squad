import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiFailure } from "@squad/contract";
import { CLAUDE_WAYS, connectStateText, isFinalConnect, submitTextFor, wayNeedsSecret } from "./connect.ts";
import { failureText } from "./errors.ts";

test("claude has three ways, in this order; only the token way needs a secret", () => {
  assert.deepEqual(CLAUDE_WAYS.map((w) => [w.value, w.title]), [
    ["signin", "Sign in with Claude"],
    ["computer", "Use my computer (no typing)"],
    ["token", "I already have a token"],
  ]);
  assert.deepEqual(CLAUDE_WAYS.map((w) => wayNeedsSecret(w.value)), [false, false, true]);
});

test("the button says what comes next", () => {
  assert.equal(submitTextFor("codex", "signin"), "Start login");
  assert.equal(submitTextFor("claude", "signin"), "Start login");
  assert.equal(submitTextFor("claude", "computer"), "Get the command");
  assert.equal(submitTextFor("claude", "token"), "Add account");
  assert.equal(submitTextFor("pi", "signin"), "Add account");
  assert.equal(submitTextFor(undefined, "signin"), "Add account");
});

test("pending keeps polling; each state has plain words; a done one names the account", () => {
  assert.equal(isFinalConnect("pending"), false);
  for (const s of ["done", "failed", "expired"] as const) assert.equal(isFinalConnect(s), true);
  assert.match(connectStateText({ connectId: "x", state: "pending" }), /waiting for your computer/i);
  assert.equal(connectStateText({ connectId: "x", state: "done", account: "claude/laptop" }), "Signed in. claude/laptop is ready.");
  assert.match(connectStateText({ connectId: "x", state: "expired" }), /expired.*start again/i);
  assert.match(connectStateText({ connectId: "x", state: "failed", reason: "exists" }), /already/i);
  assert.match(connectStateText({ connectId: "x", state: "failed", reason: "bad-token" }), /did not look like/i);
  assert.match(connectStateText({ connectId: "x", state: "failed", reason: "odd" }), /odd/);
  assert.match(connectStateText({ connectId: "x", state: "failed" }), /failed/i);
});

test("a 429 has its own words", () => {
  assert.match(failureText(new ApiFailure(429, { error: "too-many", message: "too many tries: wait a minute" })), /too many tries/i);
});
