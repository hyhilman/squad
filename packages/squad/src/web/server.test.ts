import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { ROUTES, findForbidden, type AccountView, type ApiError, type Me, type PassDetail, type PassView, type RoomPoint, type UsageRow, type UsageSeriesPoint } from "@squad/contract";
import { CLIENT_ID, startFakeOidc, type FakeOidc } from "../../test/fake-oidc.ts";
import { emptyHealth } from "../accounts/health.ts";
import { addAccount, getAccount, putHealth, recordRoom, setState } from "../accounts/store.ts";
import { fakeIdToken } from "../../test/fake-jwt.ts";
import { writePassFiles } from "../passfiles.ts";
import { ensureHome, layoutOf, type HomeLayout } from "../home.ts";
import { makeLog } from "../log.ts";
import { openStore, type Store } from "../store/db.ts";
import { startWeb, type WebHandle, type WebOpts } from "./server.ts";

const PUBLIC = "http://127.0.0.1:3000";
const NOW = new Date("2026-10-24T12:00:00.000Z");

let p: FakeOidc;
before(async () => { p = await startFakeOidc("ES256"); });
after(async () => { await p.close(); });

/** Rigs not closed yet. A test that fails before its own `r.close()` would leave a server listening, and node would wait for it forever. */
const openRigs = new Set<Rig>();
afterEach(async () => { for (const r of [...openRigs]) await r.close(); });

interface Rig { web: WebHandle; base: string; store: Store; home: HomeLayout; logs: string[]; close: () => Promise<void> }

async function rig(extra: Partial<WebOpts> = {}, env: Record<string, string> = {}): Promise<Rig> {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "web-")), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const logs: string[] = [];
  const web = await startWeb({
    env: { SQUAD_WEB_URL: PUBLIC, SQUAD_WEB_PORT: "0", SQUAD_OIDC_ISSUER: p.issuer, SQUAD_OIDC_CLIENT_ID: CLIENT_ID, ...env },
    home, store, now: () => NOW, busy: () => false, log: makeLog((l) => logs.push(l)), ...extra,
  });
  const rg: Rig = { web, base: `http://127.0.0.1:${web.port}`, store, home, logs, close: async () => { if (!openRigs.delete(rg)) return; await web.close(); store.close(); } };
  openRigs.add(rg);
  return rg;
}

/** Signs in through the real /auth routes against the fake provider. Returns the Cookie header. */
async function signIn(r: Rig, email: string, groups: string[] = ["squad"]): Promise<string> {
  p.mutate = (c) => { c.email = email; c.groups = groups; c.name = email.split("@")[0]; };
  const login = await fetch(`${r.base}/auth/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const loginCookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
  const auth = await fetch(login.headers.get("location")!, { redirect: "manual" });
  const back = new URL(auth.headers.get("location")!);
  const cb = await fetch(`${r.base}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: loginCookie } });
  assert.equal(cb.status, 302, "callback redirects home");
  const sess = cb.headers.getSetCookie().find((c) => c.startsWith("squad_session="));
  assert.ok(sess, "a session cookie");
  return sess.split(";")[0]!;
}

