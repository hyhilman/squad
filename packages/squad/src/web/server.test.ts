import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { recordPriceHistory, refreshPrices } from "../prices.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { NO_SESSION_ROUTES, ROUTES, findForbidden, type LogoutEverywhere, type CatalogModelCompare, type CatalogProviderDetail, type CatalogProviderView, type ConnectStart, type ConnectStatus, type ProviderView, type AccountView, type ApiError, type Me, type PassDetail, type PassView, type RoomPoint, type UsageRow, type UsageSeriesPoint } from "@squad/contract";
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

async function rig(extra: Partial<WebOpts> = {}, env: Record<string, string> = {}, secrets?: string): Promise<Rig> {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "web-")), {});
  ensureHome(home);
  if (secrets !== undefined) writeFileSync(join(home.root, "squad.secret.toml"), secrets, { mode: 0o600 });
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
    // The helper's token route has no session: its pair code is the proof (tested with the connect routes).
    if ((NO_SESSION_ROUTES as readonly string[]).includes(name)) continue;
    const path = route.path.replace(":runner", "codex").replace(":name", "a").replace(":loginId", "x").replace(":connectId", "x");
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
  for (const [m, path, body] of [["PUT", "/floor", { floor5h: 1, floorWeek: 1 }], ["PUT", "/caps", { cap5h: 1, capWeek: null, cap30d: null }], ["PUT", "/balance", { balance: 5 }], ["PUT", "/enabled", { enabled: false }], ["POST", "/consent", { agree: true }], ["POST", "/login", undefined]] as const) {
    const res = await api<ApiError>(r, alice, m, `/api/accounts/pi/bob${path}`, body);
    assert.equal(res.status, 404, path);
  }
  const bobRow = getAccount(r.store.db, "pi/bob")!;
  assert.deepEqual([bobRow.floor5h, bobRow.state, bobRow.consentAt], [null, "active", NOW.toISOString()], "nothing changed");
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
    consentAt: NOW.toISOString(), consentBy: "cli", sharing: true, canResetHealth: false,
  });
  assert.equal((await api<AccountView>(r, c, "GET", "/api/accounts/pi/alice-key")).body.busy, false);
  await r.close();
});

test("a key account view carries what its passes used in each window; a seat has none", async () => {
  const r = await rig();
  seed(r);
  const at = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const tok = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const [id, account, h, cli] of [["U1", "pi/alice-key", 1, 0.5], ["U2", "pi/alice-key", 48, 2], ["U3", "pi/alice-key", 24 * 20, 4], ["U4", "pi/bob", 1, 9], ["U5", "codex/alice", 1, 3]] as const) {
    r.store.startPass({ id, startedAt: at(h), project: "x", flow: "f", action: "a", runner: "pi", model: "m", account });
    r.store.endPass({ id, endedAt: at(h), outcome: "ok", tokens: tok, cliCostUsd: cli });
  }
  const c = await signIn(r, "alice@example.test");
  const list = await api<AccountView[]>(r, c, "GET", "/api/accounts");
  assert.equal(findForbidden(list.body), undefined);
  const key = list.body.find((a) => a.account === "pi/alice-key")!;
  assert.deepEqual([key.used5h, key.usedWeek, key.used30d], [0.5, 2.5, 6.5]);
  const seat = list.body.find((a) => a.account === "codex/alice")!;
  assert.deepEqual(["used5h", "usedWeek", "used30d"].filter((k) => k in seat), []);
  await r.close();
});

test("setCaps sets dollar caps on a key, clears them with null, and refuses bad numbers and seats", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  const url = "/api/accounts/pi/alice-key/caps";
  const before = await api<AccountView>(r, c, "GET", "/api/accounts/pi/alice-key");
  assert.deepEqual(["cap5h", "capWeek", "cap30d"].filter((k) => k in before.body), [], "no cap by default");
  const set = await api<AccountView>(r, c, "PUT", url, { cap5h: 1.25, capWeek: 10, cap30d: null });
  assert.deepEqual([set.status, set.body.cap5h, set.body.capWeek, "cap30d" in set.body], [200, 1.25, 10, false]);
  assert.equal(findForbidden(set.body), undefined);
  const cleared = await api<AccountView>(r, c, "PUT", url, { cap5h: null, capWeek: null, cap30d: null });
  assert.deepEqual(["cap5h", "capWeek", "cap30d"].filter((k) => k in cleared.body), []);
  for (const bad of [{ cap5h: 0, capWeek: null, cap30d: null }, { cap5h: -1, capWeek: null, cap30d: null }, { cap5h: 1_000_001, capWeek: null, cap30d: null }, { cap5h: "5", capWeek: null, cap30d: null }, { cap5h: 1, capWeek: null }, { cap5h: 1, capWeek: null, cap30d: null, extra: 1 }, [], null]) {
    assert.equal((await api<ApiError>(r, c, "PUT", url, bad)).status, 400, JSON.stringify(bad));
  }
  const seat = await api<ApiError>(r, c, "PUT", "/api/accounts/codex/alice/caps", { cap5h: 1, capWeek: null, cap30d: null });
  assert.deepEqual([seat.status, seat.body.error], [400, "bad-request"]);
  const noCsrf = await fetch(`${r.base}${url}`, { method: "PUT", headers: { cookie: c, origin: PUBLIC, "content-type": "application/json" }, body: JSON.stringify({ cap5h: 1, capWeek: null, cap30d: null }) });
  assert.equal(noCsrf.status, 403);
  assert.equal(getAccount(r.store.db, "pi/alice-key")!.cap5h, null);
  await r.close();
});

test("setBalance keeps the entered balance with the time; the view takes off what squad used since then", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  const url = "/api/accounts/pi/alice-key/balance";
  const keys = ["balanceUsd", "balanceAt", "balanceLeft"];
  const before = await api<AccountView>(r, c, "GET", "/api/accounts/pi/alice-key");
  assert.deepEqual(keys.filter((k) => k in before.body), [], "no balance by default");
  const set = await api<AccountView>(r, c, "PUT", url, { balance: 20 });
  assert.deepEqual([set.status, set.body.balanceUsd, set.body.balanceAt, set.body.balanceLeft], [200, 20, NOW.toISOString(), 20]);
  assert.equal(findForbidden(set.body), undefined);
  // Passes from before the stamp do not count; passes after it do; a running pass counts 0.
  const at = (h: number): string => new Date(NOW.getTime() + h * 3_600_000).toISOString();
  const tok = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const [id, h, cli] of [["B1", -1, 4], ["B2", 1, 7.5], ["B3", 2, 13], ["B4", 3, null]] as const) {
    r.store.startPass({ id, startedAt: at(h), project: "x", flow: "f", action: "a", runner: "pi", model: "m", account: "pi/alice-key" });
    if (cli !== null) r.store.endPass({ id, endedAt: at(h), outcome: "ok", tokens: tok, cliCostUsd: cli });
  }
  const list = await api<AccountView[]>(r, c, "GET", "/api/accounts");
  assert.equal(findForbidden(list.body), undefined);
  const key = list.body.find((a) => a.account === "pi/alice-key")!;
  assert.deepEqual([key.balanceUsd, key.balanceLeft], [20, -0.5], "below 0 is not clamped");
  const seat = list.body.find((a) => a.account === "codex/alice")!;
  assert.deepEqual(keys.filter((k) => k in seat), []);
  const zero = await api<AccountView>(r, c, "PUT", url, { balance: 0 });
  assert.deepEqual([zero.status, zero.body.balanceUsd], [200, 0]);
  const cleared = await api<AccountView>(r, c, "PUT", url, { balance: null });
  assert.deepEqual([cleared.status, keys.filter((k) => k in cleared.body)], [200, []]);
  for (const bad of [{ balance: -1 }, { balance: 1_000_001 }, { balance: "5" }, {}, { balance: 1, extra: 1 }, [], null]) {
    assert.equal((await api<ApiError>(r, c, "PUT", url, bad)).status, 400, JSON.stringify(bad));
  }
  const seatSet = await api<ApiError>(r, c, "PUT", "/api/accounts/codex/alice/balance", { balance: 1 });
  assert.deepEqual([seatSet.status, seatSet.body.error], [400, "bad-request"]);
  const noCsrf = await fetch(`${r.base}${url}`, { method: "PUT", headers: { cookie: c, origin: PUBLIC, "content-type": "application/json" }, body: JSON.stringify({ balance: 1 }) });
  assert.equal(noCsrf.status, 403);
  assert.equal(getAccount(r.store.db, "pi/alice-key")!.balanceUsd, null);
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

