import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeIdToken } from "../../test/fake-jwt.ts";
import { identityOf } from "./identity.ts";

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

test("claude token, pi key, pi login and claude login have no identity here", () => {
  const d = dirWith("auth.json", JSON.stringify({ tokens: { id_token: fakeIdToken() } }));
  assert.equal(identityOf("claude", "token", d), null);
  assert.equal(identityOf("pi", "key", d), null);
  assert.equal(identityOf("pi", "login", d), null);
  assert.equal(identityOf("claude", "login", d), null);
  assert.equal(identityOf("codex", "key", d), null);
});