interface Reply<T> { status: number; body: T; headers: Headers }
async function api<T = unknown>(r: Rig, cookie: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
  const write = method !== "GET";
  const res = await fetch(`${r.base}${path}`, {
    method,
    headers: { ...(cookie === undefined ? {} : { cookie }), ...(write ? { "x-squad-csrf": "1", origin: PUBLIC } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text === "" ? undefined : JSON.parse(text)) as T, headers: res.headers };
}

function seed(r: Rig): void {
  addAccount(r.store.db, { runner: "codex", name: "alice", kind: "login", ownerEmail: "Alice@Example.Test" }, NOW);
  addAccount(r.store.db, { runner: "pi", name: "alice-key", kind: "key", ownerEmail: "alice@example.test" }, NOW);
  addAccount(r.store.db, { runner: "pi", name: "bob", kind: "key", ownerEmail: "bob@example.test" }, NOW);
  addAccount(r.store.db, { runner: "pi", name: "nobody", kind: "key" }, NOW);
  putHealth(r.store.db, { ...emptyHealth("codex/alice"), left5h: 80, leftWeek: 60, readAt: NOW.toISOString(), lastFailCode: "rate_limited" });
}

test("every /api route needs a session: 401 with an ApiError", async () => {
  const r = await rig();
  for (const [name, route] of Object.entries(ROUTES)) {
    const path = route.path.replace(":runner", "codex").replace(":name", "a").replace(":loginId", "x");
    const res = await api<ApiError>(r, undefined, route.method, path, route.method === "GET" ? undefined : {});
    assert.equal(res.status, 401, name);
    assert.equal(res.body.error, "unauthenticated", name);
  }
  const forged = await api<ApiError>(r, "squad_session=AAAA", "GET", "/api/me");
  assert.equal(forged.status, 401);
  await r.close();
});

test("sign in through /auth, then me gives the email and name; an unknown /api path is a JSON 404", async () => {
  const r = await rig();
  const c = await signIn(r, "alice@example.test");
  const me = await api<Me>(r, c, "GET", "/api/me");
  assert.deepEqual(me.body, { email: "alice@example.test", name: "alice", admin: false });
  const nope = await api<ApiError>(r, c, "GET", "/api/nothing");
  assert.equal(nope.status, 404);
  assert.equal(nope.body.error, "not-found");
  assert.match(nope.headers.get("content-type") ?? "", /application\/json/);
  const wrongMethod = await api<ApiError>(r, c, "DELETE", "/api/me");
  assert.equal(wrongMethod.status, 405);
  await r.close();
});

test("a failed sign-in gives a fixed refusal with no detail; a missing group is 403", async () => {
  const r = await rig({}, { SQUAD_OIDC_GROUP: "squad-admins" });
  await assert.rejects(signIn(r, "alice@example.test", ["other"]));
  const login = await fetch(`${r.base}/auth/login`, { redirect: "manual" });
  const lc = login.headers.getSetCookie()[0]!.split(";")[0]!;
  const auth = await fetch(login.headers.get("location")!, { redirect: "manual" });
  const back = new URL(auth.headers.get("location")!);
  const cb = await fetch(`${r.base}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: lc } });
  assert.equal(cb.status, 403);
  assert.equal(await cb.text(), "sign-in refused\n");
  assert.ok(!cb.headers.getSetCookie().some((c) => c.startsWith("squad_session=") && !/Max-Age=0/.test(c)));
  const bad = await fetch(`${r.base}/auth/callback?code=x&state=y`, { redirect: "manual" });
  assert.equal(bad.status, 400);
  assert.ok(r.logs.some((l) => /event=signin_refused/.test(l) && /reason=not-in-group/.test(l)));
  await r.close();
});

test("a person sees only the accounts they own; email case does not matter; others are 404", async () => {
  const r = await rig();
  seed(r);
  const alice = await signIn(r, "alice@example.test");
  const bob = await signIn(r, "bob@example.test");
  const list = await api<AccountView[]>(r, alice, "GET", "/api/accounts");
  assert.deepEqual(list.body.map((a) => a.account), ["codex/alice", "pi/alice-key"]);
  assert.deepEqual((await api<AccountView[]>(r, bob, "GET", "/api/accounts")).body.map((a) => a.account), ["pi/bob"]);
  const mine = await api<AccountView>(r, alice, "GET", "/api/accounts/codex/alice");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.ownerEmail, "Alice@Example.Test");
  const theirs = await api<ApiError>(r, alice, "GET", "/api/accounts/pi/bob");
  const missing = await api<ApiError>(r, alice, "GET", "/api/accounts/pi/none");
  const unowned = await api<ApiError>(r, alice, "GET", "/api/accounts/pi/nobody");
  assert.equal(theirs.status, 404);
  assert.deepEqual([theirs.body, unowned.body], [missing.body, missing.body], "no difference between not yours and not there");
  for (const [m, path, body] of [["PUT", "/floor", { floor5h: 1, floorWeek: 1 }], ["PUT", "/enabled", { enabled: false }], ["POST", "/consent", { agree: true }], ["POST", "/login", undefined]] as const) {
    const res = await api<ApiError>(r, alice, m, `/api/accounts/pi/bob${path}`, body);
    assert.equal(res.status, 404, path);
  }
  const bobRow = getAccount(r.store.db, "pi/bob")!;
  assert.deepEqual([bobRow.floor5h, bobRow.state, bobRow.consentAt], [null, "active", null], "nothing changed");
  await r.close();
});

test("the account view carries health, floors, usage left and busy", async () => {
  const r = await rig({ busy: (a) => a.id === "codex/alice" });
  seed(r);
  const c = await signIn(r, "alice@example.test");
  const v = (await api<AccountView>(r, c, "GET", "/api/accounts/codex/alice")).body;
  assert.deepEqual(v, {
    account: "codex/alice", runner: "codex", name: "alice", kind: "login", ownerEmail: "Alice@Example.Test", pools: [], health: "ok", lastCode: "rate_limited",
    left5h: 80, leftWeek: 60, readAt: NOW.toISOString(), floor5h: 10, floorWeek: 10, floorSource: "default", busy: true,
  });
  assert.equal((await api<AccountView>(r, c, "GET", "/api/accounts/pi/alice-key")).body.busy, false);
  await r.close();
});

test("setFloor sets, resets with null, and refuses bad numbers", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  const set = await api<AccountView>(r, c, "PUT", "/api/accounts/pi/alice-key/floor", { floor5h: 25, floorWeek: null });
  assert.deepEqual([set.status, set.body.floor5h, set.body.floorWeek, set.body.floorSource], [200, 25, 10, "owner"]);
  const reset = await api<AccountView>(r, c, "PUT", "/api/accounts/pi/alice-key/floor", { floor5h: null, floorWeek: null });
  assert.deepEqual([reset.body.floor5h, reset.body.floorSource], [10, "default"]);
  for (const bad of [{ floor5h: 101, floorWeek: 1 }, { floor5h: -1, floorWeek: 1 }, { floor5h: "5", floorWeek: 1 }, { floor5h: 1 }, [], null, { floor5h: 1, floorWeek: 1, extra: 1 }]) {
    assert.equal((await api<ApiError>(r, c, "PUT", "/api/accounts/pi/alice-key/floor", bad)).status, 400, JSON.stringify(bad));
  }
  const notJson = await fetch(`${r.base}/api/accounts/pi/alice-key/floor`, { method: "PUT", headers: { cookie: c, "x-squad-csrf": "1", origin: PUBLIC, "content-type": "application/json" }, body: "{nope" });
  assert.equal(notJson.status, 400);
  await r.close();
});

test("setEnabled disables and enables; a dead account stays dead (409)", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  assert.equal((await api<AccountView>(r, c, "PUT", "/api/accounts/pi/alice-key/enabled", { enabled: false })).body.health, "disabled");
  assert.equal((await api<AccountView>(r, c, "PUT", "/api/accounts/pi/alice-key/enabled", { enabled: true })).body.health, "ok");
  assert.equal((await api<ApiError>(r, c, "PUT", "/api/accounts/pi/alice-key/enabled", { enabled: "yes" })).status, 400);
  setState(r.store.db, "codex/alice", "dead", "token_revoked", NOW);
  const dead = await api<ApiError>(r, c, "PUT", "/api/accounts/codex/alice/enabled", { enabled: true });
  assert.deepEqual([dead.status, dead.body.error], [409, "conflict"]);
  assert.equal(getAccount(r.store.db, "codex/alice")!.state, "dead");
  await r.close();
});

test("consent stamps the time; agree must be true", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  assert.equal((await api<ApiError>(r, c, "POST", "/api/accounts/pi/alice-key/consent", { agree: false })).status, 400);
  const ok = await api<AccountView>(r, c, "POST", "/api/accounts/pi/alice-key/consent", { agree: true });
  assert.equal(ok.body.consentAt, NOW.toISOString());
  await r.close();
});

test("a dry run answers startLogin with 501 disabled and starts nothing; an unknown login id is a 404", async () => {
  const f = fakeLogin();
  const r = await rig({ login: f.opts }, { SQUAD_DRY_RUN: "1" });
  seed(r);
  setState(r.store.db, "codex/alice", "dead", "refresh_token_reused", NOW);
  const c = await signIn(r, "alice@example.test");
  const start = await api<ApiError>(r, c, "POST", "/api/accounts/codex/alice/login");
  assert.deepEqual([start.status, start.body.error], [501, "disabled"]);
  assert.equal(f.procs.length, 0);
  assert.equal((await api<ApiError>(r, c, "GET", "/api/logins/01ABC")).status, 404);
  await r.close();
});

test("usage covers only the person's own accounts", async () => {
  const r = await rig();
  seed(r);
  const pass = (id: string, account: string, input: number): void => {
    r.store.startPass({ id, startedAt: "2026-10-23T10:00:00.000Z", project: "x", flow: "fix", action: "a", runner: "pi", model: "m", account });
    r.store.endPass({ id, endedAt: "2026-10-23T10:01:00.000Z", outcome: "ok", tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  };
  pass("1", "pi/alice-key", 10);
  pass("2", "pi/bob", 500);
  const alice = await signIn(r, "alice@example.test");
  const rows = await api<UsageRow[]>(r, alice, "GET", "/api/usage?by=account");
  assert.deepEqual(rows.body.map((x) => [x.key, x.input]), [["pi/alice-key", 10]]);
  assert.equal((await api<UsageRow[]>(r, alice, "GET", "/api/usage?by=day&since=2d")).body[0]!.input, 10);
  assert.equal((await api<UsageRow[]>(r, alice, "GET", "/api/usage?by=day&since=2026-10-25")).body.length, 0);
  assert.equal((await api<UsageRow[]>(r, alice, "GET", "/api/usage?by=account&account=pi/alice-key")).body.length, 1);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/usage?by=account&account=pi/bob")).status, 404);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/usage?by=window")).status, 400, "not served yet");
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/usage?by=nonsense")).status, 400);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/usage")).status, 400);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/usage?by=day&since=soon")).status, 400);
  await r.close();
});

test("a write needs x-squad-csrf and an Origin that is the web URL's origin", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  const url = `${r.base}/api/accounts/pi/alice-key/enabled`;
  const put = (h: Record<string, string>): Promise<Response> => fetch(url, { method: "PUT", headers: { cookie: c, "content-type": "application/json", ...h }, body: '{"enabled":false}' });
  assert.equal((await put({ origin: PUBLIC })).status, 403, "no csrf header");
  assert.equal((await put({ "x-squad-csrf": "1" })).status, 403, "no origin");
  assert.equal((await put({ "x-squad-csrf": "1", origin: "http://evil.example.test" })).status, 403, "wrong origin");
  assert.equal((await put({ "x-squad-csrf": "1", origin: "null" })).status, 403);
  assert.equal((await put({ "x-squad-csrf": "0", origin: PUBLIC })).status, 403);
  assert.equal(getAccount(r.store.db, "pi/alice-key")!.state, "active");
  const bodyOf = (await put({ origin: PUBLIC })).status;
  assert.equal(bodyOf, 403);
  assert.equal((await put({ "x-squad-csrf": "1", origin: PUBLIC })).status, 200);
  assert.equal((await api(r, c, "GET", "/api/me")).status, 200, "a read needs neither");
  await r.close();
});

test("a body that is too large is 413; a body without a JSON type is 400", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  const base = { method: "PUT", headers: { cookie: c, "x-squad-csrf": "1", origin: PUBLIC, "content-type": "application/json" } };
  assert.equal((await fetch(`${r.base}/api/accounts/pi/alice-key/enabled`, { ...base, body: JSON.stringify({ enabled: true, pad: "x".repeat(100_000) }) })).status, 413);
  assert.equal((await fetch(`${r.base}/api/accounts/pi/alice-key/enabled`, { ...base, headers: { ...base.headers, "content-type": "text/plain" }, body: '{"enabled":true}' })).status, 400);
  await r.close();
});

test("a response that fails findForbidden becomes a fixed 500 and the log names only the route", async () => {
  const r = await rig({ handlers: { me: (() => ({ token: "x-leaky-value", email: "a@b.test" })) as never } });
  const c = await signIn(r, "alice@example.test");
  const res = await fetch(`${r.base}/api/me`, { headers: { cookie: c } });
  const text = await res.text();
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(text), { error: "internal", message: "internal error" });
  assert.ok(!text.includes("x-leaky-value"));
  const line = r.logs.find((l) => /event=response_refused/.test(l))!;
  assert.match(line, /route=me/);
  assert.ok(!r.logs.join("\n").includes("x-leaky-value"));
  await r.close();
});

test("a secret-shaped value is refused too, and a handler that throws is a fixed 500 without its message", async () => {
  const r = await rig({ handlers: { me: (() => ({ email: "sk-abcdefghijklmnopqrstuvwxyz", admin: false })) as never, listAccounts: (() => { throw new Error("boom sk-secretsecretsecretsecret"); }) as never } });
  const c = await signIn(r, "alice@example.test");
  assert.equal((await api(r, c, "GET", "/api/me")).status, 500);
  const res = await api<ApiError>(r, c, "GET", "/api/accounts");
  assert.deepEqual([res.status, res.body], [500, { error: "internal", message: "internal error" }]);
  assert.ok(!r.logs.join("\n").includes("boom"));
  assert.ok(r.logs.some((l) => /event=handler_failed/.test(l) && /route=listAccounts/.test(l)));
  await r.close();
});

test("every real route's answer passes findForbidden", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  for (const path of ["/api/me", "/api/accounts", "/api/accounts/codex/alice", "/api/usage?by=account", "/api/logins/x"]) {
    const res = await api(r, c, "GET", path);
    assert.equal(findForbidden(res.body), undefined, path);
  }
  await r.close();
});

test("security headers are on api, auth, static and error answers; api and auth are no-store", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  writeFileSync(join(dist, "index.html"), "<html></html>");
  const r = await rig({ staticDir: dist });
  const c = await signIn(r, "alice@example.test");
  for (const [path, noStore] of [["/api/me", true], ["/api/nothing", true], ["/auth/logout", true], ["/", false], ["/missing.js", false]] as const) {
    const res = await fetch(`${r.base}${path}`, { headers: { cookie: c }, redirect: "manual" });
    await res.arrayBuffer();
    const h = res.headers;
    assert.match(h.get("content-security-policy") ?? "", /^default-src 'self'; /, path);
    assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path);
    assert.equal(h.get("x-content-type-options"), "nosniff", path);
    assert.equal(h.get("referrer-policy"), "same-origin", path);
    assert.equal(h.get("cache-control") === "no-store", noStore, path);
  }
  const apiCsp = (await fetch(`${r.base}/api/me`)).headers.get("content-security-policy");
  assert.equal(apiCsp, "default-src 'self'; frame-ancestors 'none'");
  await r.close();
});

test("/auth/logout is POST only, needs the csrf proof, and clears the session", async () => {
  const r = await rig();
  const c = await signIn(r, "alice@example.test");
  assert.equal((await fetch(`${r.base}/auth/logout`, { headers: { cookie: c } })).status, 405);
  assert.equal((await fetch(`${r.base}/auth/logout`, { method: "POST", headers: { cookie: c, origin: PUBLIC } })).status, 403);
  const out = await fetch(`${r.base}/auth/logout`, { method: "POST", headers: { cookie: c, origin: PUBLIC, "x-squad-csrf": "1" } });
  assert.equal(out.status, 204);
  assert.match(out.headers.getSetCookie().join("\n"), /squad_session=; .*Max-Age=0/);
  await r.close();
});

test("static files: index.html for client routes, assets by type, nothing outside the folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "static-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "_astro"), { recursive: true });
  writeFileSync(join(dist, "index.html"), '<html><script>console.log(1)</script><script src="/_astro/a.js"></script></html>');
  writeFileSync(join(dist, "_astro", "a.js"), "export {}");
  writeFileSync(join(root, "secret.txt"), "TOP-SECRET");
  symlinkSync(join(root, "secret.txt"), join(dist, "link.txt"));
  const r = await rig({ staticDir: dist });
  const get = async (path: string): Promise<{ status: number; text: string; type: string | null; csp: string | null }> => {
    const res = await fetch(`${r.base}${path}`);
    return { status: res.status, text: await res.text(), type: res.headers.get("content-type"), csp: res.headers.get("content-security-policy") };
  };
  const index = await get("/");
  assert.equal(index.status, 200);
  assert.match(index.type ?? "", /text\/html/);
  const noNonce = (t: string): string => t.replace(/<meta name="csp-nonce" content="[^"]*">/, "");
  assert.equal(noNonce((await get("/accounts/codex/alice")).text), noNonce(index.text), "a client route gets index.html");
  assert.match(index.csp ?? "", /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/, "the one inline script is allowed by hash, nothing else");
  assert.equal((await get("/_astro/a.js")).type?.startsWith("text/javascript"), true);
  assert.equal((await get("/missing.js")).status, 404);
  for (const bad of ["/../secret.txt", "/%2e%2e/secret.txt", "/_astro/../../secret.txt", "/%2e%2e%2fsecret.txt", "/link.txt", "/a%00b", "/%zz"]) {
    const res = await get(bad);
    assert.ok(!res.text.includes("TOP-SECRET"), bad);
    assert.ok([400, 404].includes(res.status) || res.text === index.text, `${bad} -> ${res.status}`);
  }
  assert.equal((await fetch(`${r.base}/`, { method: "POST", headers: { "x-squad-csrf": "1", origin: PUBLIC } })).status, 405);
  await r.close();
});

test("each page answer has a fresh style nonce, in the CSP and in a meta tag for Ant Design", async () => {
  const root = mkdtempSync(join(tmpdir(), "static-"));
  writeFileSync(join(root, "index.html"), "<html><head><title>x</title></head><body></body></html>");
  const r = await rig({ staticDir: root });
  try {
    const one = async (): Promise<{ meta: string; csp: string }> => {
      const res = await fetch(`${r.base}/`);
      const text = await res.text();
      const meta = /<head><meta name="csp-nonce" content="([A-Za-z0-9+/=]{22,})">/.exec(text)?.[1] ?? "";
      return { meta, csp: res.headers.get("content-security-policy") ?? "" };
    };
    const a = await one();
    const b = await one();
    assert.ok(a.meta !== "", "the nonce is the first thing in head");
    assert.ok(a.csp.includes(`style-src 'self' 'nonce-${a.meta}'`), a.csp);
    assert.ok(!a.csp.includes("unsafe-inline"));
    assert.notEqual(a.meta, b.meta, "never reused");
    const asset = await fetch(`${r.base}/_astro/none.js`);
    assert.ok(!(asset.headers.get("content-security-policy") ?? "").includes("nonce-"), "only a page gets a nonce");
  } finally {
    await r.close();
  }
});

test("the real source layout never serves the server's own code", async () => {
  const r = await rig();
  try {
  for (const path of ["/oidc.ts", "/server.ts", "/settings.ts", "/web/server.ts", "/server.test.ts"]) {
    const res = await fetch(`${r.base}${path}`);
    const body = await res.text();
    assert.ok(!body.includes("createOidc"), `${path} leaks code`);
    assert.notEqual(res.headers.get("content-type")?.startsWith("text/javascript"), true, path);
  }
  const built = new URL("../../../../apps/web/dist/index.html", import.meta.url);
  if (existsSync(built)) {
    const home = await fetch(`${r.base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<html/i);
  }
  } finally {
    await r.close();
  }
});

test("source and type-declaration files in the static root are refused", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(dist, "_astro"));
  writeFileSync(join(dist, "index.html"), "<html>home</html>");
  for (const n of ["a.ts", "a.mts", "a.cts", "a.d.ts", "a.js.map", "_astro/b.ts"]) writeFileSync(join(dist, n), "secret code");
  writeFileSync(join(dist, "_astro/app.js"), "ok()");
  const r = await rig({ staticDir: dist });
  try {
  for (const n of ["a.ts", "a.mts", "a.cts", "a.d.ts", "a.js.map", "_astro/b.ts"]) {
    const res = await fetch(`${r.base}/${n}`);
    assert.equal(res.status, 404, n);
    assert.ok(!(await res.text()).includes("secret"), n);
  }
  assert.equal((await fetch(`${r.base}/_astro/app.js`)).status, 200);
  } finally {
    await r.close();
  }
});

