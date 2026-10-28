import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ApiFailure, call, callStream, type PassLine, type PassResult, type ServePassBody, type TurnLine } from "@squad/contract";
import { nodeSocketFetch } from "@squad/contract/node";
import { makeFakeDocker, type FakeDocker } from "../../test/fake-docker.ts";
import { addAccount, markRemoved } from "../accounts/store.ts";
import { ensureHome, layoutOf, type HomeLayout } from "../home.ts";
import { makeLog } from "../log.ts";
import { openStore, type Store } from "../store/db.ts";
import { startServe, type ServeHandle, type ServeOpts } from "./server.ts";
import { addToken } from "./tokens.ts";

const NOW = new Date("2026-10-25T10:00:00.000Z");
const BASE = "http://squad";
const ME = { uid: process.getuid!(), gid: process.getgid!() };

interface Rig {
  root: string;
  home: HomeLayout;
  store: Store;
  fake: FakeDocker;
  repo: string;
  sock: string;
  token: string;
  other: string;
  serve: ServeHandle;
  headers: Record<string, string>;
  f: ReturnType<typeof nodeSocketFetch>;
  logs: string[];
}

async function rig(t: TestContext, more: Partial<ServeOpts> = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "srv-"));
  const home = layoutOf(join(root, "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  for (const name of ["acct-one", "acct-two"]) {
    addAccount(store.db, { runner: "pi", name, kind: "key", ownerEmail: "owner@example.com" }, NOW);
    mkdirSync(join(home.accounts, "pi", name), { recursive: true });
    writeFileSync(join(home.accounts, "pi", name, "auth.json"), '{"fake":"not-a-real-key"}');
  }
  const work = join(root, "work");
  const repo = join(work, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const fake = makeFakeDocker(join(root, "bin"));
  const { token } = addToken(store.db, "dg-test", { accounts: ["pi/acct-one"], roots: [work], images: [] }, NOW);
  const { token: other } = addToken(store.db, "other", { accounts: ["pi/acct-one", "pi/acct-two"], roots: [work], images: [] }, NOW);
  const sock = join(root, "s.sock");
  const logs: string[] = [];
  const serve = await startServe({
    env: { SQUAD_DOCKER: fake.path, SQUAD_STOP_GRACE_S: "3", SQUAD_SERVE_DRAIN_S: "0.3" },
    home, store, socket: sock, log: makeLog((l) => logs.push(l)), user: ME, ...more,
  });
  t.after(async () => {
    await serve.stop();
    store.close();
  });
  return { root, home, store, fake, repo, sock, token, other, serve, headers: { authorization: `Bearer ${token}` }, f: nodeSocketFetch(sock), logs };
}

const body = (r: Rig, more: Partial<ServePassBody> = {}): ServePassBody => ({
  runner: "pi", account: "pi/acct-one", model: "opencode-go/hy4-preview", prompt: "say ok", cwd: r.repo,
  caller: { flow: "fix", action: "fix:pi" }, identity: { name: "Bot", email: "bot@example.com" }, ...more,
});

/** One raw request over the socket: the status, the content type and the whole body text. */
function raw(sock: string, method: string, path: string, headers: Record<string, string>, text?: string): Promise<{ status: number; type: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, method, path, headers: { ...headers, ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }) } }, (res) => {
      let out = "";
      res.on("data", (c: Buffer) => (out += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"] ?? ""), text: out }));
    });
    req.on("error", reject);
    req.end(text);
  });
}

const collect = async <L>(it: AsyncIterable<L>): Promise<L[]> => {
  const out: L[] = [];
  for await (const l of it) out.push(l);
  return out;
};

