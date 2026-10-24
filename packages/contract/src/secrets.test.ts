import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findForbidden } from "./secrets.ts";

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