test("consent: agree false stops sharing, agree true shares again, each at that moment and by the owner; agree must be a boolean", async () => {
  const r = await rig();
  seed(r);
  const c = await signIn(r, "alice@example.test");
  assert.equal((await api<ApiError>(r, c, "POST", "/api/accounts/pi/alice-key/consent", { agree: "no" })).status, 400);
  assert.equal((await api<ApiError>(r, c, "POST", "/api/accounts/pi/alice-key/consent", {})).status, 400);
  const off = await api<AccountView>(r, c, "POST", "/api/accounts/pi/alice-key/consent", { agree: false });
  assert.deepEqual([off.body.sharing, off.body.consentAt, off.body.consentBy], [false, undefined, undefined]);
  const ok = await api<AccountView>(r, c, "POST", "/api/accounts/pi/alice-key/consent", { agree: true });
  assert.deepEqual([ok.body.sharing, ok.body.consentAt, ok.body.consentBy], [true, NOW.toISOString(), "alice@example.test"]);
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

test("CORS: a listed origin gets credentialed access on /api only; others get nothing", async () => {
  const APP = "https://app.example.test";
  const r = await rig({}, { SQUAD_WEB_API_ORIGINS: APP });
  seed(r);
  const c = await signIn(r, "alice@example.test");
  const get = await fetch(`${r.base}/api/me`, { headers: { cookie: c, origin: APP } });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("access-control-allow-origin"), APP);
  assert.equal(get.headers.get("access-control-allow-credentials"), "true");
  assert.match(get.headers.get("vary") ?? "", /origin/i);
  const pre = await fetch(`${r.base}/api/accounts/pi/alice-key/enabled`, { method: "OPTIONS", headers: { origin: APP, "access-control-request-method": "PUT" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), APP);
  assert.equal(pre.headers.get("access-control-allow-credentials"), "true");
  assert.equal(pre.headers.get("access-control-allow-headers"), "content-type, x-squad-csrf");
  assert.equal(pre.headers.get("access-control-max-age"), "600");
  const methods = (pre.headers.get("access-control-allow-methods") ?? "").split(", ").sort();
  assert.deepEqual(methods, [...new Set(Object.values(ROUTES).map((x) => x.method))].sort());
  const put = (origin: string): Promise<Response> => fetch(`${r.base}/api/accounts/pi/alice-key/enabled`, { method: "PUT", headers: { cookie: c, "content-type": "application/json", "x-squad-csrf": "1", origin }, body: '{"enabled":false}' });
  const ok = await put(APP);
  assert.equal(ok.status, 200, "a write from a listed origin passes csrf");
  assert.equal(ok.headers.get("access-control-allow-origin"), APP);
  const evil = "https://evil.example.test";
  const no = await put(evil);
  assert.equal(no.status, 403);
  assert.equal(no.headers.get("access-control-allow-origin"), null);
  const noGet = await fetch(`${r.base}/api/me`, { headers: { cookie: c, origin: evil } });
  assert.equal(noGet.headers.get("access-control-allow-origin"), null);
  assert.equal(noGet.headers.get("access-control-allow-credentials"), null);
  const noPre = await fetch(`${r.base}/api/me`, { method: "OPTIONS", headers: { origin: evil } });
  assert.equal(noPre.status, 405);
  assert.equal(noPre.headers.get("access-control-allow-origin"), null);
  for (const path of ["/auth/login", "/auth/callback", "/"]) {
    const x = await fetch(`${r.base}${path}`, { redirect: "manual", headers: { origin: APP } });
    assert.equal(x.headers.get("access-control-allow-origin"), null, path);
  }
  const lo = await fetch(`${r.base}/auth/logout`, { method: "POST", headers: { cookie: c, origin: APP, "x-squad-csrf": "1" } });
  assert.equal(lo.status, 403, "logout is not for other origins");
  await r.close();
});

test("CORS: with no setting, nobody gets headers and a preflight is refused", async () => {
  const r = await rig();
  const x = await fetch(`${r.base}/api/me`, { method: "OPTIONS", headers: { origin: "https://app.example.test" } });
  assert.equal(x.status, 405);
  assert.equal(x.headers.get("access-control-allow-origin"), null);
  await r.close();
});

test("/auth/logout/everywhere: POST with the csrf proof; clears the session and answers the provider's end-session URL with client_id only: no post-logout address to register, never an ID token", async () => {
  const r = await rig();
  const c = await signIn(r, "alice@example.test");
  const path = "/auth/logout/everywhere";
  assert.equal((await fetch(`${r.base}${path}`, { headers: { cookie: c } })).status, 405);
  assert.equal((await fetch(`${r.base}${path}`, { method: "POST", headers: { cookie: c, origin: PUBLIC } })).status, 403);
  assert.equal((await fetch(`${r.base}${path}`, { method: "POST", headers: { cookie: c, origin: "https://other.example.test", "x-squad-csrf": "1" } })).status, 403);
  const out = await fetch(`${r.base}${path}`, { method: "POST", headers: { cookie: c, origin: PUBLIC, "x-squad-csrf": "1" } });
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie().join("\n"), /squad_session=; .*Max-Age=0/);
  assert.equal(out.headers.get("cache-control"), "no-store");
  const body = (await out.json()) as LogoutEverywhere;
  assert.equal(findForbidden(body), undefined);
  assert.equal(body.provider, true);
  const to = new URL(body.to);
  assert.equal(`${to.origin}${to.pathname}`, `${p.issuer}/end-session`);
  assert.equal(to.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(to.searchParams.has("post_logout_redirect_uri"), false, "nothing to register at the provider: its own page stays open in its own tab");
  assert.equal(to.searchParams.has("id_token_hint"), false, "squad keeps no ID token");
  // The provider ends its session and shows its own signed-out page.
  const seen = p.endSessionRequests.length;
  const end = await fetch(body.to, { redirect: "manual" });
  assert.equal(end.status, 200);
  assert.equal(p.endSessionRequests.length, seen + 1);
  assert.ok(!r.logs.join("\n").includes(c.split("=")[1]!), "no session cookie in a log");
  await r.close();
});

test("/auth/logout/everywhere with a provider that has no end-session link: only squad's session ends, and the signed-out page says so", async () => {
  p.endSession = false;
  try {
    const r = await rig();
    const c = await signIn(r, "alice@example.test");
    const out = await fetch(`${r.base}/auth/logout/everywhere`, { method: "POST", headers: { cookie: c, origin: PUBLIC, "x-squad-csrf": "1" } });
    assert.equal(out.status, 200);
    assert.match(out.headers.getSetCookie().join("\n"), /squad_session=; .*Max-Age=0/);
    assert.deepEqual(await out.json(), { to: "/signed-out?provider=none", provider: false });
    await r.close();
  } finally {
    p.endSession = true;
  }
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
  for (const route of ["/catalog/models/qwen3.8-max", "/catalog/models/solar-mini4:free", "/catalog/glm-5.2", "/catalog/models/%40cf%2Fmeta%2Fllama-4.1"]) {
    assert.equal(noNonce((await get(route)).text), noNonce(index.text), `a client route with a dot or an odd part gets index.html: ${route}`);
  }
  assert.equal((await get("/missing.png")).status, 404, "a file type the server knows stays a 404");
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

const PNG = (tag: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const ICO = (tag: string): Buffer => Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.from(tag)]);

test("SQUAD_WEB_BRAND_DIR: the four brand names come from that folder; anything else, a bad file or no setting is the built-in file", async () => {
  const root = mkdtempSync(join(tmpdir(), "brand-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "brand"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html></html>");
  for (const f of ["logo-light.png", "logo-dark.png", "logo-light-128.png", "apple-touch-icon.png"]) writeFileSync(join(dist, "brand", f), PNG(`builtin ${f}`));
  writeFileSync(join(dist, "brand", "favicon.ico"), ICO("builtin favicon"));
  const own = join(root, "own");
  mkdirSync(own);
  writeFileSync(join(own, "logo-dark.png"), PNG("own dark"));
  writeFileSync(join(own, "favicon.ico"), ICO("own favicon"));
  writeFileSync(join(own, "logo-light-128.png"), PNG("own small"));
  writeFileSync(join(own, "apple-touch-icon.png"), "<svg>not a png</svg>");
  writeFileSync(join(root, "secret.png"), PNG("TOP-SECRET"));
  const get = async (r: Rig, path: string): Promise<{ status: number; text: string; type: string | null }> => {
    const res = await fetch(`${r.base}${path}`);
    return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString("latin1"), type: res.headers.get("content-type") };
  };
  const plain = await rig({ staticDir: dist });
  assert.match((await get(plain, "/brand/logo-dark.png")).text, /builtin logo-dark/, "no setting: built-in");
  await plain.close();

  const r = await rig({ staticDir: dist }, { SQUAD_WEB_BRAND_DIR: own });
  const dark = await get(r, "/brand/logo-dark.png");
  assert.deepEqual([dark.status, dark.type], [200, "image/png"]);
  assert.match(dark.text, /own dark/);
  // Only logo-dark is in the folder: it stands in for logo-light too.
  assert.match((await get(r, "/brand/logo-light.png")).text, /own dark/);
  const fav = await get(r, "/brand/favicon.ico");
  assert.deepEqual([fav.status, fav.type], [200, "image/x-icon"]);
  assert.match(Buffer.from(fav.text, "latin1").toString(), /own favicon/);
  assert.match((await get(r, "/brand/logo-light-128.png")).text, /builtin logo-light-128/, "not one of the four names: built-in");
  assert.match((await get(r, "/brand/apple-touch-icon.png")).text, /builtin apple-touch-icon/, "not an image: built-in");
  await r.close();

  // A symlink out of the folder, a file over 2 MB: built-in. logo-light only: it stands in for logo-dark.
  const other = join(root, "other");
  mkdirSync(other);
  symlinkSync(join(root, "secret.png"), join(other, "logo-light.png"));
  writeFileSync(join(other, "favicon.ico"), Buffer.concat([ICO("big"), Buffer.alloc(2 * 1024 * 1024)]));
  const r2 = await rig({ staticDir: dist }, { SQUAD_WEB_BRAND_DIR: other });
  for (const f of ["logo-light.png", "logo-dark.png"]) {
    const res = await get(r2, `/brand/${f}`);
    assert.ok(!res.text.includes("TOP-SECRET"), f);
    assert.match(res.text, new RegExp(`builtin ${f}`), f);
  }
  assert.match(Buffer.from((await get(r2, "/brand/favicon.ico")).text, "latin1").toString(), /builtin favicon/, "over 2 MB: built-in");
  for (const bad of ["/brand/..%2Fsecret.png", "/brand/%2e%2e/secret.png"]) assert.ok(!(await get(r2, bad)).text.includes("TOP-SECRET"), bad);
  await r2.close();

  const light = join(root, "light");
  mkdirSync(light);
  writeFileSync(join(light, "logo-light.png"), PNG("own light"));
  const r3 = await rig({ staticDir: dist }, { SQUAD_WEB_BRAND_DIR: light });
  assert.match((await get(r3, "/brand/logo-dark.png")).text, /own light/);
  await r3.close();
});

test("a page loaded in a frame (Sec-Fetch-Dest: iframe) is marked on <html>, so its loader stays see-through before any script", async () => {
  const root = mkdtempSync(join(tmpdir(), "static-"));
  writeFileSync(join(root, "index.html"), '<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>');
  const r = await rig({ staticDir: root });
  const framed = await fetch(`${r.base}/accounts`, { headers: { "sec-fetch-dest": "iframe" } });
  assert.match(await framed.text(), /<html data-framed="" lang="en">/);
  assert.match(framed.headers.get("vary") ?? "", /sec-fetch-dest/i);
  for (const dest of [undefined, "document", "iframe2"]) {
    const res = await fetch(`${r.base}/`, { headers: dest === undefined ? {} : { "sec-fetch-dest": dest } });
    assert.doesNotMatch(await res.text(), /data-framed/, String(dest));
    assert.match(res.headers.get("vary") ?? "", /sec-fetch-dest/i, "the answer depends on the header either way");
  }
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

test("frame-ancestors: a page allows the configured parents; api and auth answers never do", async () => {
  const root = mkdtempSync(join(tmpdir(), "static-"));
  writeFileSync(join(root, "index.html"), "<html><head></head><body></body></html>");
  const r = await rig({ staticDir: root }, { SQUAD_WEB_FRAME_ANCESTORS: "https://app.example.test" });
  try {
    const page = (await fetch(`${r.base}/accounts`)).headers.get("content-security-policy") ?? "";
    assert.match(page, /frame-ancestors https:\/\/app\.example\.test$/);
    const apiCsp = (await fetch(`${r.base}/api/me`)).headers.get("content-security-policy") ?? "";
    assert.match(apiCsp, /frame-ancestors 'none'/);
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
  // A second start replaces the first: its page was closed, so it would block the account for 15 minutes.
  const again = await api<{ loginId: string }>(r, alice, "POST", "/api/accounts/codex/alice/login");
  assert.equal(again.status, 200);
  assert.notEqual(again.body.loginId, ok.body.loginId);
  assert.deepEqual((await api<{ state: string }>(r, alice, "GET", `/api/logins/${ok.body.loginId}`)).body, { loginId: ok.body.loginId, state: "expired" });
  const st = await api<{ state: string }>(r, alice, "GET", `/api/logins/${again.body.loginId}`);
  assert.deepEqual(st.body, { loginId: again.body.loginId, state: "pending" });
  assert.equal((await api<ApiError>(r, bob, "GET", `/api/logins/${again.body.loginId}`)).status, 404);
  await r.close();
  assert.equal(f.stops.length, 2, "the replaced login and, at server close, the running one are stopped");
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
  const caps = await api<AccountView>(r, admin, "PUT", "/api/accounts/pi/bob/caps", { cap5h: 2, capWeek: null, cap30d: 50 });
  assert.deepEqual([caps.status, caps.body.cap5h, caps.body.capWeek, caps.body.cap30d], [200, 2, undefined, 50]);
  const bal = await api<AccountView>(r, admin, "PUT", "/api/accounts/pi/bob/balance", { balance: 10 });
  assert.deepEqual([bal.status, bal.body.balanceUsd, bal.body.balanceLeft], [200, 10, 10]);
  assert.equal((await api<AccountView>(r, admin, "PUT", "/api/accounts/pi/bob/enabled", { enabled: false })).body.health, "disabled");
  assert.equal((await api<AccountView>(r, admin, "PUT", "/api/accounts/pi/bob/enabled", { enabled: true })).body.health, "ok");
  const consent = await api<ApiError>(r, admin, "POST", "/api/accounts/pi/bob/consent", { agree: false });
  assert.deepEqual([consent.status, consent.body.error], [404, "not-found"]);
  assert.equal(getAccount(r.store.db, "pi/bob")!.consentAt, NOW.toISOString());
  const login = await api<ApiError>(r, admin, "POST", "/api/accounts/codex/alice/login");
  assert.equal(login.status, 404);
  assert.equal(f.procs.length, 0, "no container for another person's login");
  // The owner who is no admin still cannot touch a stranger's account.
  const alice = await signIn(r, "alice@example.test");
  assert.equal((await api<ApiError>(r, alice, "PUT", "/api/accounts/pi/bob/floor", { floor5h: 1, floorWeek: 1 })).status, 404);
  assert.equal(getAccount(r.store.db, "pi/bob")!.floor5h, 30);
  assert.equal((await api<ApiError>(r, alice, "PUT", "/api/accounts/pi/bob/caps", { cap5h: null, capWeek: null, cap30d: null })).status, 404);
  assert.equal(getAccount(r.store.db, "pi/bob")!.cap5h, 2);
  assert.equal((await api<ApiError>(r, alice, "PUT", "/api/accounts/pi/bob/balance", { balance: null })).status, 404);
  assert.equal(getAccount(r.store.db, "pi/bob")!.balanceUsd, 10);
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

test("addAccount codex: a bad body is 400; a bad name is 400, an existing name 409; the login starts for the person", async () => {
  const f = fakeLogin();
  const r = await rig({ login: f.opts });
  seed(r);
  const alice = await signIn(r, "alice@example.test");
  for (const body of [{ runner: "claude", name: "x", token: 5 }, { runner: "claude", name: "x", extra: 1 }, { runner: "pi", name: "x" }, { runner: "pi", name: "x", key: "k" }, { runner: "dsh", name: "x" }, { name: "x" }, { runner: "codex" }, { runner: "codex", name: 5 }, { runner: "codex", name: "x", extra: 1 }, { runner: "codex", name: "x", key: "k" }]) {
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
  const bob = await signIn(r, "bob@example.test");
  assert.equal((await api<ApiError>(r, bob, "POST", "/api/accounts", { runner: "codex", name: "seat-one" })).status, 409, "the same name from another person while its login runs");
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

// ---- providers, and adding a claude token or a pi key from the web ----

const LOCAL_CATALOG = readFileSync(new URL("../../test/fixtures/captures/prices/local-models-dev-excerpt.json", import.meta.url), "utf8");
const FAKE_KEY = "sk-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const FAKE_TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKE";

async function withCatalog(r: Rig): Promise<void> {
  assert.equal(await refreshPrices({ home: r.home, url: "https://catalog.test/api.json", now: NOW.getTime(), fetch: async () => ({ ok: true, status: 200, text: async () => LOCAL_CATALOG }), env: {} }), "refreshed");
}

test("listProviders: seats, pi built-ins and custom catalog providers with their model counts; passes findForbidden", async () => {
  const r = await rig();
  await withCatalog(r);
  const c = await signIn(r, "alice@example.test");
  const res = await api<ProviderView[]>(r, c, "GET", "/api/providers");
  assert.equal(res.status, 200);
  assert.equal(findForbidden(res.body), undefined);
  assert.deepEqual(res.body.slice(0, 2).map((p) => [p.id, p.runner, p.kind]), [["codex", "codex", "login"], ["claude", "claude", "token"]]);
  assert.deepEqual(res.body.find((p) => p.id === "opencode-go"), { id: "opencode-go", name: "OpenCode Go", runner: "pi", kind: "key", builtin: true, models: res.body.find((p) => p.id === "opencode-go")!.models, accounts: 0 });
  assert.ok(res.body.find((p) => p.id === "engy")!.models > 0);
  assert.equal(res.body.find((p) => p.id === "engy")!.builtin, undefined);
  assert.equal((await api(r, undefined, "GET", "/api/providers")).status, 401);
  await r.close();
});

test("listProviders counts the accounts the person can see: codex and claude by runner, pi by the providers in auth.json; never another person's", async () => {
  const r = await rig();
  await withCatalog(r);
  seed(r);
  const alice = await signIn(r, "alice@example.test");
  const bob = await signIn(r, "bob@example.test");
  assert.equal((await api(r, alice, "POST", "/api/accounts", { runner: "pi", name: "e1", provider: "engy", key: FAKE_KEY })).status, 200);
  assert.equal((await api(r, alice, "POST", "/api/accounts", { runner: "pi", name: "e2", provider: "engy", key: FAKE_KEY })).status, 200);
  assert.equal((await api(r, bob, "POST", "/api/accounts", { runner: "pi", name: "z1", provider: "opencode-go", key: FAKE_KEY })).status, 200);
  const count = async (c: string): Promise<Record<string, number>> =>
    Object.fromEntries((await api<ProviderView[]>(r, c, "GET", "/api/providers")).body.filter((p) => p.accounts > 0).map((p) => [p.id, p.accounts]));
  assert.deepEqual(await count(alice), { codex: 1, engy: 2 });
  assert.deepEqual(await count(bob), { "opencode-go": 1 });
  await r.close();
});

test("SQUAD_WEB_PROVIDERS restricts the list and the server refuses the rest, for every runner", async () => {
  const r = await rig({}, { SQUAD_WEB_PROVIDERS: "engy,codex" });
  await withCatalog(r);
  const c = await signIn(r, "alice@example.test");
  assert.deepEqual((await api<ProviderView[]>(r, c, "GET", "/api/providers")).body.map((p) => p.id), ["codex", "engy"]);
  assert.equal((await api(r, c, "POST", "/api/accounts", { runner: "claude", name: "t", token: FAKE_TOKEN })).status, 400);
  assert.equal((await api(r, c, "POST", "/api/accounts", { runner: "pi", name: "k", provider: "sumopod", key: FAKE_KEY })).status, 400);
  assert.equal((await api(r, c, "POST", "/api/accounts", { runner: "pi", name: "k", provider: "engy", key: FAKE_KEY })).status, 200);
  await r.close();
});

test("addAccount claude: writes a token account owned by the person (file 0600), answers the AccountView, and never echoes or logs the token", async () => {
  const r = await rig();
  const c = await signIn(r, "Alice@Example.Test");
  const res = await api<AccountView>(r, c, "POST", "/api/accounts", { runner: "claude", name: "my-claude", token: FAKE_TOKEN });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.account, res.body.kind, res.body.ownerEmail, res.body.runner], ["claude/my-claude", "token", "alice@example.test", "claude"]);
  assert.equal(findForbidden(res.body), undefined);
  const file = join(r.home.accounts, "claude", "my-claude", "token");
  assert.equal(readFileSync(file, "utf8"), FAKE_TOKEN);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(getAccount(r.store.db, "claude/my-claude")?.kind, "token");
  assert.ok(!JSON.stringify(res.body).includes("FAKEFAKE"));
  assert.ok(!r.logs.join("\n").includes("FAKEFAKE"), "no log line holds the token");
  assert.equal((await api<AccountView[]>(r, c, "GET", "/api/accounts")).body.some((a) => a.account === "claude/my-claude"), true);
  await r.close();
});

test("addAccount pi: a built-in provider gets only auth.json; a custom one also gets a models.json built from the catalog", async () => {
  const r = await rig();
  await withCatalog(r);
  const c = await signIn(r, "alice@example.test");
  const a = await api<AccountView>(r, c, "POST", "/api/accounts", { runner: "pi", name: "oc", provider: "opencode-go", key: FAKE_KEY });
  assert.deepEqual([a.status, a.body.kind, a.body.runner], [200, "key", "pi"]);
  const dirA = join(r.home.accounts, "pi", "oc");
  assert.deepEqual(readdirSync(dirA), ["auth.json"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dirA, "auth.json"), "utf8")), { "opencode-go": { type: "api_key", key: FAKE_KEY } });
  const b = await api<AccountView>(r, c, "POST", "/api/accounts", { runner: "pi", name: "eg", provider: "engy", key: FAKE_KEY });
  assert.equal(b.status, 200);
  const dirB = join(r.home.accounts, "pi", "eg");
  assert.deepEqual(readdirSync(dirB).sort(), ["auth.json", "models.json"]);
  assert.equal(statSync(join(dirB, "models.json")).mode & 0o777, 0o600);
  const models = JSON.parse(readFileSync(join(dirB, "models.json"), "utf8"));
  assert.equal(models.providers.engy.baseUrl, "https://api.engy.ai/v1");
  assert.ok(models.providers.engy.models.length > 0);
  assert.ok(!readFileSync(join(dirB, "models.json"), "utf8").includes("FAKEFAKE"), "the key is only in auth.json");
  for (const x of [a, b]) assert.ok(!JSON.stringify(x.body).includes("FAKEFAKE"));
  assert.ok(!r.logs.join("\n").includes("FAKEFAKE"));
  await r.close();
});

test("addAccount key/token: bad shapes are 400 with a fixed message, an existing name is 409, a dry run is 501; nothing is written and nothing is echoed", async () => {
  const r = await rig();
  await withCatalog(r);
  seed(r);
  const c = await signIn(r, "alice@example.test");
  const post = (body: unknown) => api<ApiError>(r, c, "POST", "/api/accounts", body);
  const secret = "sk-SECRET-with space";
  for (const body of [
    { runner: "claude", name: "x", token: "" }, { runner: "claude", name: "x", token: secret }, { runner: "claude", name: "x", token: "a\nb" }, { runner: "claude", name: "x", token: "t".repeat(5000) },
    { runner: "pi", name: "x", provider: "engy", key: secret }, { runner: "pi", name: "x", provider: "nope", key: FAKE_KEY }, { runner: "pi", name: "x", provider: "engy", key: 5 },
    { runner: "pi", name: "../x", provider: "engy", key: FAKE_KEY }, { runner: "claude", name: "Big", token: FAKE_TOKEN }, { runner: "pi", name: "x", provider: "azure", key: FAKE_KEY },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok(!JSON.stringify(res.body).includes("SECRET") && !JSON.stringify(res.body).includes("FAKEFAKE"), "the answer does not echo the secret");
  }
  assert.deepEqual(readdirSync(r.home.accounts), [], "nothing was written");
  const dupe = await post({ runner: "pi", name: "alice-key", provider: "engy", key: FAKE_KEY });
  assert.deepEqual([dupe.status, dupe.body.error], [409, "conflict"]);
  assert.equal((await post({ runner: "claude", name: "x", token: FAKE_TOKEN })).status, 200);
  assert.equal((await post({ runner: "claude", name: "x", token: FAKE_TOKEN })).status, 409);
  assert.equal((await post({ runner: "claude", name: "q", token: FAKE_TOKEN, extra: 1 })).status, 400);
  assert.ok(!r.logs.join("\n").includes("SECRET") && !r.logs.join("\n").includes("FAKEFAKE"));
  assert.equal((await api(r, undefined, "POST", "/api/accounts", { runner: "claude", name: "q", token: FAKE_TOKEN })).status, 401);
  await r.close();
  const dry = await rig({}, { SQUAD_DRY_RUN: "1" });
  const d = await signIn(dry, "alice@example.test");
  assert.equal((await api(dry, d, "POST", "/api/accounts", { runner: "claude", name: "x", token: FAKE_TOKEN })).status, 501);
  assert.deepEqual(readdirSync(dry.home.accounts), []);
  await dry.close();
});

test("the usage and pass answers carry both costs", async () => {
  const r = await rig();
  seed(r);
  r.store.startPass({ id: "C1", startedAt: "2026-10-24T10:00:00.000Z", project: "p", flow: "f", action: "a", runner: "pi", model: "engy/glm-5.2", account: "pi/alice-key" });
  r.store.endPass({ id: "C1", endedAt: "2026-10-24T10:01:00.000Z", outcome: "ok", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costUsd: 0.5, cliCostUsd: 0.4, catalogCostUsd: 0.5 });
  const c = await signIn(r, "alice@example.test");
  const one = (await api<PassView>(r, c, "GET", "/api/passes/C1")).body;
  assert.deepEqual([one.costUsd, one.cliCostUsd, one.catalogCostUsd], [0.5, 0.4, 0.5]);
  const list = (await api<PassView[]>(r, c, "GET", "/api/passes")).body;
  assert.deepEqual([list[0]!.cliCostUsd, list[0]!.catalogCostUsd], [0.4, 0.5]);
  const u = (await api<UsageRow[]>(r, c, "GET", "/api/usage?by=model&since=2d")).body;
  assert.deepEqual([u[0]!.key, u[0]!.cliCostUsd, u[0]!.catalogCostUsd], ["engy/glm-5.2", 0.4, 0.5]);
  const s = (await api<UsageSeriesPoint[]>(r, c, "GET", "/api/usage/series?by=day&since=2d")).body;
  assert.deepEqual([s[0]!.cliCostUsd, s[0]!.catalogCostUsd], [0.4, 0.5]);
  await r.close();
});

// ---- the catalog pages ----

test("catalogProviders: every saved provider with its runner, offer state and the person's own account count; empty with no saved copy", async () => {
  const r = await rig();
  const c0 = await signIn(r, "alice@example.test");
  assert.deepEqual((await api(r, c0, "GET", "/api/catalog/providers")).body, []);
  await withCatalog(r);
  seed(r);
  const alice = await signIn(r, "alice@example.test");
  const bob = await signIn(r, "bob@example.test");
  assert.equal((await api(r, alice, "POST", "/api/accounts", { runner: "pi", name: "og", provider: "opencode-go", key: FAKE_KEY })).status, 200);
  const res = await api<CatalogProviderView[]>(r, alice, "GET", "/api/catalog/providers");
  assert.equal(res.status, 200);
  assert.equal(findForbidden(res.body), undefined);
  assert.deepEqual(res.body.map((p) => p.id), ["alibaba-token-plan", "anthropic", "engy", "kenari", "openai", "opencode", "opencode-go", "sumopod"]);
  const used = (b: CatalogProviderView[]) => Object.fromEntries(b.filter((p) => p.accounts > 0).map((p) => [p.id, p.accounts]));
  assert.deepEqual(used(res.body), { openai: 1, "opencode-go": 1 }, "codex/alice counts for openai");
  assert.deepEqual(used((await api<CatalogProviderView[]>(r, bob, "GET", "/api/catalog/providers")).body), {}, "never another person's");
  assert.deepEqual(res.body.find((p) => p.id === "sumopod"), { id: "sumopod", name: "SumoPod", runner: "pi", offered: true, addAs: "sumopod", models: 2, accounts: 0, cheapest: { input: 0.14, output: 0.28 } });
  await r.close();
});

test("catalogProviders: offered follows SQUAD_WEB_PROVIDERS", async () => {
  const r = await rig({}, { SQUAD_WEB_PROVIDERS: "engy,codex" });
  await withCatalog(r);
  const c = await signIn(r, "alice@example.test");
  const res = await api<CatalogProviderView[]>(r, c, "GET", "/api/catalog/providers");
  assert.deepEqual(res.body.filter((p) => p.offered).map((p) => [p.id, p.addAs]), [["engy", "engy"], ["openai", "codex"]]);
  assert.equal(res.body.length, 8, "a provider that is not offered still shows");
  await r.close();
});

test("catalogProvider: the models of one provider; 404 for an unknown id, 400 for a bad one", async () => {
  const r = await rig();
  await withCatalog(r);
  const c = await signIn(r, "alice@example.test");
  const res = await api<CatalogProviderDetail>(r, c, "GET", "/api/catalog/providers/opencode");
  assert.equal(res.status, 200);
  assert.equal(findForbidden(res.body), undefined);
  assert.equal(res.body.provider.name, "OpenCode");
  assert.deepEqual(res.body.models.map((m) => [m.id, m.otherProviders]), [["claude-sonnet-4-6", 1], ["muse-wonder-1.0", 1], ["qwen3.8-max", 3]]);
  const nope = await api<ApiError>(r, c, "GET", "/api/catalog/providers/nope");
  assert.deepEqual([nope.status, nope.body.error], [404, "not-found"]);
  for (const bad of ["-x", "a%20b", "x".repeat(65)]) assert.equal((await api(r, c, "GET", `/api/catalog/providers/${bad}`)).status, 400, bad);
  assert.equal((await api(r, undefined, "GET", "/api/catalog/providers/opencode")).status, 401);
  await r.close();
});

test("catalogModel: one model across providers, cheapest first, with the price history of the last 90 days", async () => {
  const r = await rig();
  await withCatalog(r);
  recordPriceHistory(r.store.db, new Map([["sumopod/qwen3.8-max", { input: 1.5, output: 4 }]]), new Date("2026-05-01T00:00:00Z"));
  recordPriceHistory(r.store.db, new Map([["sumopod/qwen3.8-max", { input: 1.2, output: 3.5 }], ["engy/glm-5.2", { input: 0.68, output: 1.5 }]]), new Date("2026-09-01T00:00:00Z"));
  recordPriceHistory(r.store.db, new Map([["sumopod/qwen3.8-max", { input: 1, output: 3 }]]), new Date("2026-10-10T00:00:00Z"));
  const c = await signIn(r, "alice@example.test");
  const res = await api<CatalogModelCompare>(r, c, "GET", "/api/catalog/models/qwen3.8-max");
  assert.equal(res.status, 200);
  assert.equal(findForbidden(res.body), undefined);
  assert.deepEqual(res.body.offers.map((o) => [o.provider, o.cheapest]), [["sumopod", true], ["alibaba-token-plan", false], ["opencode", false], ["opencode-go", false]]);
  assert.deepEqual(res.body.history, [
    { provider: "sumopod", modelId: "qwen3.8-max", at: "2026-09-01T00:00:00.000Z", input: 1.2, output: 3.5 },
    { provider: "sumopod", modelId: "qwen3.8-max", at: "2026-10-10T00:00:00.000Z", input: 1, output: 3 },
  ]);
  // By canonical id: kenari's muse-wonder-1-0 is opencode's muse-wonder-1.0, and the URL may hold either id.
  for (const id of ["muse-wonder-1-0", encodeURIComponent("meta/muse-wonder-1.0")]) {
    const mw = await api<CatalogModelCompare>(r, c, "GET", `/api/catalog/models/${id}`);
    assert.deepEqual([mw.status, mw.body.canonical, mw.body.offers.map((o) => [o.provider, o.modelId])], [200, "meta/muse-wonder-1.0", [["kenari", "muse-wonder-1-0"], ["opencode", "muse-wonder-1.0"]]], id);
  }
  const colon = await api<CatalogModelCompare>(r, c, "GET", `/api/catalog/models/${encodeURIComponent("solar-mini4:free")}`);
  assert.deepEqual([colon.status, colon.body.offers.map((o) => o.provider)], [200, ["kenari"]]);
  for (const id of ["nope", "text-embedding-3-large", encodeURIComponent("a/b")]) assert.equal((await api(r, c, "GET", `/api/catalog/models/${id}`)).status, 404, id);
  for (const id of ["x".repeat(201), "a%20b", "%zz", "a%00b"]) assert.equal((await api(r, c, "GET", `/api/catalog/models/${id}`)).status, 400, id);
  // The URL parser folds an encoded `..` into a path step, so it never reaches the route.
  assert.equal((await api(r, c, "GET", "/api/catalog/models/%2E%2E")).status, 404);
  await r.close();
});

// ---- logos ----

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';

test("GET /logos/<id>.svg is served by squad from the catalog's copy, with a sandbox CSP, and needs no session", async () => {
  const asked: string[] = [];
  const catalogFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("http://catalog.test:7311/")) return fetch(url, init);
    asked.push(u);
    return Promise.resolve(u.endsWith("/logos/engy.svg") ? new Response(LOGO_SVG, { headers: { "content-type": "image/svg+xml" } }) : new Response("no", { status: 404 }));
  }) as typeof globalThis.fetch;
  const r = await rig({ fetch: catalogFetch }, { SQUAD_PRICES_URL: "http://catalog.test:7311/api.json" });
  const ok = await fetch(`${r.base}/logos/engy.svg`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), LOGO_SVG);
  assert.equal(ok.headers.get("content-type"), "image/svg+xml");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ok.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  assert.match(ok.headers.get("cache-control") ?? "", /max-age=\d+/);
  const again = await fetch(`${r.base}/logos/engy.svg`);
  assert.equal(await again.text(), LOGO_SVG);
  assert.deepEqual(asked, ["http://catalog.test:7311/logos/engy.svg"], "one fetch for two asks");
  const head = await fetch(`${r.base}/logos/engy.svg`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const path of ["/logos/missing.svg", "/logos/UPPER.svg", "/logos/..%2fx.svg", "/logos/engy.png", "/logos/", "/logos/a/b.svg"]) {
    const miss = await fetch(`${r.base}${path}`);
    assert.equal(miss.status, 404, path);
    assert.doesNotMatch(miss.headers.get("content-type") ?? "", /svg/, path);
  }
  const post = await fetch(`${r.base}/logos/engy.svg`, { method: "POST" });
  assert.equal(post.status, 405);
  await r.close();
});

test("with the catalog off, a logo that is not saved is a 404 and nothing is fetched", async () => {
  let calls = 0;
  const r = await rig({ fetch: (() => { calls++; return Promise.reject(new Error("no")); }) as typeof globalThis.fetch }, { SQUAD_NO_PRICES: "1" });
  assert.equal((await fetch(`${r.base}/logos/engy.svg`)).status, 404);
  assert.equal(calls, 0);
  await r.close();
});

// ---- claude setup-token from the web ----

const SETUP_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&response_type=code&scope=user%3Ainference&state=FAKESTATE000";
const SETUP_TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

function fakePty() {
  const procs: { say: (s: string) => void; exit: (c: number) => void; name: string; writes: string[] }[] = [];
  const stops: string[] = [];
  return {
    procs, stops,
    pty: {
      start: (argv: string[], name: string) => {
        // Like squad-browser in the image: the opened URL lands in the mounted folder.
        const staging = argv.find((a) => a.endsWith("target=/claude"))!.split(",")[1]!.replace("source=", "");
        writeFileSync(join(staging, ".squad-opened-url"), `${SETUP_URL.replace("&response_type=code&", "&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A40000%2Fcallback&")}\n`, { mode: 0o600 });
        let cb: (s: string) => void = () => {};
        let end: (c: number) => void = () => {};
        const exited = new Promise<number>((r) => { end = r; });
        const writes: string[] = [];
        procs.push({ say: (s) => cb(s), exit: end, name, writes });
        queueMicrotask(() => cb(`Browser didn't open?\r\n${SETUP_URL}\r\nPaste code here if prompted >`));
        return { onOutput: (f: (s: string) => void) => { cb = f; }, write: (s: string) => void writes.push(s), exited };
      },
      stop: async (n: string) => { stops.push(n); procs.find((p) => p.name === n)?.exit(143); },
    },
  };
}

test("adding claude with no token starts a server-side setup-token login; the code route is for its owner; the token makes the account and shows nowhere", async () => {
  const f = fakePty();
  const r = await rig({ login: { pty: f.pty } });
  await withCatalog(r);
  const alice = await signIn(r, "alice@example.test");
  const bob = await signIn(r, "bob@example.test");
  const start = await api<{ loginId: string; verifyUrl: string; needsCode?: true; userCode?: string }>(r, alice, "POST", "/api/accounts", { runner: "claude", name: "c1" });
  assert.equal(start.status, 200);
  assert.equal(start.body.verifyUrl, SETUP_URL.replace("&response_type=code&", "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&"));
  assert.equal(start.body.needsCode, true);
  assert.equal(start.body.userCode, undefined);
  assert.equal(findForbidden(start.body), undefined);
  const id = start.body.loginId;
  assert.deepEqual((await api(r, alice, "GET", `/api/logins/${id}`)).body, { loginId: id, state: "pending" });
  assert.equal((await api(r, bob, "GET", `/api/logins/${id}`)).status, 404);
  assert.equal((await api(r, bob, "POST", `/api/logins/${id}/code`, { code: "PAGE-CODE" })).status, 404);
  assert.equal((await api(r, undefined, "POST", `/api/logins/${id}/code`, { code: "PAGE-CODE" })).status, 401);
  assert.equal((await api(r, alice, "POST", `/api/logins/${id}/code`, { code: "has space" })).status, 400);
  assert.equal((await api(r, alice, "POST", `/api/logins/${id}/code`, { code: "x", extra: 1 })).status, 400);
  assert.equal((await api(r, alice, "POST", `/api/logins/${id}/code`, {})).status, 400);
  assert.equal((await api(r, alice, "POST", `/api/logins/${id}/code`, { code: "PAGE-CODE" }, { origin: "http://evil.test" })).status, 403);
  assert.deepEqual(f.procs[0]!.writes, []);
  const sent = await api(r, alice, "POST", `/api/logins/${id}/code`, { code: "PAGE-CODE" });
  assert.deepEqual([sent.status, sent.body], [200, { loginId: id, state: "pending" }]);
  await new Promise((ok) => setTimeout(ok, 400)); // Enter comes as its own key press, 250 ms after the code
  assert.deepEqual(f.procs[0]!.writes, ["PAGE-CODE", "\r"]);
  assert.equal((await api(r, alice, "POST", `/api/logins/${id}/code`, { code: "PAGE-CODE" })).status, 409);
  f.procs[0]!.say(`\r\n${SETUP_TOKEN}\r\n`);
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res));
  const done = await api(r, alice, "GET", `/api/logins/${id}`);
  assert.deepEqual(done.body, { loginId: id, state: "done" });
  const mine = await api<AccountView[]>(r, alice, "GET", "/api/accounts");
  assert.deepEqual(mine.body.map((a) => [a.account, a.kind, a.ownerEmail]), [["claude/c1", "token", "alice@example.test"]]);
  assert.equal(readFileSync(join(r.home.accounts, "claude", "c1", "token"), "utf8"), SETUP_TOKEN);
  assert.equal(statSync(join(r.home.accounts, "claude", "c1", "token")).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify([mine.body, done.body, sent.body]).includes("oat01") && !r.logs.join("\n").includes("oat01") && !r.logs.join("\n").includes("PAGE-CODE"), "no token or code in an answer or a log");
  assert.deepEqual(f.stops, [f.procs[0]!.name]);
  await r.close();
});

test("claude with a pasted token still writes the account at once; a dry run refuses the server-side login", async () => {
  const f = fakePty();
  const r = await rig({ login: { pty: f.pty } });
  await withCatalog(r);
  const c = await signIn(r, "alice@example.test");
  const paste = await api<AccountView>(r, c, "POST", "/api/accounts", { runner: "claude", name: "pasted", token: SETUP_TOKEN });
  assert.equal(paste.status, 200);
  assert.equal(paste.body.account, "claude/pasted");
  assert.equal(f.procs.length, 0);
  assert.equal((await api(r, c, "POST", "/api/accounts", { runner: "claude", name: "pasted" })).status, 409);
  await r.close();
  {
    const q = await rig({ login: { pty: fakePty().pty } }, { SQUAD_DRY_RUN: "1" });
    await withCatalog(q);
    const qc = await signIn(q, "alice@example.test");
    assert.equal((await api(q, qc, "POST", "/api/accounts", { runner: "claude", name: "x" })).status, 501);
    await q.close();
  }
});

// ---- "use my computer": squad connect ----

const CONNECT_TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKECONNECT";
const postToken = (r: Rig, code: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${r.base}/api/connect/${code}/token`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("startConnect gives the owner a code and the command; connectStatus is the owner's only; it needs a session and csrf", async () => {
  const r = await rig();
  await withCatalog(r);
  const alice = await signIn(r, "alice@example.test");
  const bob = await signIn(r, "bob@example.test");
  const s = await api<ConnectStart>(r, alice, "POST", "/api/connect", { runner: "claude", name: "c1" });
  assert.equal(s.status, 200);
  assert.equal(findForbidden(s.body), undefined);
  assert.ok(s.body.command.startsWith("npx -y https://github.com/hyhilman/squad/releases/download/v"), s.body.command);
  assert.ok(s.body.command.endsWith(`connect --url ${PUBLIC} --pair ${s.body.pairCode}`));
  assert.equal(s.body.shortCommand, `squad connect --url ${PUBLIC} --pair ${s.body.pairCode}`);
  const id = s.body.connectId;
  assert.deepEqual((await api<ConnectStatus>(r, alice, "GET", `/api/connect/${id}`)).body, { connectId: id, state: "pending" });
  assert.equal((await api(r, bob, "GET", `/api/connect/${id}`)).status, 404);
  assert.equal((await api(r, undefined, "GET", `/api/connect/${id}`)).status, 401);
  assert.equal((await api(r, undefined, "POST", "/api/connect", { runner: "claude", name: "c2" })).status, 401);
  assert.equal((await api(r, alice, "POST", "/api/connect", { runner: "claude", name: "c2" }, { origin: "http://evil.test" })).status, 403);
  for (const body of [{ runner: "codex", name: "c2" }, { runner: "claude" }, { runner: "claude", name: "c2", token: "x" }, { runner: "claude", name: "Bad Name" }]) {
    assert.equal((await api(r, alice, "POST", "/api/connect", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await api(r, alice, "POST", "/api/connect", { runner: "claude", name: "c1" })).status, 409, "one waiting sign-in per name");
  assert.ok(!r.logs.join("\n").includes(s.body.pairCode), "the code is never logged");
  await r.close();
});

test("the token route takes an optional email of the account user, shape-checked; a bad one is a 400 and the code stays good", async () => {
  const r = await rig();
  await withCatalog(r);
  const alice = await signIn(r, "alice@example.test");
  const s = await api<ConnectStart>(r, alice, "POST", "/api/connect", { runner: "claude", name: "c1" });
  for (const email of ["", "no-at", "a@b@c", "a b@c.d", 5, "x".repeat(250) + "@a.bc"]) {
    const res = await postToken(r, s.body.pairCode, { token: CONNECT_TOKEN, email });
    assert.equal(res.status, 400, JSON.stringify(email));
  }
  const ok = await postToken(r, s.body.pairCode, { token: CONNECT_TOKEN, email: "alice.personal@example.test" });
  assert.equal(ok.status, 200);
  assert.equal(getAccount(r.store.db, "claude/c1")!.loginEmail, "alice.personal@example.test");
  const view = await api<AccountView>(r, alice, "GET", "/api/accounts/claude/c1");
  assert.equal(view.body.loginEmail, "alice.personal@example.test");
  await r.close();
});

test("the token route: no session or csrf needed, no CORS ever, 8 KB cap; it makes the owner's account once and the token and code show nowhere", async () => {
  const APP = "https://app.example.test";
  const r = await rig({}, { SQUAD_WEB_API_ORIGINS: APP });
  await withCatalog(r);
  const alice = await signIn(r, "alice@example.test");
  const s = (await api<ConnectStart>(r, alice, "POST", "/api/connect", { runner: "claude", name: "c1" })).body;
  const pre = await fetch(`${r.base}/api/connect/${s.pairCode}/token`, { method: "OPTIONS", headers: { origin: APP, "access-control-request-method": "POST" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null, "no preflight answer");
  const big = await postToken(r, s.pairCode, { token: "x".repeat(9000) });
  assert.equal(big.status, 413);
  const wrong = await postToken(r, "W".repeat(43), { token: CONNECT_TOKEN });
  assert.deepEqual([wrong.status, await wrong.json()], [404, { error: "not-found", message: "not found" }]);
  const ok = await postToken(r, s.pairCode, { token: CONNECT_TOKEN }, { origin: APP });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), null);
  assert.equal(ok.headers.get("access-control-allow-credentials"), null);
  assert.deepEqual(await ok.json(), { account: "claude/c1" });
  assert.equal(readFileSync(join(r.home.accounts, "claude", "c1", "token"), "utf8"), CONNECT_TOKEN);
  assert.equal(statSync(join(r.home.accounts, "claude", "c1", "token")).mode & 0o777, 0o600);
  assert.equal(getAccount(r.store.db, "claude/c1")?.ownerEmail, "alice@example.test");
  const again = await postToken(r, s.pairCode, { token: CONNECT_TOKEN });
  assert.equal(again.status, 404, "single use");
  const st = await api<ConnectStatus>(r, alice, "GET", `/api/connect/${s.connectId}`);
  assert.deepEqual(st.body, { connectId: s.connectId, state: "done", account: "claude/c1" });
  // A path with the code that matches no route, and a wrong method, also keep it out of the log.
  await fetch(`${r.base}/api/connect/${s.pairCode}/token/x`, { method: "POST" });
  await fetch(`${r.base}/api/connect/${s.pairCode}/token`);
  const logs = r.logs.join("\n");
  assert.ok(!logs.includes(s.pairCode) && !logs.includes("oat01") && !logs.includes("CONNECT"), "no code or token in a log line");
  assert.ok(/event=connect_done/.test(logs) && /account=claude\/c1/.test(logs));
  assert.ok(r.logs.some((l) => /event=access/.test(l) && /route=connectToken/.test(l)));
  await r.close();
});

test("the token route refuses a bad body with a fixed message, and holds an address after 30 wrong codes", async () => {
  const r = await rig();
  await withCatalog(r);
  const alice = await signIn(r, "alice@example.test");
  const s = (await api<ConnectStart>(r, alice, "POST", "/api/connect", { runner: "claude", name: "c1" })).body;
  for (const body of ["not json", { token: 5 }, { token: CONNECT_TOKEN, extra: 1 }, {}]) {
    const res = await postToken(r, "W".repeat(43), body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(!JSON.stringify(await res.json()).includes("CONNECT"));
  }
  for (let i = 0; i < 30; i++) assert.equal((await postToken(r, `${"V".repeat(42)}${i}`, { token: CONNECT_TOKEN })).status, 404);
  const held = await postToken(r, s.pairCode, { token: CONNECT_TOKEN });
  assert.deepEqual([held.status, (await held.json() as { error: string }).error], [429, "too-many"]);
  assert.equal(getAccount(r.store.db, "claude/c1"), undefined);
  await r.close();
});

// ---- account care: consent gate, test, remove, reset health, log in again, limit reset ----

const okProbe = (calls: string[], limits: unknown[] = []) => async (a: { id: string }, model: string, l?: unknown) => {
  calls.push(`${a.id} ${model}`);
  limits.push(l);
  return { account: a.id, model, input: 10, output: 2, ms: 1234 };
};

test("a web add records the owner's consent; listAccounts hides removed accounts unless all=1, and the view shows removed", async () => {
  const r = await rig();
  await withCatalog(r);
  const c = await signIn(r, "alice@example.test");
  const added = await api<AccountView>(r, c, "POST", "/api/accounts", { runner: "claude", name: "t1", token: FAKE_TOKEN });
  assert.deepEqual([added.body.sharing, added.body.consentBy, added.body.consentAt], [true, "alice@example.test", NOW.toISOString()]);
  await api<AccountView>(r, c, "DELETE", "/api/accounts/claude/t1", { confirm: "claude/t1" });
  assert.deepEqual((await api<AccountView[]>(r, c, "GET", "/api/accounts")).body.map((a) => a.account), []);
  const all = await api<AccountView[]>(r, c, "GET", "/api/accounts?all=1");
  assert.deepEqual(all.body.map((a) => [a.account, a.health, a.sharing]), [["claude/t1", "removed", false]]);
  await r.close();
});

test("removeAccount: owner or admin, a typed confirm that equals the id, 409 while a pass holds it; the history stays and says removed", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  mkdirSync(join(r.home.accounts, "pi", "bob"), { recursive: true });
  writeFileSync(join(r.home.accounts, "pi", "bob", "auth.json"), "{}");
  storePass(r, "Z1", { account: "pi/bob" });
  const alice = await signIn(r, "alice@example.test");
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  assert.equal((await api<ApiError>(r, alice, "DELETE", "/api/accounts/pi/bob", { confirm: "pi/bob" })).status, 404, "not hers");
  for (const bad of [{}, { confirm: "pi/bo" }, { confirm: "bob" }, { confirm: "pi/bob", extra: 1 }]) assert.equal((await api<ApiError>(r, admin, "DELETE", "/api/accounts/pi/bob", bad)).status, 400, JSON.stringify(bad));
  assert.ok(existsSync(join(r.home.accounts, "pi", "bob")));
  const gone = await api<{ account: string; revoke: string }>(r, admin, "DELETE", "/api/accounts/pi/bob", { confirm: "pi/bob" });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.account, "pi/bob");
  assert.match(gone.body.revoke, /API keys page/);
  assert.equal(existsSync(join(r.home.accounts, "pi", "bob")), false);
  assert.equal(getAccount(r.store.db, "pi/bob")!.state, "removed");
  const hist = await api<PassView[]>(r, admin, "GET", "/api/passes");
  assert.deepEqual(hist.body.map((x) => [x.passId, x.account, x.accountRemoved]), [["Z1", "pi/bob", true]]);
  assert.equal((await api<ApiError>(r, admin, "DELETE", "/api/accounts/pi/bob", { confirm: "pi/bob" })).status, 409, "already removed");
  for (const [m, path, body] of [["PUT", "/api/accounts/pi/bob/floor", { floor5h: 1, floorWeek: 1 }], ["PUT", "/api/accounts/pi/bob/caps", { cap5h: 1, capWeek: null, cap30d: null }], ["PUT", "/api/accounts/pi/bob/balance", { balance: 5 }], ["PUT", "/api/accounts/pi/bob/enabled", { enabled: false }], ["POST", "/api/accounts/pi/bob/reset", undefined]] as const) {
    assert.equal((await api<ApiError>(r, admin, m, path, body)).status, 409, `${m} ${path} on a removed account`);
  }
  // A login whose lock a pass holds: 409, and nothing changes.
  const r2 = await rig({ busy: () => true }, ADMIN);
  seed(r2);
  const lock = join(r2.home.locks, "codex", "alice.lock");
  mkdirSync(join(r2.home.locks, "codex"), { recursive: true });
  writeFileSync(lock, "");
  const { spawn } = await import("node:child_process");
  const holder = spawn("flock", [lock, "sh", "-c", "echo held; read x"], { stdio: ["pipe", "pipe", "ignore"] });
  await new Promise<void>((done) => holder.stdout.once("data", () => done()));
  try {
    const a2 = await signIn(r2, "alice@example.test");
    const busy = await api<ApiError>(r2, a2, "DELETE", "/api/accounts/codex/alice", { confirm: "codex/alice" });
    assert.deepEqual([busy.status, busy.body.error], [409, "conflict"]);
    assert.equal(getAccount(r2.store.db, "codex/alice")!.state, "active");
  } finally {
    holder.stdin.end();
  }
  await r.close();
  await r2.close();
});

test("resetHealth: owner or admin; clears cooling; 409 'log in again' for a permanent code; canResetHealth says when it applies", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  putHealth(r.store.db, { ...emptyHealth("pi/bob"), coolUntil: "2026-10-24T13:00:00.000Z", coolKind: "rate-limit", lastFailCode: "429" });
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  const alice = await signIn(r, "alice@example.test");
  const before = await api<AccountView>(r, admin, "GET", "/api/accounts/pi/bob");
  assert.deepEqual([before.body.health, before.body.canResetHealth], ["cooling", true]);
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts/pi/bob/reset")).status, 404);
  const done = await api<AccountView>(r, admin, "POST", "/api/accounts/pi/bob/reset");
  assert.deepEqual([done.status, done.body.health, done.body.lastCode, done.body.canResetHealth], [200, "ok", undefined, false]);
  setState(r.store.db, "codex/alice", "dead", "refresh_token_reused", NOW);
  const dead = await api<AccountView>(r, alice, "GET", "/api/accounts/codex/alice");
  assert.equal(dead.body.canResetHealth, false);
  const refused = await api<ApiError>(r, alice, "POST", "/api/accounts/codex/alice/reset");
  assert.deepEqual([refused.status, refused.body.error], [409, "conflict"]);
  assert.match(refused.body.message, /log in again/);
  await r.close();
});

test("testAccount: owner or admin; a served model or the probe default, else 400; one per account per minute; 501 with no probe or in a dry run", async () => {
  const calls: string[] = [];
  const r = await rig({ probe: okProbe(calls) }, { ...ADMIN, SQUAD_PROBE_MODEL_PI: "zai/glm-fake" });
  seed(r);
  mkdirSync(join(r.home.accounts, "pi", "alice-key"), { recursive: true });
  writeFileSync(join(r.home.accounts, "pi", "alice-key", "models.json"), JSON.stringify({ providers: { zai: { models: [{ id: "glm-a" }, { id: "glm-b" }] } } }));
  const alice = await signIn(r, "alice@example.test");
  const bob = await signIn(r, "bob@example.test");
  const models = await api<{ models: string[]; defaultModel?: string }>(r, alice, "GET", "/api/accounts/pi/alice-key/models");
  assert.deepEqual(models.body, { models: ["zai/glm-a", "zai/glm-b"], defaultModel: "zai/glm-fake" });
  assert.equal((await api<ApiError>(r, bob, "POST", "/api/accounts/pi/alice-key/test", {})).status, 404);
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts/pi/alice-key/test", { model: 5 })).status, 400);
  const t = await api<{ ok: boolean; model: string; ms: number }>(r, alice, "POST", "/api/accounts/pi/alice-key/test", { model: "zai/glm-b" });
  assert.deepEqual([t.status, t.body.ok, t.body.model, t.body.ms], [200, true, "zai/glm-b", 1234]);
  assert.deepEqual(calls, ["pi/alice-key zai/glm-b"]);
  const again = await api<ApiError>(r, alice, "POST", "/api/accounts/pi/alice-key/test", { model: "zai/glm-b" });
  assert.deepEqual([again.status, again.body.error], [429, "too-many"]);
  // A model it does not serve falls back to the probe default.
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  const t2 = await api<{ ok: boolean; model: string }>(r, admin, "POST", "/api/accounts/pi/bob/test", { model: "not/served" });
  assert.equal(t2.body.model, "zai/glm-fake");
  // No default and no served model: pick one.
  const r2 = await rig({ probe: okProbe(calls) });
  seed(r2);
  const a2 = await signIn(r2, "alice@example.test");
  const pickOne = await api<ApiError>(r2, a2, "POST", "/api/accounts/pi/alice-key/test", {});
  assert.equal(pickOne.status, 400);
  assert.match(pickOne.body.message, /pick a model/);
  const r3 = await rig({}, { SQUAD_PROBE_MODEL_PI: "zai/glm-fake" });
  seed(r3);
  const a3 = await signIn(r3, "alice@example.test");
  assert.equal((await api<ApiError>(r3, a3, "POST", "/api/accounts/pi/alice-key/test", {})).status, 501);
  await r.close();
  await r2.close();
  await r3.close();
});

test("testAccount gives the pass a short deadline, so the answer comes back before the tunnel gives up (about 100 s)", async () => {
  const limits: unknown[] = [];
  const r = await rig({ probe: okProbe([], limits) }, { SQUAD_PROBE_MODEL_PI: "zai/glm-fake" });
  seed(r);
  const alice = await signIn(r, "alice@example.test");
  assert.equal((await api(r, alice, "POST", "/api/accounts/pi/alice-key/test", {})).status, 200);
  const l = limits[0] as { idleMs: number; deadlineMs: number };
  assert.ok(l.idleMs <= l.deadlineMs, "idle within the deadline");
  // The deadline plus the stop's grace time (SQUAD_STOP_GRACE_S, 20 s by default) and the kill's 2 s.
  assert.ok(l.deadlineMs + 20_000 + 2_000 < 100_000, `deadline ${l.deadlineMs} ms`);
  const timedOut = await rig({ probe: async (a, model) => ({ account: a.id, model, input: 0, output: 0, ms: 60_000, failure: { kind: "timeout", code: "", reason: "the deadline passed" } }) }, { SQUAD_PROBE_MODEL_PI: "zai/glm-fake" });
  seed(timedOut);
  const c = await signIn(timedOut, "alice@example.test");
  const t = await api<Record<string, unknown>>(timedOut, c, "POST", "/api/accounts/pi/alice-key/test", {});
  assert.deepEqual([t.status, t.body.ok, t.body.failureKind], [200, false, "timeout"]);
  await r.close();
  await timedOut.close();
});

test("testAccount answers a failure with its kind and code and the room after it; never a reason text", async () => {
  const r = await rig({ probe: async (a, model) => ({ account: a.id, model, input: 0, output: 0, ms: 50, failure: { kind: "auth", code: "401:AuthError", reason: "Invalid API key." } }) }, { SQUAD_PROBE_MODEL_PI: "zai/glm-fake" });
  seed(r);
  putHealth(r.store.db, { ...emptyHealth("pi/alice-key"), left5h: 40, leftWeek: 70 });
  const alice = await signIn(r, "alice@example.test");
  const t = await api<Record<string, unknown>>(r, alice, "POST", "/api/accounts/pi/alice-key/test", {});
  assert.deepEqual(t.body, { ok: false, model: "zai/glm-fake", failureKind: "auth", failureCode: "401:AuthError", ms: 50, left5h: 40, leftWeek: 70 });
  await r.close();
});

test("replaceSecret: the owner only; a claude token or a pi key by shape; health cleared and consent given; nothing echoed", async () => {
  const r = await rig({}, ADMIN);
  seed(r);
  addAccount(r.store.db, { runner: "claude", name: "t", kind: "token", ownerEmail: "alice@example.test", consent: false }, NOW);
  mkdirSync(join(r.home.accounts, "claude", "t"), { recursive: true });
  writeFileSync(join(r.home.accounts, "claude", "t", "token"), "sk-ant-oat01-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLD");
  setState(r.store.db, "claude/t", "dead", "401", NOW);
  mkdirSync(join(r.home.accounts, "pi", "alice-key"), { recursive: true });
  writeFileSync(join(r.home.accounts, "pi", "alice-key", "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "old-fake" } }));
  const alice = await signIn(r, "alice@example.test");
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  assert.equal((await api<ApiError>(r, admin, "PUT", "/api/accounts/claude/t/secret", { secret: FAKE_TOKEN })).status, 404, "not the admin's");
  const bad = await api<ApiError>(r, alice, "PUT", "/api/accounts/claude/t/secret", { secret: "has space" });
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(bad.body).includes("has space"));
  assert.equal((await api<ApiError>(r, alice, "PUT", "/api/accounts/claude/t/secret", { secret: "sk-ant-api03-notasetuptoken" })).status, 400, "a claude token must be a setup-token");
  const ok = await api<AccountView>(r, alice, "PUT", "/api/accounts/claude/t/secret", { secret: FAKE_TOKEN });
  assert.deepEqual([ok.status, ok.body.health, ok.body.sharing, ok.body.consentBy], [200, "ok", true, "alice@example.test"]);
  assert.equal(readFileSync(join(r.home.accounts, "claude", "t", "token"), "utf8"), FAKE_TOKEN);
  const key = await api<AccountView>(r, alice, "PUT", "/api/accounts/pi/alice-key/secret", { secret: FAKE_KEY });
  assert.equal(key.status, 200);
  assert.equal(JSON.parse(readFileSync(join(r.home.accounts, "pi", "alice-key", "auth.json"), "utf8")).zai.key, FAKE_KEY);
  assert.equal((await api<ApiError>(r, alice, "PUT", "/api/accounts/codex/alice/secret", { secret: FAKE_KEY })).status, 400, "a codex login takes no secret");
  assert.ok(!JSON.stringify([ok.body, key.body]).includes("FAKEFAKE") && !r.logs.join("\n").includes("FAKEFAKE"));
  await r.close();
});

test("startLogin: a codex login of any state but removed may log in again (the owner); a claude token account gets a setup-token sign-in that replaces its token", async () => {
  const f = fakeLogin();
  const pty = fakePty();
  const r = await rig({ login: { ...f.opts, pty: pty.pty } });
  seed(r);
  await withCatalog(r);
  addAccount(r.store.db, { runner: "claude", name: "t", kind: "token", ownerEmail: "alice@example.test" }, NOW);
  mkdirSync(join(r.home.accounts, "claude", "t"), { recursive: true });
  writeFileSync(join(r.home.accounts, "claude", "t", "token"), "sk-ant-oat01-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLD");
  putHealth(r.store.db, { ...emptyHealth("claude/t"), suspectSince: NOW.toISOString(), authFails: 1 });
  const alice = await signIn(r, "alice@example.test");
  const codex = await api<{ userCode: string }>(r, alice, "POST", "/api/accounts/codex/alice/login");
  assert.equal(codex.status, 200, "an active codex login may log in again now");
  const claude = await api<{ loginId: string; needsCode?: true }>(r, alice, "POST", "/api/accounts/claude/t/login");
  assert.deepEqual([claude.status, claude.body.needsCode], [200, true]);
  await api(r, alice, "POST", `/api/logins/${claude.body.loginId}/code`, { code: "PAGE-CODE" });
  await new Promise((ok) => setTimeout(ok, 400));
  const proc = pty.procs.at(-1)!;
  proc.say(`\r\n${SETUP_TOKEN}\r\n`);
  for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
  assert.deepEqual((await api(r, alice, "GET", `/api/logins/${claude.body.loginId}`)).body, { loginId: claude.body.loginId, state: "done" });
  assert.equal(readFileSync(join(r.home.accounts, "claude", "t", "token"), "utf8"), SETUP_TOKEN);
  const v = await api<AccountView>(r, alice, "GET", "/api/accounts/claude/t");
  assert.deepEqual([v.body.health, v.body.consentBy], ["ok", "alice@example.test"]);
  await r.close();
});

test("startConnect replace: a new token for the person's own claude token account, by the pair code; any other account is refused", async () => {
  const r = await rig();
  await withCatalog(r);
  seed(r);
  addAccount(r.store.db, { runner: "claude", name: "t", kind: "token", ownerEmail: "alice@example.test" }, NOW);
  mkdirSync(join(r.home.accounts, "claude", "t"), { recursive: true });
  writeFileSync(join(r.home.accounts, "claude", "t", "token"), "sk-ant-oat01-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLD");
  addAccount(r.store.db, { runner: "claude", name: "bobs", kind: "token", ownerEmail: "bob@example.test" }, NOW);
  const alice = await signIn(r, "alice@example.test");
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/connect", { runner: "claude", name: "bobs", replace: true })).status, 404);
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/connect", { runner: "claude", name: "new", replace: true })).status, 404);
  const start = await api<{ pairCode: string; connectId: string }>(r, alice, "POST", "/api/connect", { runner: "claude", name: "t", replace: true });
  assert.equal(start.status, 200);
  const sent = await fetch(`${r.base}/api/connect/${start.body.pairCode}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: SETUP_TOKEN }) });
  assert.equal(sent.status, 200);
  assert.equal(readFileSync(join(r.home.accounts, "claude", "t", "token"), "utf8"), SETUP_TOKEN);
  await r.close();
});

