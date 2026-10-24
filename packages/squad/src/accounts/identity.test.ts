import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeIdToken } from "../../test/fake-jwt.ts";
import { identityOf, loginFilesOf } from "./identity.ts";

function dirWith(file: string, body: string): string {
  const d = mkdtempSync(join(tmpdir(), "identity-"));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), body);
  return d;
}
const codexDir = (idToken: unknown): string => dirWith("auth.json", JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken, access_token: "x", refresh_token: "y" } }));

test("codex login: the email and email_verified come from the id_token claims", () => {
  assert.deepEqual(identityOf("codex", "login", codexDir(fakeIdToken())), { email: "alice@example.test", emailVerified: true });
  assert.deepEqual(identityOf("codex", "login", codexDir(fakeIdToken({ email_verified: false }))), { email: "alice@example.test", emailVerified: false });
});

test("codex login: a missing file, bad JSON, a bad JWT or a claim that is not a string gives null", () => {
  assert.equal(identityOf("codex", "login", mkdtempSync(join(tmpdir(), "identity-"))), null);
  assert.equal(identityOf("codex", "login", dirWith("auth.json", "{not json")), null);
  assert.equal(identityOf("codex", "login", codexDir("not-a-jwt")), null);
  assert.equal(identityOf("codex", "login", codexDir(undefined)), null);
  assert.equal(identityOf("codex", "login", codexDir(fakeIdToken({ email: 42 }))), null);
  assert.equal(identityOf("codex", "login", codexDir("a.!!!.c")), null);
});

test("the result never holds a token", () => {
  const got = JSON.stringify(identityOf("codex", "login", codexDir(fakeIdToken())));
  assert.ok(!got.includes("eyJ") && !got.includes("refresh"));
});

test("claude token, pi key and pi login have no identity here", () => {
  const d = dirWith("auth.json", JSON.stringify({ tokens: { id_token: fakeIdToken() } }));
  assert.equal(identityOf("claude", "token", d), null);
  assert.equal(identityOf("pi", "key", d), null);
  assert.equal(identityOf("pi", "login", d), null);
  assert.equal(identityOf("codex", "key", d), null);
});

const CAP = join(import.meta.dirname, "..", "..", "test", "fixtures", "captures");
const capture = (...p: string[]): string => readFileSync(join(CAP, ...p), "utf8");
function claudeDir(claudeJson?: string, creds: string | null = capture("claude", "login", ".credentials.json")): string {
  const d = mkdtempSync(join(tmpdir(), "identity-"));
  if (creds !== null) writeFileSync(join(d, ".credentials.json"), creds);
  if (claudeJson !== undefined) writeFileSync(join(d, ".claude.json"), claudeJson);
  return d;
}

test("claude login: the email is oauthAccount.emailAddress in .claude.json", () => {
  const body = capture("claude", "login", ".claude.json").replace("EMAIL", "alice@example.test");
  assert.deepEqual(identityOf("claude", "login", claudeDir(body)), { email: "alice@example.test", emailVerified: false });
});

test("claude login: a missing file, bad JSON, a missing field or a value that is not one email gives null", () => {
  const withEmail = (v: unknown): string => JSON.stringify({ oauthAccount: { emailAddress: v } });
  assert.equal(identityOf("claude", "login", claudeDir()), null);
  assert.equal(identityOf("claude", "login", claudeDir("{not json")), null);
  assert.equal(identityOf("claude", "login", claudeDir("{}")), null);
  assert.equal(identityOf("claude", "login", claudeDir(withEmail(42))), null);
  assert.equal(identityOf("claude", "login", claudeDir(withEmail("EMAIL"))), null, "the scrubbed capture value has no @");
  assert.equal(identityOf("claude", "login", claudeDir(withEmail("a@b@c"))), null);
});

test("loginFilesOf: codex needs tokens and an identity in auth.json", () => {
  assert.equal(loginFilesOf("codex", codexDir(fakeIdToken())), "login");
  assert.equal(loginFilesOf("codex", mkdtempSync(join(tmpdir(), "identity-"))), "none");
  assert.equal(loginFilesOf("codex", dirWith("auth.json", "{}")), "none");
  assert.equal(loginFilesOf("codex", codexDir("not-a-jwt")), "none");
});

test("loginFilesOf: claude needs claudeAiOauth in .credentials.json; .claude.json alone is no login", () => {
  assert.equal(loginFilesOf("claude", claudeDir()), "login");
  assert.equal(loginFilesOf("claude", claudeDir(capture("claude", "login", ".claude.json"), null)), "none");
  assert.equal(loginFilesOf("claude", claudeDir(undefined, "{}")), "none");
  assert.equal(loginFilesOf("claude", claudeDir(undefined, "{not json")), "none");
  assert.equal(loginFilesOf("claude", claudeDir(undefined, JSON.stringify({ claudeAiOauth: "x" }))), "none");
});

test("loginFilesOf: pi needs one provider entry; only api_key entries make it keys", () => {
  assert.equal(loginFilesOf("pi", dirWith("auth.json", capture("pi", "login", "auth.json"))), "keys");
  assert.equal(loginFilesOf("pi", dirWith("auth.json", "{}")), "none");
  assert.equal(loginFilesOf("pi", dirWith("auth.json", "[]")), "none");
  assert.equal(loginFilesOf("pi", mkdtempSync(join(tmpdir(), "identity-"))), "none");
  const mixed = JSON.stringify({ opencode: { type: "api_key", key: "k" }, other: { type: "oauth", refresh: "r" } });
  assert.equal(loginFilesOf("pi", dirWith("auth.json", mixed)), "login");
  assert.equal(loginFilesOf("pi", dirWith("auth.json", JSON.stringify({ x: "nope" }))), "login", "an entry we do not understand is not a key");
});
