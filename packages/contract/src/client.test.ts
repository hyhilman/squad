import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApiFailure, call, type FetchLike } from "./client.ts";

test("call builds the method, path, query and body from the route", async () => {
  const seen: { url: string; method: string; body?: string }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    seen.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    return { ok: true, status: 200, json: async () => [] };
  };
  await call(fetchFn, "", "usage", { query: { by: "account", since: "7d" } });
  await call(fetchFn, "http://h", "setFloor", { params: { runner: "codex", name: "a" }, body: { floor5h: 20, floorWeek: null } });
  assert.deepEqual(seen, [
    { url: "/api/usage?by=account&since=7d", method: "GET" },
    { url: "http://h/api/accounts/codex/a/floor", method: "PUT", body: '{"floor5h":20,"floorWeek":null}' },
  ]);
});

test("an error answer becomes ApiFailure with its code", async () => {
  const fetchFn: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden", message: "not your account" }) });
  await assert.rejects(call(fetchFn, "", "me", {}), (e: unknown) => e instanceof ApiFailure && e.status === 403 && e.body.error === "forbidden");
});

test("call sends x-squad-csrf on every non-GET request and on no GET", async () => {
  const seen: { method: string; csrf: string | undefined }[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    seen.push({ method: init.method, csrf: init.headers["x-squad-csrf"] });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await call(fetchFn, "", "me", {});
  await call(fetchFn, "", "setEnabled", { params: { runner: "codex", name: "a" }, body: { enabled: true } });
  await call(fetchFn, "", "consent", { params: { runner: "codex", name: "a" }, body: { agree: true } });
  await call(fetchFn, "", "startLogin", { params: { runner: "codex", name: "a" } });
  assert.deepEqual(seen, [
    { method: "GET", csrf: undefined },
    { method: "PUT", csrf: "1" },
    { method: "POST", csrf: "1" },
    { method: "POST", csrf: "1" },
  ]);
});
