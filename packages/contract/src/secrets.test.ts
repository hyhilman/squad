import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findForbidden, maskSecrets } from "./secrets.ts";

test("a clean answer passes, including token counts", () => {
  assert.equal(findForbidden({ account: "codex/a", tokens: 12, tokenUse: { input: 3 }, rows: [{ key: "x" }] }), undefined);
});

test("a forbidden key is found at any depth, whatever its case or separator", () => {
  assert.equal(findForbidden({ a: [{ b: { "Refresh-Token": "x" } }] }), "$.a[0].b.Refresh-Token");
  assert.equal(findForbidden({ accessToken: "x" }), "$.accessToken");
  assert.equal(findForbidden({ apiKey: "" }), "$.apiKey");
});

test("a secret-shaped value is found under any key", () => {
  assert.equal(findForbidden({ note: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.sig" }), "$.note");
  assert.equal(findForbidden(["sk-ant-api03-abcdefghijklmnopqrst"]), "$[0]");
});

// Made-up shapes only: none of these is a real credential.
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWZha2U";
const FAKES = ["sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE0000", "sk-proj-FAKEFAKEFAKEFAKE0000", JWT, "ghp_FAKEFAKEFAKEFAKEFAKEFAKE0123456789"];

test("maskSecrets hides each secret shape inside a longer text", () => {
  for (const s of FAKES) {
    const out = maskSecrets(`before ${s} after`);
    assert.equal(out, "before [hidden] after", s);
    assert.equal(findForbidden(out), undefined);
  }
});

test("maskSecrets hides the values of forbidden keys in an auth file snippet, and keeps the rest", () => {
  const auth = '{\n  "OPENAI_API_KEY": null,\n  "tokens": {\n    "id_token": "abc.def",\n    "access_token": "plain-looking-value",\n    "refresh_token": "rt_x1",\n    "account_id": "acct"\n  }\n}';
  const out = maskSecrets(auth);
  assert.ok(!out.includes("plain-looking-value") && !out.includes("rt_x1") && !out.includes("abc.def"));
  assert.ok(out.includes('"account_id": "acct"'));
  assert.ok(out.includes('"access_token": "[hidden]"'));
});

test("maskSecrets hides a bearer header, leaves clean text alone, and does not cut ordinary words", () => {
  assert.equal(maskSecrets("authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"), "authorization: Bearer [hidden]");
  const clean = "ask-me-about-the-task-force-and-risk-management-things\nline two";
  assert.equal(maskSecrets(clean), clean);
});

test("a masked text always passes findForbidden", () => {
  assert.equal(findForbidden({ text: maskSecrets(`${FAKES.join(" ")} {"api_key":"zzz"}`) }), undefined);
  assert.equal(findForbidden(maskSecrets(FAKES[0]!)), undefined);
});