test("a request target that is not a plain path is a 400", async () => {
  const r = await rig();
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve) => {
    const q = request({ host: "127.0.0.1", port: r.web.port, path: "//evil.example.test/api/me", method: "GET" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    q.end();
  });
  assert.equal(status, 400);
  await r.close();
});

test("--api-only serves no static files", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  writeFileSync(join(dist, "index.html"), "<html></html>");
  const r = await rig({ staticDir: dist, apiOnly: true });
  assert.equal((await fetch(`${r.base}/`)).status, 404);
  assert.equal((await fetch(`${r.base}/api/me`)).status, 401);
  await r.close();
});

test("a missing build gives a plain 404, not a crash", async () => {
  const r = await rig({ staticDir: join(tmpdir(), "no-such-dist-folder") });
  assert.equal((await fetch(`${r.base}/`)).status, 404);
  await r.close();
});

test("the access log has method, route, status and ms, and never a cookie or a query", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  await api(r, c, "GET", "/api/accounts/codex/alice");
  await api(r, c, "GET", "/api/usage?by=account&since=7d");
  const lines = r.logs.filter((l) => /event=access/.test(l));
  assert.ok(lines.some((l) => /method=GET/.test(l) && /route=getAccount/.test(l) && /status=200/.test(l) && / ms=\d+/.test(l)));
  assert.ok(lines.some((l) => /route=usage/.test(l) && !/since=/.test(l) && !/by=account/.test(l)));
  const all = r.logs.join("\n");
  assert.ok(!all.includes(c.split("=")[1]!), "no session cookie value");
  assert.ok(!/code=|state=|nonce/.test(all), "no sign-in query");
  assert.ok(!all.includes("fake-access"));
  await r.close();
});