const poll = async <T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("the socket is mode 0600 and a wrong, missing or revoked token is a 401 {error} with no detail", async (t) => {
  const r = await rig(t);
  assert.equal(statSync(r.sock).mode & 0o777, 0o600);
  for (const h of [{} as Record<string, string>, { authorization: "Bearer sqd_wrong" }, { authorization: r.token }]) {
    const res = await raw(r.sock, "GET", "/api/accounts", h);
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(res.text), { error: "unauthorized" });
  }
  // An unknown path without a token learns nothing either.
  assert.equal((await raw(r.sock, "GET", "/api/nope", {})).status, 401);
  r.store.db.prepare("UPDATE serve_tokens SET revoked_at = ? WHERE project = 'dg-test'").run(NOW.toISOString());
  assert.equal((await raw(r.sock, "GET", "/api/accounts", r.headers)).status, 401);
});

test("GET /api/accounts lists only the token's accounts, with no owner or account-user email", async (t) => {
  const r = await rig(t);
  const list = await call(r.f, BASE, "serveAccounts", {}, { headers: r.headers });
  assert.deepEqual(list.map((a) => [a.account, a.runner]), [["pi/acct-one", "pi"]]);
  const text = JSON.stringify(list);
  assert.ok(!text.includes("owner@example.com"));
  assert.ok(!("ownerEmail" in list[0]!) && !("loginEmail" in list[0]!) && !("consentBy" in list[0]!));
});

/** A pi key account with its folder, as the rig makes them. */
const piAccount = (r: Rig, name: string): void => {
  addAccount(r.store.db, { runner: "pi", name, kind: "key", ownerEmail: "owner@example.com" }, NOW);
  mkdirSync(join(r.home.accounts, "pi", name), { recursive: true });
  writeFileSync(join(r.home.accounts, "pi", name, "auth.json"), '{"fake":"not-a-real-key"}');
};

/** A token for the rig's work folder, with these accounts or patterns. */
const tokenFor = (r: Rig, project: string, accounts: string[]): Record<string, string> =>
  ({ authorization: `Bearer ${addToken(r.store.db, project, { accounts, roots: [join(r.root, "work")], images: [] }, NOW).token}` });

const lastResult = async (r: Rig, b: ServePassBody, headers: Record<string, string>) =>
  ((await collect(callStream(r.f, BASE, "startPass", { body: b }, { headers }))).at(-1) as Extract<PassLine, { type: "result" }>).result;

test("a '*' token: an account added later is listed and may run; a removed one is gone and a 403", async (t) => {
  const r = await rig(t);
  const headers = tokenFor(r, "all", ["*"]);
  const listed = async () => (await call(r.f, BASE, "serveAccounts", {}, { headers })).map((a) => a.account);
  assert.deepEqual(await listed(), ["pi/acct-one", "pi/acct-two"]);
  piAccount(r, "acct-three");
  assert.deepEqual(await listed(), ["pi/acct-one", "pi/acct-three", "pi/acct-two"]);
  const ran = await lastResult(r, body(r, { account: "pi/acct-three" }), headers);
  assert.equal(ran.account, "pi/acct-three");
  assert.equal(ran.failure, undefined);
  markRemoved(r.store.db, "pi/acct-three");
  assert.deepEqual(await listed(), ["pi/acct-one", "pi/acct-two"]);
  const res = await raw(r.sock, "POST", "/api/passes", headers, JSON.stringify(body(r, { account: "pi/acct-three" })));
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.text), { error: "out of scope: account" });
});

test("a 'codex/*' token allows codex accounts, also later ones, and refuses claude and pi", async (t) => {
  const r = await rig(t);
  const headers = tokenFor(r, "codex-only", ["codex/*"]);
  assert.deepEqual(await call(r.f, BASE, "serveAccounts", {}, { headers }), []);
  addAccount(r.store.db, { runner: "codex", name: "seat", kind: "login" }, NOW);
  addAccount(r.store.db, { runner: "claude", name: "seat", kind: "token" }, NOW);
  assert.deepEqual((await call(r.f, BASE, "serveAccounts", {}, { headers })).map((a) => a.account), ["codex/seat"]);
  const post = async (b: Partial<ServePassBody>) => {
    const res = await raw(r.sock, "POST", "/api/passes", headers, JSON.stringify(body(r, b)));
    return [res.status, JSON.parse(res.text)];
  };
  // The account check comes before the paths: a cwd refusal means the account passed.
  assert.deepEqual(await post({ runner: "codex", account: "codex/seat", cwd: r.root }), [403, { error: "out of scope: cwd" }]);
  assert.deepEqual(await post({ runner: "codex", account: undefined, cwd: r.root }), [403, { error: "out of scope: cwd" }]);
  assert.deepEqual(await post({ runner: "claude", account: "claude/seat" }), [403, { error: "out of scope: account" }]);
  assert.deepEqual(await post({ runner: "claude", account: undefined }), [403, { error: "out of scope: account" }]);
  assert.deepEqual(await post({ account: "pi/acct-one" }), [403, { error: "out of scope: account" }]);
  assert.equal(r.fake.callsOf("run").length, 0);
});

