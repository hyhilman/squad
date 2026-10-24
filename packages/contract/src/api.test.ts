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
