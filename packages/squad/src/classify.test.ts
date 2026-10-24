import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CODEX_CODE_KINDS, kindOfHttpStatus, parseCodexError, parsePiError, PERMANENT_AUTH_CODES } from "./classify.ts";

test("kindOfHttpStatus is an exact table, and an unknown status is never auth", () => {
  const rows: [number, string][] = [
    [401, "auth"],
    [403, "auth"],
    [402, "quota"],
    [429, "rate-limit"],
    [500, "provider"],
    [503, "provider"],
    [418, "provider"],
    [200, "provider"],
  ];
  for (const [status, kind] of rows) assert.equal(kindOfHttpStatus(status), kind, String(status));
});

test("parsePiError reads the captured 401", () => {
  assert.deepEqual(parsePiError('401: {"type":"AuthError","message":"Invalid API key."}'), {
    kind: "auth",
    code: "401:AuthError",
    message: "Invalid API key.",
  });
});

test("parsePiError: an exact code beats the status table", () => {
  const f = parsePiError('403: {"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}');
  assert.equal(f.kind, "provider");
  assert.equal(f.code, "403:FreeTierError");
  assert.equal(parsePiError('403: {"type":"Other","message":"x"}').kind, "auth", "an unknown 403 code stays auth");
  assert.equal(parsePiError('401: {"type":"AuthError","message":"Invalid API key."}').kind, "auth");
});

test("parsePiError keeps the status when the body is not JSON or has no type", () => {
  assert.deepEqual(parsePiError("429: slow down"), { kind: "rate-limit", code: "429", message: "slow down" });
  assert.deepEqual(parsePiError('402: {"message":"no credit"}'), { kind: "quota", code: "402", message: "no credit" });
});

test("parsePiError: a shape that does not match is a provider failure with no code", () => {
  assert.deepEqual(parsePiError("nonsense"), { kind: "provider", code: "", message: "nonsense" });
  assert.equal(parsePiError("x".repeat(900)).message.length, 500);
  assert.equal(parsePiError("").kind, "provider");
});

test("a message that only mentions a status word is not read as that status", () => {
  assert.equal(parsePiError("error 401 unauthorized").kind, "provider");
});

test("PERMANENT_AUTH_CODES is pinned", () => {
  assert.deepEqual([...PERMANENT_AUTH_CODES].sort(), ["invalid_grant", "refresh_token_invalidated", "refresh_token_reused", "token_revoked"]);
});

test("CODEX_CODE_KINDS is an exact table", () => {
  assert.equal(CODEX_CODE_KINDS["usage_limit_reached"], "quota");
  assert.equal(CODEX_CODE_KINDS["rate_limit_exceeded"], "rate-limit");
  assert.equal(CODEX_CODE_KINDS["model_not_found"], "provider");
  for (const c of PERMANENT_AUTH_CODES) assert.equal(CODEX_CODE_KINDS[c], "auth", c);
});

test("parseCodexError: code first, then status, else provider with no code", () => {
  assert.deepEqual(parseCodexError('{"status":429,"error":{"code":"usage_limit_reached","message":"m"}}'), { kind: "quota", code: "usage_limit_reached", message: "m" });
  assert.deepEqual(parseCodexError('{"status":500,"error":{"message":"m"}}'), { kind: "provider", code: "500", message: "m" });
  assert.deepEqual(parseCodexError("not json"), { kind: "provider", code: "", message: "not json" });
  assert.deepEqual(parseCodexError('{"error":{"message":"m"}}'), { kind: "provider", code: "", message: "m" });
});