test("with no account a 'pi/*' token's pass draws from the live pi accounts: a later one yes, a removed one never", async (t) => {
  const r = await rig(t);
  const headers = tokenFor(r, "pool", ["pi/*"]);
  piAccount(r, "acct-three");
  markRemoved(r.store.db, "pi/acct-one");
  markRemoved(r.store.db, "pi/acct-two");
  const ran = await lastResult(r, body(r, { account: undefined }), headers);
  assert.equal(ran.account, "pi/acct-three");
  markRemoved(r.store.db, "pi/acct-three");
  const res = await raw(r.sock, "POST", "/api/passes", headers, JSON.stringify(body(r, { account: undefined })));
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.text), { error: "out of scope: account" });
  const runs = r.fake.callsOf("run");
  assert.equal(runs.length, 1);
  assert.ok(!runs[0]!.join(" ").includes("acct-one") && !runs[0]!.join(" ").includes("acct-two"));
});

test("a conversation on a '*' token: a turn is refused once its account is removed", async (t) => {
  const r = await rig(t);
  const headers = tokenFor(r, "all", ["*"]);
  piAccount(r, "acct-three");
  const { identity } = body(r);
  const conv = await call(r.f, BASE, "openConversation", { body: { runner: "pi", account: "pi/acct-three", model: "opencode-go/hy4-preview", cwd: r.repo, caller: { flow: "chat", action: "chat:pi" }, identity } }, { headers });
  assert.equal(conv.account, "pi/acct-three");
  markRemoved(r.store.db, "pi/acct-three");
  await assert.rejects(collect(callStream(r.f, BASE, "sendTurn", { params: { id: conv.id }, body: { message: "x", identity } }, { headers })), (e: unknown) => e instanceof ApiFailure && e.status === 403);
});

test("POST /api/passes streams started, output and result; the result is the pass's, and GET gives it back", async (t) => {
  const r = await rig(t);
  const lines = await collect(callStream(r.f, BASE, "startPass", { body: body(r) }, { headers: r.headers }));
  assert.equal(lines[0]!.type, "started");
  assert.equal(lines.at(-1)!.type, "result");
  assert.ok(lines.slice(1, -1).length > 0 && lines.slice(1, -1).every((l) => l.type === "output"));
  const passId = (lines[0] as Extract<PassLine, { type: "started" }>).passId;
  const result = (lines.at(-1) as Extract<PassLine, { type: "result" }>).result;
  assert.equal(result.passId, passId);
  assert.equal(result.account, "pi/acct-one");
  assert.equal(result.failure, undefined);
  assert.ok(result.text.length > 0);
  // The output lines are the CLI's stdout as it came.
  const out = lines.filter((l): l is Extract<PassLine, { type: "output" }> => l.type === "output").map((l) => l.chunk).join("");
  assert.match(out, /agent_end/);
  const status = await call(r.f, BASE, "passStatus", { params: { passId } }, { headers: r.headers });
  assert.deepEqual(status, { running: false, result });
  // The pass row carries the token's project and the identity went into the container.
  const row = r.store.db.prepare("SELECT project, outcome FROM passes WHERE id = ?").get(passId) as { project: string; outcome: string };
  assert.deepEqual({ ...row }, { project: "dg-test", outcome: "ok" });
  const run = r.fake.callsOf("run")[0]!;
  assert.ok(run.includes("GIT_AUTHOR_EMAIL=bot@example.com"));
  assert.ok(run.includes("--user") && run.includes(`${ME.uid}:${ME.gid}`));
});