test("SQUAD_NO_WEB_LOGIN=1 stops the start", async () => {
  await assert.rejects(rig({}, { SQUAD_NO_WEB_LOGIN: "1" }), /SQUAD_NO_WEB_LOGIN/);
});

test("sign-in returns to the page the person came from; a bad target goes to /", async () => {
  const r = await rig();
  p.mutate = (c) => { c.email = "a@example.test"; c.groups = ["squad"]; };
  for (const [to, want] of [["/accounts/pi/dev?x=1", "/accounts/pi/dev?x=1"], ["//evil.com", "/"], ["/auth/login", "/"], [undefined, "/"]] as const) {
    const q = to === undefined ? "" : `?to=${encodeURIComponent(to)}`;
    const login = await fetch(`${r.base}/auth/login${q}`, { redirect: "manual" });
    const lc = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const auth = await fetch(login.headers.get("location")!, { redirect: "manual" });
    const back = new URL(auth.headers.get("location")!);
    const cb = await fetch(`${r.base}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: lc } });
    assert.equal(cb.headers.get("location"), want);
  }
  assert.ok(!r.logs.some((l) => /evil|accounts\/pi/.test(l)), "the target is never logged");
  await r.close();
});

test("signin_unavailable logs a fixed reason, never a URL or the error text", async () => {
  const cases: [typeof fetch, RegExp][] = [
    [async () => new Response("secret body", { status: 503 }), /reason=discovery-http/],
    [async () => { throw new Error("connect ECONNREFUSED http://secret.internal"); }, /reason=network/],
  ];
  for (const [f, want] of cases) {
    const r = await rig({ fetch: f });
    const res = await fetch(`${r.base}/auth/login`, { redirect: "manual" });
    assert.equal(res.status, 502);
    assert.equal(await res.text(), "sign-in unavailable\n");
    const line = r.logs.find((l) => /event=signin_unavailable/.test(l))!;
    assert.match(line, want);
    assert.ok(!/secret|http:/.test(line), line);
    await r.close();
  }
  const r = await rig({ fetch: async () => new Response("x", { status: 503 }) });
  await fetch(`${r.base}/auth/login`, { redirect: "manual" });
  assert.match(r.logs.find((l) => /signin_unavailable/.test(l))!, /status=503/);
  await r.close();
});

test("startWeb starts the ticker only with a probe runner, not api-only; close stops it", async () => {
  const mk = () => {
    const t = { set: 0, cleared: 0 };
    return { t, timers: { every: () => { t.set++; return 1; }, clear: () => { t.cleared++; } } };
  };
  const probe = async () => {};
  const none = mk();
  await (await rig({ ticker: { timers: none.timers } })).close();
  assert.equal(none.t.set, 0, "no probe runner: no ticker");
  const api = mk();
  await (await rig({ probe, apiOnly: true, ticker: { timers: api.timers } })).close();
  assert.equal(api.t.set, 0);
  const on = mk();
  const r = await rig({ probe, ticker: { timers: on.timers } });
  assert.equal(on.t.set, 1);
  await r.close();
  assert.equal(on.t.cleared, 1);
});

// ---- web device login ----

function fakeLogin() {
  const stops: string[] = [];
  const procs: { say: (s: string) => void; exit: (c: number) => void; name: string }[] = [];
  return {
    stops, procs,
    opts: {
      start: (_argv: string[], name: string) => {
        let cb: (s: string) => void = () => {};
        let end: (c: number) => void = () => {};
        const exited = new Promise<number>((r) => { end = r; });
        procs.push({ say: (s) => cb(s), exit: end, name });
        queueMicrotask(() => procs.at(-1)!.say("   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code\n   \u001b[94mABCD-EFGHJ\u001b[0m\n\n"));
        return { onStdout: (f: (s: string) => void) => { cb = f; }, exited };
      },
      stop: async (n: string) => { stops.push(n); procs.find((p) => p.name === n)?.exit(143); },
    },
  };
}

test("startLogin and loginStatus: codex login accounts only, the owner only, and the status only for who started it", async () => {
  const f = fakeLogin();
  const r = await rig({ login: f.opts });
  seed(r);
  setState(r.store.db, "codex/alice", "dead", "refresh_token_reused", NOW);
  const alice = await signIn(r, "alice@example.test");
  const bob = await signIn(r, "bob@example.test");
  const pi = await api<ApiError>(r, alice, "POST", "/api/accounts/pi/alice-key/login");
  assert.equal(pi.status, 400);
  assert.match(pi.body.message, /squad login/);
  assert.equal((await api<ApiError>(r, bob, "POST", "/api/accounts/codex/alice/login")).status, 404);
  const ok = await api<{ loginId: string; userCode: string; verifyUrl: string; expiresAt: string }>(r, alice, "POST", "/api/accounts/codex/alice/login");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.userCode, "ABCD-EFGHJ");
  assert.equal(ok.body.verifyUrl, "https://auth.openai.com/codex/device");
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts/codex/alice/login")).status, 409);
  const st = await api<{ state: string }>(r, alice, "GET", `/api/logins/${ok.body.loginId}`);
  assert.deepEqual(st.body, { loginId: ok.body.loginId, state: "pending" });
  assert.equal((await api<ApiError>(r, bob, "GET", `/api/logins/${ok.body.loginId}`)).status, 404);
  await r.close();
  assert.equal(f.stops.length, 1, "server close stops the running login container");
});

// ---- admin from an Authentik group ----

const ADMIN = { SQUAD_OIDC_ADMIN_GROUP: "squad-admins" };

/** Signs in with claims set by hand, so a test can drop the groups claim or make it the wrong type. */
async function signInWith(r: Rig, email: string, set: (c: Record<string, unknown>) => void): Promise<string> {
  const keep = p.mutate;
  p.mutate = (c) => { c.email = email; c.name = email.split("@")[0]; set(c); };
  try {
    const login = await fetch(`${r.base}/auth/login`, { redirect: "manual" });
    const loginCookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const auth = await fetch(login.headers.get("location")!, { redirect: "manual" });
    const back = new URL(auth.headers.get("location")!);
    const cb = await fetch(`${r.base}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: loginCookie } });
    assert.equal(cb.status, 302);
    return cb.headers.getSetCookie().find((c) => c.startsWith("squad_session="))!.split(";")[0]!;
  } finally {
    p.mutate = keep;
  }
}