test("limitReset: the owner of a claude account only; a bad which is 400; the kill switch is 501", async () => {
  const r = await rig({}, { ...ADMIN, SQUAD_NO_LIMIT_RESET: "1" });
  seed(r);
  addAccount(r.store.db, { runner: "claude", name: "t", kind: "token", ownerEmail: "alice@example.test" }, NOW);
  const alice = await signIn(r, "alice@example.test");
  const admin = await signIn(r, "boss@example.test", ["squad-admins"]);
  assert.equal((await api<ApiError>(r, admin, "POST", "/api/accounts/claude/t/limit-reset", { which: "5-hour" })).status, 404);
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts/claude/t/limit-reset", { which: "all" })).status, 400);
  assert.equal((await api<ApiError>(r, alice, "POST", "/api/accounts/claude/t/limit-reset", { which: "5-hour" })).status, 501);
  await r.close();
});

test("every account care answer passes findForbidden", async () => {
  const r = await rig({ probe: okProbe([]) }, { SQUAD_PROBE_MODEL_PI: "zai/glm-fake" });
  seed(r);
  const c = await signIn(r, "alice@example.test");
  for (const [m, path, body] of [["GET", "/api/accounts/pi/alice-key/models", undefined], ["POST", "/api/accounts/pi/alice-key/test", {}], ["POST", "/api/accounts/pi/alice-key/reset", undefined], ["GET", "/api/accounts?all=1", undefined], ["DELETE", "/api/accounts/pi/alice-key", { confirm: "pi/alice-key" }]] as const) {
    const res = await api(r, c, m, path, body);
    assert.equal(res.status, 200, path);
    assert.equal(findForbidden(res.body), undefined, path);
  }
  await r.close();
});