test("the pass row exists before the started line arrives", async (t) => {
  const r = await rig(t);
  const res = await r.f(`${BASE}/api/passes`, { method: "POST", headers: { ...r.headers, "content-type": "application/json" }, body: JSON.stringify(body(r)), credentials: "same-origin" });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("\n")) text += Buffer.from((await reader.read()).value!).toString("utf8");
  const first = JSON.parse(text.slice(0, text.indexOf("\n"))) as { type: string; passId: string };
  assert.equal(first.type, "started");
  assert.ok(r.store.db.prepare("SELECT 1 FROM passes WHERE id = ?").get(first.passId) !== undefined, "pass row");
  assert.ok(r.store.db.prepare("SELECT 1 FROM serve_passes WHERE id = ?").get(first.passId) !== undefined, "serve row");
  while (!(await reader.read()).done);
});

test("a dropped client does not stop the pass: GET shows it running, then its result", async (t) => {
  const r = await rig(t);
  r.fake.setModes("slow");
  const passId = await new Promise<string>((resolve, reject) => {
    const req = request({ socketPath: r.sock, method: "POST", path: "/api/passes", headers: { ...r.headers, "content-type": "application/json" } }, (res) => {
      let buf = "";
      res.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        resolve((JSON.parse(buf.slice(0, nl)) as { passId: string }).passId);
        req.destroy();
      });
    });
    req.on("error", () => {});
    req.on("close", () => reject(new Error("closed before started")));
    req.end(JSON.stringify(body(r)));
  });
  const running = await call(r.f, BASE, "passStatus", { params: { passId } }, { headers: r.headers });
  assert.equal(running.running, true);
  if (running.running) {
    assert.equal(running.passId, passId);
    assert.equal(running.account, "pi/acct-one");
    assert.match(running.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
  const done = await poll(async () => {
    const s = await call(r.f, BASE, "passStatus", { params: { passId } }, { headers: r.headers });
    return s.running ? undefined : s;
  });
  assert.equal((done.result as PassResult).failure, undefined);
  assert.equal(done.result.passId, passId);
  const row = r.store.db.prepare("SELECT ended_at, result FROM serve_passes WHERE id = ?").get(passId) as { ended_at: string | null; result: string | null };
  assert.ok(row.ended_at !== null && row.result !== null);
});

test("refusals before the stream are plain JSON: 400 for a bad body, 403 out of scope; no row and no container", async (t) => {
  const r = await rig(t);
  const post = (b: unknown) => raw(r.sock, "POST", "/api/passes", r.headers, JSON.stringify(b));
  const cases: [unknown, number, string][] = [
    [{ ...body(r), probe: true }, 400, "unknown field probe"],
    [{ ...body(r), pool: "all" }, 400, "unknown field pool"],
    [{ ...body(r), identity: undefined }, 400, "identity must be {name, email}"],
    [{ ...body(r), prompt: 7 }, 400, "prompt must be a string"],
    [{ ...body(r), account: "pi/acct-two" }, 403, "out of scope: account"],
    [{ ...body(r), runner: "codex", account: undefined }, 403, "out of scope: account"],
    [{ ...body(r), cwd: r.root }, 403, "out of scope: cwd"],
    [{ ...body(r), mounts: [{ host: r.home.root, container: "/x", ro: true }] }, 403, "out of scope: mounts[0].host"],
    [{ ...body(r), image: "evil/pi:1" }, 403, "out of scope: image"],
  ];
  for (const [b, status, error] of cases) {
    const res = await post(b);
    assert.equal(res.status, status, error);
    assert.match(res.type, /^application\/json/);
    assert.deepEqual(JSON.parse(res.text), { error }, error);
  }
  const notJson = await raw(r.sock, "POST", "/api/passes", r.headers, "{nope");
  assert.equal(notJson.status, 400);
  assert.equal(r.store.db.prepare("SELECT count(*) AS n FROM passes").get()!.n, 0);
  assert.equal(r.fake.callsOf("run").length, 0);
});

