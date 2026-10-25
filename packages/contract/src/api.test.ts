import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AUTH_PATHS, LIMIT_RESET_WHICH, NO_SESSION_ROUTES, ROUTES, SIGNED_OUT_PATH, matchPath, pathOf } from "./api.ts";

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

test("the sign-in paths are under /auth and match no /api route; the signed-out page is an app path", () => {
  for (const path of Object.values(AUTH_PATHS)) {
    assert.match(path, /^\/auth\//);
    for (const r of Object.values(ROUTES)) assert.equal(matchPath(r.path, path), undefined, path);
  }
  assert.equal(SIGNED_OUT_PATH, "/signed-out");
});

test("serve routes: under /api/, unique per method, no shadowing, and none of their names is a web route's", async () => {
  const { SERVE_ROUTES, STREAM_ROUTES, LINE_TYPES } = await import("./api.ts");
  const entries = Object.entries(SERVE_ROUTES);
  const seen = new Set<string>();
  for (const [name, r] of entries) {
    assert.match(r.path, /^\/api\//, name);
    assert.ok(!seen.has(`${r.method} ${r.path}`), name);
    seen.add(`${r.method} ${r.path}`);
    assert.ok(!Object.hasOwn(ROUTES, name), `${name} is also a web route name`);
    const sample = r.path.replace(/:([a-zA-Z]+)/g, (_, k: string) => `x${k}`);
    for (const [other, o] of entries) if (other !== name && o.method === r.method) assert.equal(matchPath(o.path, sample), undefined, `${other} matches ${sample}`);
  }
  assert.deepEqual(Object.keys(SERVE_ROUTES).sort(), ["closeConversation", "openConversation", "passStatus", "sendTurn", "serveAccounts", "startPass"]);
  assert.deepEqual([...STREAM_ROUTES], ["startPass", "sendTurn"]);
  assert.deepEqual([...LINE_TYPES], ["started", "output", "result"]);
  assert.deepEqual(matchPath(SERVE_ROUTES.sendTurn.path, "/api/conversations/abc/turns"), { id: "abc" });
  assert.equal(matchPath(SERVE_ROUTES.closeConversation.path, "/api/conversations/abc/turns"), undefined);
});