test("me.admin is true only when the groups claim is an array that holds the admin group exactly", async () => {
  const r = await rig({}, ADMIN);
  const adminMe = async (set: (c: Record<string, unknown>) => void): Promise<boolean> => (await api<Me>(r, await signInWith(r, "boss@example.test", set), "GET", "/api/me")).body.admin;
  assert.equal(await adminMe((c) => { c.groups = ["squad", "squad-admins"]; }), true);
  assert.equal(await adminMe((c) => { c.groups = ["squad"]; }), false, "right email domain, no group");
  assert.equal(await adminMe((c) => { delete c.groups; }), false, "groups claim missing");
  assert.equal(await adminMe((c) => { c.groups = "squad-admins"; }), false, "a string is not an array");
  assert.equal(await adminMe((c) => { c.groups = { "squad-admins": true }; }), false, "an object is not an array");
  assert.equal(await adminMe((c) => { c.groups = [["squad-admins"]]; }), false, "a nested array is not a string");
  assert.equal(await adminMe((c) => { c.groups = [42, null, "Squad-Admins"]; }), false, "case counts");
  assert.equal(await adminMe((c) => { c.groups = ["squad-admins "]; }), false, "no trimming");
  assert.equal(await adminMe((c) => { c.groups = ["squad-admin"]; }), false, "no prefix match");
  assert.equal(await adminMe((c) => { c.groups = ["squad-admin.*"]; }), false, "no pattern");
  await r.close();
});

test("with SQUAD_OIDC_ADMIN_GROUP unset nobody is admin, whatever the groups say", async () => {
  const r = await rig();
  const c = await signIn(r, "boss@example.test", ["squad-admins", "admin", ""]);
  assert.equal((await api<Me>(r, c, "GET", "/api/me")).body.admin, false);
  await r.close();
});