test("behind the tunnel (a loopback peer) the wrong-code limit keys on cf-connecting-ip, so one bad client does not hold everyone", async () => {
  const r = await rig();
  await withCatalog(r);
  const alice = await signIn(r, "alice@example.test");
  const s = (await api<ConnectStart>(r, alice, "POST", "/api/connect", { runner: "claude", name: "c1" })).body;
  const post = (code: string, ip: string) => fetch(`${r.base}/api/connect/${code}/token`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ token: CONNECT_TOKEN }) });
  for (let i = 0; i < 30; i++) assert.equal((await post(`${"V".repeat(42)}${i}`, "203.0.113.7")).status, 404);
  assert.equal((await post("V".repeat(43), "203.0.113.7")).status, 429, "the bad client is held");
  assert.equal((await post(s.pairCode, "198.51.100.2")).status, 200, "another client behind the same tunnel is not");
  await r.close();
});

test("squad web serves none of squad serve's pass or conversation routes, even signed in and with a bearer token", async () => {
  const r = await rig();
  const c = await signIn(r, "alice@example.test");
  const bearer = { authorization: "Bearer sqd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  for (const [method, path] of [["POST", "/api/passes"], ["POST", "/api/conversations"], ["POST", "/api/conversations/x/turns"], ["DELETE", "/api/conversations/x"]] as const) {
    const res = await api<ApiError>(r, c, method, path, method === "DELETE" ? undefined : {}, bearer);
    assert.ok(res.status === 404 || res.status === 405, `${method} ${path} -> ${res.status}`);
  }
  await r.close();
});

