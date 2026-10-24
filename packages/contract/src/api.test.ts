import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ROUTES, matchPath, pathOf } from "./api.ts";

test("every route path is under /api/ and unique per method", () => {
  const seen = new Set<string>();
  for (const [name, r] of Object.entries(ROUTES)) {
    assert.match(r.path, /^\/api\//, name);
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
  }
});

test("pathOf fills and encodes params, and refuses a missing one", () => {
  assert.equal(pathOf(ROUTES.getAccount.path, { runner: "codex", name: "a b" }), "/api/accounts/codex/a%20b");
  assert.throws(() => pathOf(ROUTES.getAccount.path, { runner: "codex" }), /missing path param name/);
});

test("matchPath is the inverse of pathOf", () => {
  const p = pathOf(ROUTES.setFloor.path, { runner: "pi", name: "x/y" });
  assert.deepEqual(matchPath(ROUTES.setFloor.path, p), { runner: "pi", name: "x/y" });
  assert.equal(matchPath(ROUTES.setFloor.path, "/api/accounts/pi/x"), undefined);
  assert.equal(matchPath(ROUTES.getAccount.path, "/api/accounts/pi/"), undefined);
});

test("the code route sits under its login and does not shadow the status route", () => {
  assert.deepEqual(matchPath(ROUTES.submitLoginCode.path, "/api/logins/abc/code"), { loginId: "abc" });
  assert.equal(matchPath(ROUTES.loginStatus.path, "/api/logins/abc/code"), undefined);
  assert.equal(matchPath(ROUTES.submitLoginCode.path, "/api/logins/abc"), undefined);
});

test("the catalog routes: a model id with dots, colons, slashes and an @ survives pathOf then matchPath", () => {
  for (const modelId of ["qwen3.8-max", "solar-mini4:free", "@cf/meta/llama-4.1", "a b/c%d"]) {
    const p = pathOf(ROUTES.catalogModel.path, { modelId });
    assert.equal(p.split("/").length, 5, "the id stays one path part");
    assert.deepEqual(matchPath(ROUTES.catalogModel.path, p), { modelId });
  }
  assert.deepEqual(matchPath(ROUTES.catalogProvider.path, "/api/catalog/providers/opencode-go"), { provider: "opencode-go" });
  assert.deepEqual(matchPath(ROUTES.catalogProviders.path, "/api/catalog/providers"), {});
  assert.equal(matchPath(ROUTES.catalogProvider.path, "/api/catalog/providers"), undefined);
});