test("an admin sees every account, usage and pass; an owner still sees only their own", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  const pass = (id: string, account: string | undefined): void => {
    r.store.startPass({ id, startedAt: "2026-10-23T10:00:00.000Z", project: "x", flow: "fix", action: "a", runner: "pi", model: "m", ...(account === undefined ? {} : { account }) });
    r.store.endPass({ id, endedAt: "2026-10-23T10:01:00.000Z", outcome: "ok", tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  };
  pass("P1", "pi/alice-key");
  pass("P2", "pi/bob");
  pass("P3", undefined);
  const admin = await signIn(r, "boss@example.test", ["squad", "squad-admins"]);
  const alice = await signIn(r, "alice@example.test");
  assert.deepEqual((await api<AccountView[]>(r, admin, "GET", "/api/accounts")).body.map((a) => a.account), ["codex/alice", "pi/alice-key", "pi/bob", "pi/nobody"]);
  assert.equal((await api<AccountView>(r, admin, "GET", "/api/accounts/pi/bob")).status, 200);
  assert.equal((await api<ApiError>(r, admin, "GET", "/api/accounts/pi/none")).status, 404);
  assert.deepEqual((await api<UsageRow[]>(r, admin, "GET", "/api/usage?by=account")).body.map((x) => x.key), ["-", "pi/alice-key", "pi/bob"], "also a pass that found no account");
  assert.equal((await api<UsageRow[]>(r, admin, "GET", "/api/usage?by=account&account=pi/bob")).body.length, 1);
  assert.deepEqual((await api<PassView[]>(r, admin, "GET", "/api/passes")).body.map((x) => x.passId), ["P3", "P2", "P1"]);
  assert.deepEqual((await api<AccountView[]>(r, alice, "GET", "/api/accounts")).body.map((a) => a.account), ["codex/alice", "pi/alice-key"]);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/accounts/pi/bob")).status, 404);
  assert.deepEqual((await api<PassView[]>(r, alice, "GET", "/api/passes")).body.map((x) => x.passId), ["P1"]);
  await r.close();
});

test("an admin may set floors and enable or disable any account; consent and login stay with the owner", async () => {
  const f = fakeLogin();
  const r = await rig({ login: f.opts }, ADMIN);
  seed(r);
  setState(r.store.db, "codex/alice", "dead", "refresh_token_reused", NOW);
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  const floor = await api<AccountView>(r, admin, "PUT", "/api/accounts/pi/bob/floor", { floor5h: 30, floorWeek: 40 });
  assert.deepEqual([floor.status, floor.body.floor5h, floor.body.floorWeek, floor.body.floorSource], [200, 30, 40, "owner"]);
  assert.equal((await api<AccountView>(r, admin, "PUT", "/api/accounts/pi/bob/enabled", { enabled: false })).body.health, "disabled");
  assert.equal((await api<AccountView>(r, admin, "PUT", "/api/accounts/pi/bob/enabled", { enabled: true })).body.health, "ok");
  const consent = await api<ApiError>(r, admin, "POST", "/api/accounts/pi/bob/consent", { agree: true });
  assert.deepEqual([consent.status, consent.body.error], [404, "not-found"]);
  assert.equal(getAccount(r.store.db, "pi/bob")!.consentAt, null);
  const login = await api<ApiError>(r, admin, "POST", "/api/accounts/codex/alice/login");
  assert.equal(login.status, 404);
  assert.equal(f.procs.length, 0, "no container for another person's login");
  // The owner who is no admin still cannot touch a stranger's account.
  const alice = await signIn(r, "alice@example.test");
  assert.equal((await api<ApiError>(r, alice, "PUT", "/api/accounts/pi/bob/floor", { floor5h: 1, floorWeek: 1 })).status, 404);
  assert.equal(getAccount(r.store.db, "pi/bob")!.floor5h, 30);
  // An admin who owns an account may consent to it.
  addAccount(r.store.db, { runner: "pi", name: "mine", kind: "key", ownerEmail: "boss@example.test" }, NOW);
  assert.equal((await api<AccountView>(r, admin, "POST", "/api/accounts/pi/mine/consent", { agree: true })).status, 200);
  await r.close();
});

// ---- pass history ----

const CAPTURES = join(import.meta.dirname, "..", "..", "test", "fixtures", "captures");
const FIXTURES: [runner: "pi" | "claude" | "codex", file: string][] = [["pi", "pi/ok.jsonl"], ["claude", "claude/ok-opus-5-5.jsonl"], ["codex", "codex/ok-gpt-6-1-sol.jsonl"]];

/** A finished pass with its stored files, as `runPass` leaves them. */
function storePass(r: Rig, id: string, o: { runner?: string; account?: string; at?: string; raw?: string; prompt?: string; files?: boolean; failKind?: string; outcome?: string } = {}): void {
  const at = o.at ?? "2026-10-23T10:00:00.000Z";
  const runner = o.runner ?? "pi";
  r.store.startPass({ id, startedAt: at, project: "x", flow: "fix", action: "fix:a", runner, model: "m1", taskKind: "issue", taskId: "7", ...(o.account === undefined ? {} : { account: o.account }) });
  r.store.endPass({
    id, endedAt: new Date(Date.parse(at) + 60_000).toISOString(), outcome: o.outcome ?? "ok", ...(o.failKind === undefined ? {} : { failKind: o.failKind, failCode: "403" }),
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 }, costUsd: 0.5,
  });
  if (o.files !== false) writePassFiles(r.home, new Date(Date.parse(at) + 60_000), id, o.prompt ?? "say ok", o.raw ?? readFileSync(join(CAPTURES, "pi/ok.jsonl"), "utf8"));
}

test("listPasses: newest first, paged by a before cursor, filtered by account and since; owner sees own accounts only", async () => {
  const r = await rig();
  seed(r);
  for (let i = 1; i <= 5; i++) storePass(r, `P${i}`, { account: "pi/alice-key", at: `2026-10-2${i}T10:00:00.000Z` });
  storePass(r, "P6", { account: "pi/bob" });
  storePass(r, "P7", { files: false });
  const alice = await signIn(r, "alice@example.test");
  const ids = async (q: string): Promise<string[]> => (await api<PassView[]>(r, alice, "GET", `/api/passes${q}`)).body.map((x) => x.passId);
  assert.deepEqual(await ids(""), ["P5", "P4", "P3", "P2", "P1"]);
  assert.deepEqual(await ids("?limit=2"), ["P5", "P4"]);
  assert.deepEqual(await ids("?limit=2&before=P4"), ["P3", "P2"]);
  assert.deepEqual(await ids("?since=2026-10-24"), ["P5", "P4"]);
  assert.deepEqual(await ids("?account=pi/alice-key&limit=1"), ["P5"]);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/passes?account=pi/bob")).status, 404);
  for (const bad of ["?limit=0", "?limit=201", "?limit=x", "?limit=1.5", "?before=../x", "?since=soon"]) assert.equal((await api<ApiError>(r, alice, "GET", `/api/passes${bad}`)).status, 400, bad);
  assert.equal((await api<PassView[]>(r, alice, "GET", "/api/passes?limit=200")).status, 200);
  const first = (await api<PassView[]>(r, alice, "GET", "/api/passes?limit=1")).body[0]!;
  assert.deepEqual(first, {
    passId: "P5", account: "pi/alice-key", startedAt: "2026-10-25T10:00:00.000Z", endedAt: "2026-10-25T10:01:00.000Z", caller: { flow: "fix", action: "fix:a" }, task: { kind: "issue", id: "7" },
    model: "m1", outcome: "ok", tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 }, costUsd: 0.5, hasTranscript: true,
  });
  const admin = await rig({}, ADMIN);
  await admin.close();
  await r.close();
});

test("listPasses: a failed pass shows failKind and failCode; a pass with no files has hasTranscript false", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  storePass(r, "F1", { account: "pi/alice-key", outcome: "fail", failKind: "provider", files: false });
  const c = await signIn(r, "alice@example.test");
  const row = (await api<PassView[]>(r, c, "GET", "/api/passes")).body[0]!;
  assert.deepEqual([row.outcome, row.failKind, row.failCode, row.hasTranscript], ["fail", "provider", "403", false]);
  await r.close();
});

test("getPass: the prompt and the parsed texts for each runner's capture; never the raw stream", async () => {
  const r = await rig();
  seed(r);
  addAccount(r.store.db, { runner: "claude", name: "alice-c", kind: "token", ownerEmail: "alice@example.test" }, NOW);
  addAccount(r.store.db, { runner: "codex", name: "alice-x", kind: "key", ownerEmail: "alice@example.test" }, NOW);
  const alice = await signIn(r, "alice@example.test");
  for (const [runner, file] of FIXTURES) {
    const id = `G${runner}`;
    const account = runner === "pi" ? "pi/alice-key" : runner === "claude" ? "claude/alice-c" : "codex/alice-x";
    storePass(r, id, { runner, account, raw: readFileSync(join(CAPTURES, file), "utf8"), prompt: `prompt for ${runner}` });
    const res = await api<PassDetail>(r, alice, "GET", `/api/passes/${id}`);
    assert.equal(res.status, 200, runner);
    assert.equal(res.body.prompt, `prompt for ${runner}`);
    assert.deepEqual(res.body.transcript, { texts: ["ok"], final: "ok" }, runner);
    assert.equal(res.body.hasTranscript, true);
    assert.equal(res.body.expired, undefined);
    assert.equal(res.body.truncated, undefined);
    assert.ok(!JSON.stringify(res.body).includes('"type"'), "no raw stream line");
  }
  await r.close();
});