test("a cwd owned by another uid is a 403 that names both uids, with no row and no container", async (t) => {
  const r = await rig(t, { user: { uid: ME.uid + 1, gid: ME.gid } });
  const res = await raw(r.sock, "POST", "/api/passes", r.headers, JSON.stringify(body(r)));
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.text), { error: `cwd ${r.repo} is owned by uid ${ME.uid}, squad serve runs as uid ${ME.uid + 1}` });
  assert.equal(r.store.db.prepare("SELECT count(*) AS n FROM passes").get()!.n, 0);
  assert.equal(r.fake.callsOf("run").length, 0);
});

test("no account free is a started line and a result with the failure, never a status", async (t) => {
  const r = await rig(t);
  r.fake.setModes("busy");
  const lines = await collect(callStream(r.f, BASE, "startPass", { body: body(r) }, { headers: r.headers }));
  assert.equal(lines[0]!.type, "started");
  const last = lines.at(-1)!;
  assert.equal(last.type, "result");
  if (last.type === "result") assert.equal(last.result.failure?.kind, "no-account");
});

test("with no account squad picks only among the token's: never another account, even when its one is busy", async (t) => {
  const r = await rig(t);
  const ran = async () => (await collect(callStream(r.f, BASE, "startPass", { body: body(r, { account: undefined }) }, { headers: r.headers }))).at(-1) as Extract<PassLine, { type: "result" }>;
  assert.equal((await ran()).result.account, "pi/acct-one");
  r.fake.setModes("busy");
  assert.equal((await ran()).result.failure?.kind, "no-account");
  const runs = r.fake.callsOf("run");
  assert.equal(runs.length, 2);
  assert.ok(runs.every((c) => !c.join(" ").includes("acct-two")));
});

test("a pool pass that moves past a busy account reports the one that ran, live and at the end", async (t) => {
  const r = await rig(t);
  r.fake.setModes("busy", "hang");
  const headers = { authorization: `Bearer ${r.other}` };
  const linesP = collect(callStream(r.f, BASE, "startPass", { body: body(r, { account: undefined }) }, { headers }));
  await poll(async () => (r.fake.callsOf("run").length === 2 ? true : undefined));
  const handle = (r.store.db.prepare("SELECT id FROM serve_passes").get() as { id: string }).id;
  const live = await call(r.f, BASE, "passStatus", { params: { passId: handle } }, { headers });
  await r.serve.stop();
  const result = ((await linesP).at(-1) as Extract<PassLine, { type: "result" }>).result;
  const busy = r.store.db.prepare("SELECT account FROM passes WHERE outcome = 'busy'").get() as { account: string };
  assert.ok(result.account !== null && result.account !== busy.account);
  assert.ok(live.running && live.account === result.account);
  const row = r.store.db.prepare("SELECT account FROM serve_passes WHERE id = ?").get(handle) as { account: string };
  assert.equal(row.account, result.account);
});

test("a pass is visible only to its token; an unknown id is a 404", async (t) => {
  const r = await rig(t);
  const lines = await collect(callStream(r.f, BASE, "startPass", { body: body(r) }, { headers: r.headers }));
  const passId = (lines[0] as { passId: string }).passId;
  await assert.rejects(call(r.f, BASE, "passStatus", { params: { passId } }, { headers: { authorization: `Bearer ${r.other}` } }), (e: unknown) => e instanceof ApiFailure && e.status === 404);
  await assert.rejects(call(r.f, BASE, "passStatus", { params: { passId: "01NOPE" } }, { headers: r.headers }), (e: unknown) => e instanceof ApiFailure && e.status === 404);
});