// The embed ticket route. The server reads opts.now for tickets, so a test moves the clock.
const EMBED_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const EMBED_SECRET = `embed_key = "${EMBED_KEY}"\n`;
const SAME = { "sec-fetch-site": "same-site" };
interface EmbedRig extends Rig { clock: { ms: number }; ticket: (over?: Record<string, unknown>, key?: Buffer) => string; get: (ticket: string, to?: string, headers?: Record<string, string>) => Promise<Response> }
/** A server whose clock starts at NOW and then moves 10 s on, past the 6 s after a start when every ticket is refused. */
async function embedRig(env: Record<string, string> = {}): Promise<EmbedRig> {
  const clock = { ms: NOW.getTime() };
  const r = await rig({ now: () => new Date(clock.ms) }, env, EMBED_SECRET);
  clock.ms += 10_000;
  const ticket = (over: Record<string, unknown> = {}, key: Buffer = Buffer.from(EMBED_KEY, "hex")): string => {
    const iat = Math.floor(clock.ms / 1000);
    const p = { v: 1, aud: PUBLIC, email: "ada@example.test", name: "Ada", groups: ["squad"], iat, exp: iat + 30, jti: randomBytes(16).toString("base64url"), ...over };
    const b = Buffer.from(JSON.stringify(p)).toString("base64url");
    return `${b}.${createHmac("sha256", key).update(b).digest("base64url")}`;
  };
  const get = (t: string, to?: string, headers: Record<string, string> = SAME): Promise<Response> =>
    fetch(`${r.base}/auth/embed?ticket=${t}${to === undefined ? "" : `&to=${encodeURIComponent(to)}`}`, { redirect: "manual", headers });
  return Object.assign(r, { clock, ticket, get });
}