test("getPass: owner or admin only (else the same 404 as a missing pass); a pass with no account is for an admin", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  storePass(r, "A1", { account: "pi/alice-key" });
  storePass(r, "B1", { account: "pi/bob" });
  storePass(r, "N1", { files: false });
  const alice = await signIn(r, "alice@example.test");
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  assert.equal((await api(r, alice, "GET", "/api/passes/A1")).status, 200);
  const theirs = await api<ApiError>(r, alice, "GET", "/api/passes/B1");
  const missing = await api<ApiError>(r, alice, "GET", "/api/passes/NOPE");
  const noAccount = await api<ApiError>(r, alice, "GET", "/api/passes/N1");
  assert.equal(theirs.status, 404);
  assert.deepEqual([theirs.body, noAccount.body], [missing.body, missing.body]);
  for (const id of ["A1", "B1", "N1"]) assert.equal((await api(r, admin, "GET", `/api/passes/${id}`)).status, 200, id);
  assert.equal((await api<ApiError>(r, admin, "GET", "/api/passes/..%2Fx")).status, 404);
  await r.close();
});

test("getPass: missing files give the row with expired: true and no prompt or transcript", async () => {
  const r = await rig();
  seed(r);
  storePass(r, "E1", { account: "pi/alice-key", files: false });
  const c = await signIn(r, "alice@example.test");
  const res = await api<PassDetail>(r, c, "GET", "/api/passes/E1");
  assert.equal(res.status, 200);
  assert.equal(res.body.expired, true);
  assert.equal(res.body.prompt, undefined);
  assert.equal(res.body.transcript, undefined);
  assert.equal(res.body.hasTranscript, false);
  assert.equal(res.body.passId, "E1");
  await r.close();
});

test("getPass: an old plain .log (no prompt file) still reads", async () => {
  const r = await rig();
  seed(r);
  storePass(r, "L1", { account: "pi/alice-key", files: false });
  const dir = join(r.home.passLogs, "2026-10-23");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "L1.log"), readFileSync(join(CAPTURES, "pi/ok.jsonl"), "utf8"));
  const c = await signIn(r, "alice@example.test");
  const res = await api<PassDetail>(r, c, "GET", "/api/passes/L1");
  assert.deepEqual(res.body.transcript, { texts: ["ok"], final: "ok" });
  assert.equal(res.body.prompt, undefined, "an old pass kept no prompt");
  assert.equal(res.body.expired, true, "the prompt is gone");
  await r.close();
});

test("getPass: secrets in the prompt and the texts become [hidden], so the answer still passes findForbidden", async () => {
  const r = await rig();
  seed(r);
  const secret = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE0000";
  const raw = readFileSync(join(CAPTURES, "pi/ok.jsonl"), "utf8").split('"text":"ok"').join(`"text":"the key is ${secret} and eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl ok"`);
  storePass(r, "S1", { account: "pi/alice-key", raw, prompt: `${secret} please ghp_FAKEFAKEFAKEFAKEFAKEFAKE0123456789\n{"access_token": "plainvalue"}` });
  const c = await signIn(r, "alice@example.test");
  const res = await api<PassDetail>(r, c, "GET", "/api/passes/S1");
  assert.equal(res.status, 200, "not refused by findForbidden");
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("FAKEFAKE") && !text.includes("eyJhbGci") && !text.includes("plainvalue"), text);
  assert.ok(res.body.prompt!.startsWith("[hidden] please [hidden]"));
  assert.equal(res.body.transcript!.final, "the key is [hidden] and [hidden] ok");
  assert.equal(findForbidden(res.body), undefined);
  await r.close();
});

test("getPass: the prompt and the transcript are each cut at 256 KB with truncated: true", async () => {
  const r = await rig();
  seed(r);
  const big = "word ".repeat(80_000); // 400,000 bytes
  const raw = readFileSync(join(CAPTURES, "pi/ok.jsonl"), "utf8").split('"text":"ok"').join(`"text":"${big}"`);
  storePass(r, "T1", { account: "pi/alice-key", raw, prompt: big });
  storePass(r, "T2", { account: "pi/alice-key", prompt: "x".repeat(300_000) });
  storePass(r, "T3", { account: "pi/alice-key", raw: readFileSync(join(CAPTURES, "pi/ok.jsonl"), "utf8").split('"text":"ok"').join(`"text":"${big}"`), prompt: "short" });
  const c = await signIn(r, "alice@example.test");
  const t1 = (await api<PassDetail>(r, c, "GET", "/api/passes/T1")).body;
  assert.equal(t1.truncated, true);
  assert.ok(Buffer.byteLength(t1.prompt!) <= 256 * 1024 && Buffer.byteLength(t1.prompt!) > 256 * 1024 - 8);
  assert.ok(t1.transcript!.texts.join("").length <= 256 * 1024);
  assert.ok(Buffer.byteLength(t1.transcript!.final) <= 256 * 1024);
  const t2 = (await api<PassDetail>(r, c, "GET", "/api/passes/T2")).body;
  assert.equal(t2.truncated, true);
  assert.equal(Buffer.byteLength(t2.prompt!), 256 * 1024);
  const t3 = (await api<PassDetail>(r, c, "GET", "/api/passes/T3")).body;
  assert.equal(t3.truncated, true, "the transcript alone is enough");
  assert.equal(t3.prompt, "short");
  await r.close();
});

// ---- chart data ----

test("usageSeries: day and hour buckets, only the person's accounts (all for an admin), bad input is 400", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  storePass(r, "U1", { account: "pi/alice-key", at: "2026-10-23T10:05:00.000Z", files: false });
  storePass(r, "U2", { account: "pi/alice-key", at: "2026-10-23T10:55:00.000Z", files: false });
  storePass(r, "U3", { account: "pi/alice-key", at: "2026-10-23T11:00:00.000Z", files: false });
  storePass(r, "U4", { account: "pi/bob", at: "2026-10-23T11:00:00.000Z", files: false });
  const alice = await signIn(r, "alice@example.test");
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  const day = await api<UsageSeriesPoint[]>(r, alice, "GET", "/api/usage/series?by=day");
  assert.deepEqual(day.body, [{ bucket: "2026-10-23", account: "pi/alice-key", passes: 3, input: 3, output: 6, cacheRead: 9, cacheWrite: 12, reasoning: 15, costUsd: 1.5 }]);
  const hour = await api<UsageSeriesPoint[]>(r, alice, "GET", "/api/usage/series?by=hour&since=2d");
  assert.deepEqual(hour.body.map((x) => [x.bucket, x.account, x.passes]), [["2026-10-23T10:00:00Z", "pi/alice-key", 2], ["2026-10-23T11:00:00Z", "pi/alice-key", 1]]);
  assert.deepEqual((await api<UsageSeriesPoint[]>(r, admin, "GET", "/api/usage/series?by=hour")).body.map((x) => x.account), ["pi/alice-key", "pi/alice-key", "pi/bob"]);
  assert.equal((await api<UsageSeriesPoint[]>(r, alice, "GET", "/api/usage/series?by=day&account=pi/alice-key")).body.length, 1);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/usage/series?by=day&account=pi/bob")).status, 404);
  assert.equal((await api<UsageSeriesPoint[]>(r, admin, "GET", "/api/usage/series?by=day&account=pi/bob")).body.length, 1);
  for (const bad of ["", "?by=week", "?by=account", "?by=day&since=soon"]) assert.equal((await api<ApiError>(r, alice, "GET", `/api/usage/series${bad}`)).status, 400, bad);
  await r.close();
});