test("conversations: open, a streamed turn, bound to the token, DELETE 204, then a turn is refused", async (t) => {
  const r = await rig(t);
  const { identity, ...rest } = body(r);
  void rest;
  const conv = await call(r.f, BASE, "openConversation", { body: { runner: "pi", account: "pi/acct-one", model: "opencode-go/hy4-preview", cwd: r.repo, caller: { flow: "chat", action: "chat:pi" }, identity } }, { headers: r.headers });
  assert.deepEqual(Object.keys(conv).sort(), ["account", "createdAt", "cwd", "id", "model", "runner"]);
  assert.equal(conv.account, "pi/acct-one");
  const lines: TurnLine[] = await collect(callStream(r.f, BASE, "sendTurn", { params: { id: conv.id }, body: { message: "hello", identity } }, { headers: r.headers }));
  assert.equal(lines[0]!.type, "started");
  const last = lines.at(-1)!;
  assert.equal(last.type, "result");
  if (last.type !== "result") return;
  assert.equal(last.result.account, "pi/acct-one");
  assert.equal(last.result.failure, undefined);
  assert.ok(!("logPath" in last.result));
  const status = await call(r.f, BASE, "passStatus", { params: { passId: (lines[0] as { passId: string }).passId } }, { headers: r.headers });
  assert.deepEqual(status, { running: false, result: last.result });
  // Another token sees no such conversation.
  const otherHeaders = { authorization: `Bearer ${r.other}` };
  await assert.rejects(collect(callStream(r.f, BASE, "sendTurn", { params: { id: conv.id }, body: { message: "x", identity } }, { headers: otherHeaders })), (e: unknown) => e instanceof ApiFailure && e.status === 404);
  await assert.rejects(call(r.f, BASE, "closeConversation", { params: { id: conv.id } }, { headers: otherHeaders }), (e: unknown) => e instanceof ApiFailure && e.status === 404);
  const del = await raw(r.sock, "DELETE", `/api/conversations/${conv.id}`, r.headers);
  assert.equal(del.status, 204);
  assert.equal(del.text, "");
  await assert.rejects(collect(callStream(r.f, BASE, "sendTurn", { params: { id: conv.id }, body: { message: "x", identity } }, { headers: r.headers })), (e: unknown) => e instanceof ApiFailure && e.status === 409);
});

test("a conversation's id is not a session a pass may name", async (t) => {
  const r = await rig(t);
  const conv = await call(r.f, BASE, "openConversation", { body: { runner: "pi", account: "pi/acct-one", model: "m", cwd: r.repo, caller: { flow: "chat", action: "chat:pi" }, identity: body(r).identity } }, { headers: { authorization: `Bearer ${r.other}` } });
  const res = await raw(r.sock, "POST", "/api/passes", r.headers, JSON.stringify(body(r, { session: conv.id })));
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.text), { error: "out of scope: session" });
});

test("stop with nothing running is at once and removes the socket", async (t) => {
  const r = await rig(t);
  const t0 = Date.now();
  await r.serve.stop();
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(!existsSync(r.sock));
});

test("stop lets a pass run for the drain time, then stops its container with the grace time; the client gets its result", async (t) => {
  const r = await rig(t);
  r.fake.setModes("hang");
  const linesP = collect(callStream(r.f, BASE, "startPass", { body: body(r) }, { headers: r.headers }));
  await poll(async () => (r.fake.callsOf("run").length > 0 ? true : undefined));
  await new Promise((res) => setTimeout(res, 100));
  const name = r.fake.callsOf("run")[0]![r.fake.callsOf("run")[0]!.indexOf("--name") + 1]!;
  const t0 = Date.now();
  await r.serve.stop();
  assert.ok(Date.now() - t0 >= 250, "it waited for the drain time");
  assert.deepEqual(r.fake.callsOf("stop")[0], ["stop", "-t", "3", name]);
  const lines = await linesP;
  const last = lines.at(-1)!;
  assert.equal(last.type, "result");
  if (last.type === "result") assert.equal(last.result.failure?.kind, "provider");
  assert.ok(!existsSync(r.sock));
});