test("/auth/embed is a plain 404 when there is no embed key", async () => {
  const r = await rig();
  const res = await fetch(`${r.base}/auth/embed?ticket=x`, { redirect: "manual", headers: SAME });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "not found\n");
  const unknown = await fetch(`${r.base}/auth/nothing`);
  assert.equal(await unknown.text(), "not found\n");
  assert.equal((await fetch(`${r.base}/auth/embed`, { method: "POST" })).status, 404, "off for every method");
  assert.equal(res.headers.get("set-cookie"), null);
  await r.close();
});

test("a good ticket from the same site makes a session; later /api calls see it; the target goes through safeReturnPath", async () => {
  const r = await embedRig();
  const res = await r.get(r.ticket(), "/accounts/pi/dev?x=1");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/accounts/pi/dev?x=1");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const set = res.headers.getSetCookie();
  assert.equal(set.length, 1);
  assert.match(set[0]!, /^squad_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200$/);
  const me = await api<Me>(r, set[0]!.split(";")[0]!, "GET", "/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.email, "ada@example.test");
  assert.equal(me.body.name, "Ada");
  for (const [to, want] of [["//evil.com", "/"], ["https://evil.com", "/"], ["/auth/login", "/"], ["/./auth/embed?ticket=y", "/"], [undefined, "/"]] as const) {
    const back = await r.get(r.ticket(), to);
    assert.equal(back.headers.get("location"), want);
    assert.equal(back.headers.getSetCookie().length, 1);
  }
  assert.ok(!r.logs.some((l) => /evil|accounts\/pi/.test(l)), "the target is never logged");
  await r.close();
});

test("same-origin is also allowed; cross-site, none and a missing header are refused with no cookie, and the frame still lands on the page", async () => {
  const r = await embedRig();
  assert.equal((await r.get(r.ticket(), "/", { "sec-fetch-site": "same-origin" })).headers.getSetCookie().length, 1);
  for (const h of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" }, { "sec-fetch-site": "" }, {}] as Record<string, string>[]) {
    const res = await r.get(r.ticket(), "/accounts", h);
    assert.equal(res.status, 302, JSON.stringify(h));
    assert.equal(res.headers.get("location"), "/accounts");
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  }
  assert.ok(r.logs.some((l) => /event=embed_refused/.test(l) && /reason=fetch-site/.test(l)));
  await r.close();
});

test("a refused ticket logs only its reason and sets no cookie; a used ticket cannot run twice", async () => {
  const r = await embedRig();
  const t = r.ticket();
  assert.equal((await r.get(t)).headers.getSetCookie().length, 1);
  const again = await r.get(t, "/x");
  assert.equal(again.status, 302);
  assert.equal(again.headers.get("location"), "/x");
  assert.equal(again.headers.getSetCookie().length, 0);
  assert.ok(r.logs.some((l) => /event=embed_refused/.test(l) && /reason=reused/.test(l)));
  const startS = Math.floor(NOW.getTime() / 1000);
  for (const bad of [r.ticket({}, Buffer.alloc(32, 1)), r.ticket({ aud: "https://other.example.test" }), r.ticket({ iat: startS + 5 }), "garbage", "", "a".repeat(8193)]) {
    const res = await r.get(bad);
    assert.equal(res.status, 302);
    assert.equal(res.headers.getSetCookie().length, 0);
  }
  assert.ok(r.logs.some((l) => /reason=bad-mac/.test(l)) && r.logs.some((l) => /reason=bad-aud/.test(l)) && r.logs.some((l) => /reason=before-start/.test(l)) && r.logs.some((l) => /reason=bad-shape/.test(l)) && r.logs.some((l) => /reason=too-long/.test(l)));
  const none = await fetch(`${r.base}/auth/embed`, { redirect: "manual", headers: SAME });
  assert.equal(none.headers.getSetCookie().length, 0, "no ticket at all");
  await r.close();
});

test("a ticket made in the first seconds after the start is refused", async () => {
  const clock = { ms: NOW.getTime() };
  const r = await rig({ now: () => new Date(clock.ms) }, {}, EMBED_SECRET);
  const mk = (): string => {
    const iat = Math.floor(clock.ms / 1000);
    const b = Buffer.from(JSON.stringify({ v: 1, aud: PUBLIC, email: "ada@example.test", name: "Ada", groups: [], iat, exp: iat + 30, jti: randomBytes(16).toString("base64url") })).toString("base64url");
    return `${b}.${createHmac("sha256", Buffer.from(EMBED_KEY, "hex")).update(b).digest("base64url")}`;
  };
  const go = (): Promise<Response> => fetch(`${r.base}/auth/embed?ticket=${mk()}`, { redirect: "manual", headers: SAME });
  assert.equal((await go()).headers.getSetCookie().length, 0);
  clock.ms += 6000;
  assert.equal((await go()).headers.getSetCookie().length, 1);
  await r.close();
});

test("a ticket's groups are cut to the admin group, so the cookie stays small", async () => {
  // 80 groups is about the most a ticket can hold (8 KB); kept whole they would still pass 4 KB in the cookie.
  const many = Array.from({ length: 80 }, (_, i) => `team-${String(i).padStart(3, "0")}-${"x".repeat(50)}`);
  const r = await embedRig({ SQUAD_OIDC_GROUP: "squad", ...ADMIN });
  const admin = await r.get(r.ticket({ groups: [...many, "squad", "squad-admins"] }));
  const set = admin.headers.getSetCookie();
  assert.equal(set.length, 1);
  assert.ok(set[0]!.length < 4096, `cookie line is ${set[0]!.length} bytes`);
  assert.equal((await api<Me>(r, set[0]!.split(";")[0]!, "GET", "/api/me")).body.admin, true);
  const member = await r.get(r.ticket({ groups: [...many, "squad"] }));
  assert.equal((await api<Me>(r, member.headers.getSetCookie()[0]!.split(";")[0]!, "GET", "/api/me")).body.admin, false);
  assert.equal((await r.get(r.ticket({ groups: [...many, "squad-admins"] }))).headers.getSetCookie().length, 0, "the sign-in group is still needed");
  await r.close();
});

test("a ticket is refused when the person is not in SQUAD_OIDC_GROUP", async () => {
  const r = await embedRig({ SQUAD_OIDC_GROUP: "squad" });
  assert.equal((await r.get(r.ticket({ groups: ["other"] }))).headers.getSetCookie().length, 0);
  assert.ok(r.logs.some((l) => /reason=not-in-group/.test(l)));
  assert.equal((await r.get(r.ticket({ groups: ["squad"] }))).headers.getSetCookie().length, 1);
  await r.close();
});

test("/auth/embed answers GET only, with the same no-store and no-referrer headers", async () => {
  const r = await embedRig();
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await fetch(`${r.base}/auth/embed?ticket=${r.ticket()}`, { method, headers: SAME, redirect: "manual" });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.getSetCookie().length, 0);
  }
  await r.close();
});

test("a ticket never shows up in the log, whether it worked or not", async () => {
  const r = await embedRig();
  const good = r.ticket();
  const bad = r.ticket({ v: 2 });
  await r.get(good, "/a");
  await r.get(bad, "/a");
  const all = r.logs.join("\n");
  assert.ok(/event=access/.test(all) && /route=auth\/embed/.test(all) && /status=302/.test(all));
  for (const t of [good, bad]) {
    assert.ok(!all.includes(t) && !all.includes(t.split(".")[0]!) && !all.includes(t.split(".")[1]!), "no ticket text");
  }
  assert.ok(!all.includes("ada@example.test"), "no claim");
  assert.ok(!/ticket=/.test(all), "no query");
  await r.close();
});
