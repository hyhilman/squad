import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApiFailure, call, callStream, type FetchLike, type StreamFetchLike } from "./client.ts";

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

test("credentials default to same-origin; the caller may ask for include", async () => {
  const seen: string[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    seen.push(init.credentials);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await call(fetchFn, "", "me", {});
  await call(fetchFn, "https://squad.example.test", "me", {}, { credentials: "include" });
  await call(fetchFn, "https://squad.example.test", "me", {}, {});
  await call(fetchFn, "https://squad.example.test", "setEnabled", { params: { runner: "codex", name: "a" }, body: { enabled: true } }, { credentials: "include" });
  assert.deepEqual(seen, ["same-origin", "include", "same-origin", "include"]);
});

test("a query of only optional fields may be left out (listAccounts as before), or given (all=1)", async () => {
  const seen: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => [] };
  };
  await call(fetchFn, "", "listAccounts", {});
  await call(fetchFn, "", "listAccounts", { query: { all: "1" } });
  await call(fetchFn, "", "removeAccount", { params: { runner: "pi", name: "a" }, body: { confirm: "pi/a" } });
  assert.deepEqual(seen, ["/api/accounts", "/api/accounts?all=1", "/api/accounts/pi/a"]);
});

// ---- squad serve ----

const encoder = new TextEncoder();
/** A fetch answer whose body comes in the given byte pieces, as a socket would cut it. */
const streamed = (status: number, pieces: readonly string[]): Awaited<ReturnType<StreamFetchLike>> => {
  let i = 0;
  const bytes = pieces.map((p) => encoder.encode(p));
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(pieces.join("")),
    body: { getReader: () => ({ read: async () => (i < bytes.length ? { done: false, value: bytes[i++]! } : { done: true, value: undefined }), releaseLock: () => {} }) },
  };
};

test("call sends extra headers such as a bearer token", async () => {
  const seen: Record<string, string>[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    seen.push(init.headers);
    return { ok: true, status: 200, json: async () => [] };
  };
  await call(fetchFn, "http://squad", "serveAccounts", {}, { headers: { authorization: "Bearer abc" } });
  assert.equal(seen[0]!.authorization, "Bearer abc");
  assert.equal(seen[0]!.accept, "application/json");
});

test("a 204 answer is undefined, and json() is not read", async () => {
  const fetchFn: FetchLike = async () => ({ ok: true, status: 204, json: async () => { throw new Error("no body"); } });
  assert.equal(await call(fetchFn, "", "closeConversation", { params: { id: "c1" } }), undefined);
});

test("a serve refusal {error} keeps its reason in the ApiFailure message", async () => {
  const fetchFn: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({ error: "cwd" }) });
  await assert.rejects(call(fetchFn, "", "serveAccounts", {}), (e: unknown) => e instanceof ApiFailure && e.status === 403 && e.body.error === "forbidden" && e.body.message === "cwd");
});

test("callStream yields each ndjson line, joins a line cut across chunks (also inside a UTF-8 character), and skips unknown types", async () => {
  const lines = ['{"type":"started","passId":"P1"}', '{"type":"output","chunk":"héllo"}', '{"type":"later","x":1}', '{"type":"result","result":{"passId":"P1"}}'];
  const all = encoder.encode(`${lines.join("\n")}\n`);
  // Cut in the middle of the two bytes of é and in the middle of a line.
  const cutAt = all.indexOf(0xc3) + 1;
  const pieces = [all.slice(0, 10), all.slice(10, cutAt), all.slice(cutAt)];
  let i = 0;
  const seen: { url: string; method: string; body?: string; headers: Record<string, string> }[] = [];
  const fetchFn: StreamFetchLike = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    return { ok: true, status: 200, json: async () => null, body: { getReader: () => ({ read: async () => (i < pieces.length ? { done: false, value: pieces[i++]! } : { done: true, value: undefined }) }) } };
  };
  const got: unknown[] = [];
  for await (const l of callStream(fetchFn, "http://squad", "sendTurn", { params: { id: "c1" }, body: { message: "hi", identity: { name: "n", email: "e@x" } } }, { headers: { authorization: "Bearer t" } })) got.push(l);
  assert.deepEqual(got, [{ type: "started", passId: "P1" }, { type: "output", chunk: "héllo" }, { type: "result", result: { passId: "P1" } }]);
  assert.equal(seen[0]!.url, "http://squad/api/conversations/c1/turns");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.headers.authorization, "Bearer t");
  assert.equal(seen[0]!.headers.accept, "application/x-ndjson");
});

test("callStream: a refusal before the stream is an ApiFailure; a last line with no newline still counts", async () => {
  await assert.rejects(async () => {
    for await (const _ of callStream(async () => streamed(401, ['{"error":"unauthorized"}']), "", "startPass", { body: {} as never })) void _;
  }, (e: unknown) => e instanceof ApiFailure && e.status === 401 && e.body.message === "unauthorized");
  const got: unknown[] = [];
  for await (const l of callStream(async () => streamed(200, ['{"type":"started","passId":"P"}\n{"type":"res', 'ult","result":{}}']), "", "startPass", { body: {} as never })) got.push(l);
  assert.deepEqual(got, [{ type: "started", passId: "P" }, { type: "result", result: {} }]);
});

test("callStream: a stream that ends with no result line throws, so the caller polls the pass", async () => {
  const got: unknown[] = [];
  await assert.rejects(async () => {
    for await (const l of callStream(async () => streamed(200, ['{"type":"started","passId":"P"}\n']), "", "startPass", { body: {} as never })) got.push(l);
  }, /ended before its result line/);
  assert.deepEqual(got, [{ type: "started", passId: "P" }]);
});