test("a new connection while stopping is refused", async (t) => {
  const r = await rig(t);
  r.fake.setModes("hang");
  const linesP = collect(callStream(r.f, BASE, "startPass", { body: body(r) }, { headers: r.headers }));
  await poll(async () => (r.fake.callsOf("run").length > 0 ? true : undefined));
  // A kept-alive connection could still send; a new one cannot connect.
  const stopping = r.serve.stop();
  await new Promise((res) => setTimeout(res, 50));
  await assert.rejects(raw(r.sock, "GET", "/api/accounts", r.headers));
  await stopping;
  await linesP;
});

test("a second serve on the same home refuses before it touches any row; a stale socket file is replaced", async (t) => {
  const r = await rig(t);
  // A pass in flight: its row is open, and the fake docker lists no container.
  r.fake.setModes("hang");
  const linesP = collect(callStream(r.f, BASE, "startPass", { body: body(r) }, { headers: r.headers }));
  await poll(async () => (r.fake.callsOf("run").length > 0 ? true : undefined));
  const open = () => (r.store.db.prepare("SELECT count(*) AS n FROM serve_passes WHERE ended_at IS NULL").get() as { n: number }).n;
  assert.equal(open(), 1);
  await assert.rejects(startServe({ env: { SQUAD_DOCKER: r.fake.path }, home: r.home, store: r.store, socket: r.sock, log: makeLog(() => {}), user: ME }), /already listens/);
  // Another socket path or a port on the same home is refused too.
  await assert.rejects(startServe({ env: { SQUAD_DOCKER: r.fake.path }, home: r.home, store: r.store, socket: join(r.root, "b.sock"), log: makeLog(() => {}), user: ME }), /already listens/);
  await assert.rejects(startServe({ env: { SQUAD_DOCKER: r.fake.path }, home: r.home, store: r.store, port: 0, log: makeLog(() => {}), user: ME }), /already listens/);
  assert.equal(open(), 1, "the running pass was not ended as lost");
  assert.deepEqual([r.fake.callsOf("ps"), r.fake.callsOf("logs"), r.fake.callsOf("wait")], [[], [], []]);
  await r.serve.stop();
  await linesP;
  // A socket file with nobody behind it, as a killed serve leaves.
  const stale = join(r.root, "stale.sock");
  spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, "SIGKILL"))`]);
  assert.ok(existsSync(stale));
  await assert.rejects(new Promise((res, rej) => createConnection(stale).on("connect", res).on("error", rej)));
  const again = await startServe({ env: { SQUAD_DOCKER: r.fake.path }, home: r.home, store: r.store, socket: stale, log: makeLog(() => {}), user: ME });
  await again.stop();
});

test("--port binds 127.0.0.1 and works with the global fetch", async (t) => {
  const r = await rig(t);
  // One serve per home: the socket one goes first.
  await r.serve.stop();
  const byPort = await startServe({ env: { SQUAD_DOCKER: r.fake.path }, home: r.home, store: r.store, port: 0, log: makeLog(() => {}), user: ME });
  t.after(() => byPort.stop());
  assert.match(byPort.address, /^http:\/\/127\.0\.0\.1:\d+$/);
  const list = await call(fetch, byPort.address, "serveAccounts", {}, { headers: r.headers });
  assert.deepEqual(list.map((a) => a.account), ["pi/acct-one"]);
  const lines = await collect(callStream(fetch, byPort.address, "startPass", { body: body(r) }, { headers: r.headers }));
  assert.deepEqual([lines[0]!.type, lines.at(-1)!.type], ["started", "result"]);
});

test("an output piece and a result never carry a credential: masked, or dropped when masking is not enough", async () => {
  const { safeChunk, safeResult } = await import("./server.ts");
  const key = `sk-${"a".repeat(30)}`;
  assert.equal(safeChunk(`{"text":"here ${key} end"}`), '{"text":"here [hidden] end"}');
  const r = safeResult({ passId: "P", account: "pi/a", text: `key ${key}`, texts: [key], turns: 1, model: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, failure: { kind: "auth", code: "401", message: `bad ${key}` }, logPath: null });
  assert.equal(r.text, "key [hidden]");
  assert.deepEqual(r.texts, ["[hidden]"]);
  assert.equal(r.failure?.message, "bad [hidden]");
});
