import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LIMIT_RESET_WHICH, NO_SESSION_ROUTES, ROUTES, matchPath, pathOf } from "./api.ts";

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

test("the connect routes: start, status and the token do not shadow each other; only the token route takes no session", () => {
  assert.deepEqual(matchPath(ROUTES.connectStatus.path, "/api/connect/abc"), { connectId: "abc" });
  assert.deepEqual(matchPath(ROUTES.connectToken.path, "/api/connect/abc/token"), { pairCode: "abc" });
  assert.equal(matchPath(ROUTES.connectStatus.path, "/api/connect/abc/token"), undefined);
  assert.equal(matchPath(ROUTES.startConnect.path, "/api/connect/abc"), undefined);
  assert.equal(ROUTES.connectToken.method, "POST");
  assert.deepEqual(NO_SESSION_ROUTES, ["connectToken"]);
});

test("no concrete path of a route is matched by another route of the same method", () => {
  const entries = Object.entries(ROUTES);
  for (const [name, r] of entries) {
    const sample = r.path.replace(/:([a-zA-Z]+)/g, (_, k: string) => `x${k}`);
    for (const [other, o] of entries) {
      if (other === name || o.method !== r.method) continue;
      assert.equal(matchPath(o.path, sample), undefined, `${other} also matches ${name}'s ${sample}`);
    }
  }
});

test("the limit reset takes exactly the CLI's argument hint, [fable|full|5-hour|weekly]", () => {
  assert.deepEqual([...LIMIT_RESET_WHICH].sort(), ["5-hour", "fable", "full", "weekly"]);
  assert.deepEqual(matchPath(ROUTES.limitReset.path, "/api/accounts/claude/alice/limit-reset"), { name: "alice" });
  assert.equal(matchPath(ROUTES.limitReset.path, "/api/accounts/codex/alice/limit-reset"), undefined);
});
