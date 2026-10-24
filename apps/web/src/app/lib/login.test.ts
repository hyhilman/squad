import { test } from "node:test";
import assert from "node:assert/strict";
import { canLogInAgain, isFinalLogin, loginStateText, POLL_MS } from "./login.ts";

test("pending is the only state that keeps polling", () => {
  assert.equal(isFinalLogin("pending"), false);
  for (const s of ["done", "failed", "expired"] as const) assert.equal(isFinalLogin(s), true);
  assert.ok(POLL_MS >= 2000 && POLL_MS <= 5000);
});

test("each state has plain words, and a failure names its reason", () => {
  assert.match(loginStateText({ loginId: "x", state: "pending" }), /waiting/i);
  assert.match(loginStateText({ loginId: "x", state: "done" }), /logged in/i);
  assert.match(loginStateText({ loginId: "x", state: "expired" }), /expired/i);
  assert.match(loginStateText({ loginId: "x", state: "failed", reason: "owner-mismatch" }), /another email/i);
  assert.match(loginStateText({ loginId: "x", state: "failed", reason: "busy" }), /pass is using/i);
  assert.match(loginStateText({ loginId: "x", state: "failed", reason: "login-failed" }), /did not finish/i);
  assert.match(loginStateText({ loginId: "x", state: "failed", reason: "odd" }), /odd/);
  assert.match(loginStateText({ loginId: "x", state: "failed" }), /failed/i);
});

test("Log in again shows only for a dead codex login account, as the server allows", () => {
  assert.equal(canLogInAgain({ runner: "codex", kind: "login", health: "dead" }), true);
  for (const health of ["ok", "suspect", "cooling", "disabled", "moved"] as const) assert.equal(canLogInAgain({ runner: "codex", kind: "login", health }), false, health);
  assert.equal(canLogInAgain({ runner: "claude", kind: "login", health: "dead" }), false);
  assert.equal(canLogInAgain({ runner: "codex", kind: "key", health: "dead" }), false);
});

test("a no-login failure has its own text", () => {
  assert.match(loginStateText({ loginId: "x", state: "failed", reason: "no-login" }), /no login/i);
});