test("roomSeries: the readings of one account, oldest first, since a time; owner or admin only", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  recordRoom(r.store.db, "codex/alice", new Date("2026-10-20T10:00:00.000Z"), "read", 90, 80);
  recordRoom(r.store.db, "codex/alice", new Date("2026-10-23T10:00:00.000Z"), "read", 70, 78);
  recordRoom(r.store.db, "codex/alice", new Date("2026-10-23T12:00:00.000Z"), "pass", 60, undefined);
  recordRoom(r.store.db, "pi/bob", new Date("2026-10-23T12:00:00.000Z"), "pass", 1, 1);
  const alice = await signIn(r, "alice@example.test");
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  const all = await api<RoomPoint[]>(r, alice, "GET", "/api/accounts/codex/alice/room?since=30d");
  assert.deepEqual(all.body, [
    { at: "2026-10-20T10:00:00.000Z", source: "read", left5h: 90, leftWeek: 80 },
    { at: "2026-10-23T10:00:00.000Z", source: "read", left5h: 70, leftWeek: 78 },
    { at: "2026-10-23T12:00:00.000Z", source: "pass", left5h: 60 },
  ]);
  assert.equal((await api<RoomPoint[]>(r, alice, "GET", "/api/accounts/codex/alice/room")).body.length, 3, "default is 7 days");
  assert.equal((await api<RoomPoint[]>(r, alice, "GET", "/api/accounts/codex/alice/room?since=2d")).body.length, 2);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/accounts/pi/bob/room")).status, 404);
  assert.equal((await api<RoomPoint[]>(r, admin, "GET", "/api/accounts/pi/bob/room")).body.length, 1);
  assert.equal((await api<ApiError>(r, alice, "GET", "/api/accounts/codex/alice/room?since=soon")).status, 400);
  await r.close();
});

// ---- add a new codex account ----

test("addAccount: codex only; a bad name is 400, an existing name 409; the login starts for the person", async () => {
  const f = fakeLogin();
  const r = await rig({ login: f.opts });
  seed(r);
  const alice = await signIn(r, "alice@example.test");
  for (const body of [{ runner: "claude", name: "x" }, { runner: "pi", name: "x" }, { runner: "dsh", name: "x" }, { name: "x" }, { runner: "codex" }, { runner: "codex", name: 5 }, { runner: "codex", name: "x", extra: 1 }]) {
    assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts", { runner: "codex", name: "../evil" })).status, 400);
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts", { runner: "codex", name: "Big" })).status, 400);
  const dupe = await api<ApiError>(r, alice, "POST", "/api/accounts", { runner: "codex", name: "alice" });
  assert.deepEqual([dupe.status, dupe.body.error], [409, "conflict"]);
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts", { runner: "codex", name: "bob-key" })).status, 200, "a name free for codex, whatever pi has");
  assert.equal(f.procs.length, 1);
  assert.equal((await api<ApiError>(r, undefined, "POST", "/api/accounts", { runner: "codex", name: "q" })).status, 401);
  await r.close();
});

test("addAccount twice with two names: both end up owned by the person, with their own seat emails; any number is allowed", async () => {
  const f = fakeLogin();
  const r = await rig({ login: f.opts });
  seed(r);
  const alice = await signIn(r, "alice@example.test");
  const seats = ["one@seats.test", "two@seats.test"];
  const started: { loginId: string; userCode: string }[] = [];
  for (const name of ["seat-one", "seat-two"]) {
    const res = await api<{ loginId: string; userCode: string; verifyUrl: string }>(r, alice, "POST", "/api/accounts", { runner: "codex", name });
    assert.equal(res.status, 200);
    assert.equal(res.body.userCode, "ABCD-EFGHJ");
    assert.equal(findForbidden(res.body), undefined);
    started.push(res.body);
  }
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts", { runner: "codex", name: "seat-one" })).status, 409, "the same name while its login runs");
  // Read the folders once: the first login moves its folder away as soon as it exits.
  // The staging folder is the pass id, which is also the container name: two ids from one millisecond do not sort in start order.
  for (const [i, proc] of f.procs.entries()) {
    const staging = proc.name.replace(/^squad-login-/, "").toUpperCase();
    writeFileSync(join(r.home.staging, staging, "auth.json"), JSON.stringify({ tokens: { id_token: fakeIdToken({ email: seats[i]! }) } }));
    proc.exit(0);
  }
  for (const s of started) for (let n = 0; n < 200 && (await api<{ state: string }>(r, alice, "GET", `/api/logins/${s.loginId}`)).body.state === "pending"; n++) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual((await api<{ state: string }>(r, alice, "GET", `/api/logins/${started[0]!.loginId}`)).body, { loginId: started[0]!.loginId, state: "done" });
  const list = (await api<AccountView[]>(r, alice, "GET", "/api/accounts")).body.filter((a) => a.name.startsWith("seat-"));
  assert.deepEqual(list.map((a) => [a.account, a.ownerEmail, a.loginEmail, a.health]), [
    ["codex/seat-one", "alice@example.test", "one@seats.test", "ok"], ["codex/seat-two", "alice@example.test", "two@seats.test", "ok"],
  ]);
  await r.close();
});

test("an admin adds an account owned by the admin's own email; a dry run starts nothing", async () => {
  const f = fakeLogin();
  const r = await rig({ login: f.opts }, ADMIN);
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  assert.equal((await api(r, admin, "POST", "/api/accounts", { runner: "codex", name: "admin-seat" })).status, 200);
  const staging = (await import("node:fs")).readdirSync(r.home.staging)[0]!;
  writeFileSync(join(r.home.staging, staging, "auth.json"), JSON.stringify({ tokens: { id_token: fakeIdToken({ email: "adm@seats.test" }) } }));
  f.procs[0]!.exit(0);
  for (let n = 0; n < 200 && getAccount(r.store.db, "codex/admin-seat") === undefined; n++) await new Promise((x) => setTimeout(x, 10));
  const row = getAccount(r.store.db, "codex/admin-seat")!;
  assert.deepEqual([row.ownerEmail, row.loginEmail], ["boss@example.test", "adm@seats.test"]);
  await r.close();
  const dry = await rig({ login: fakeLogin().opts }, { SQUAD_DRY_RUN: "1" });
  const c = await signIn(dry, "alice@example.test");
  assert.equal((await api<ApiError>(dry, c, "POST", "/api/accounts", { runner: "codex", name: "x" })).status, 501);
  await dry.close();
});

test("every new route's answer passes findForbidden", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  storePass(r, "Z1", { account: "pi/alice-key" });
  recordRoom(r.store.db, "codex/alice", NOW, "read", 5, 6);
  const c = await signIn(r, "alice@example.test", ["squad-admins"]);
  for (const path of ["/api/passes", "/api/passes/Z1", "/api/usage/series?by=day", "/api/accounts/codex/alice/room", "/api/me"]) {
    const res = await api(r, c, "GET", path);
    assert.equal(res.status, 200, path);
    assert.equal(findForbidden(res.body), undefined, path);
  }
  await r.close();
});
