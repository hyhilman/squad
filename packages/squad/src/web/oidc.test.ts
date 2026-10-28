import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { CLIENT_ID, hs256, jwt, makeKey, signWith, startFakeOidc, type FakeOidc } from "../../test/fake-oidc.ts";
import { createOidc, OidcError, safeReturnPath, type OidcConfig } from "./oidc.ts";

let p: FakeOidc;
let pEc: FakeOidc;
before(async () => {
  p = await startFakeOidc("RS256");
  pEc = await startFakeOidc("ES256");
});
after(async () => {
  await p.close();
  await pEc.close();
});

const cfgOf = (prov: FakeOidc, extra: Partial<OidcConfig> = {}): OidcConfig => ({
  url: "http://127.0.0.1:3000", issuer: prov.issuer, clientId: CLIENT_ID, sessionKey: randomBytes(32), secure: false, ...extra,
});

/** The cookie header a browser would send back for one Set-Cookie line. */
const cookieOf = (setCookie: string): string => setCookie.split(";")[0]!;

/** Runs the whole redirect dance against the fake provider; returns the callback result. */
async function signIn(prov: FakeOidc, oidc = createOidc(cfgOf(prov)), tweak?: (q: URLSearchParams) => void) {
  prov.tokenRequests.length = 0;
  const start = await oidc.startLogin();
  const auth = await fetch(start.location, { redirect: "manual" });
  const back = new URL(auth.headers.get("location")!);
  tweak?.(back.searchParams);
  const res = await oidc.finishLogin(back.searchParams, cookieOf(start.setCookie));
  return { oidc, start, res };
}

const reset = (prov: FakeOidc): void => {
  prov.mutate = () => {};
  prov.forge = undefined;
  prov.tokenStatus = 200;
  prov.discoveryIssuer = undefined;
  prov.jwks = [prov.jwks[0]!];
  prov.signer = prov.jwks[0]!;
};

test("happy path: PKCE S256, a session with only email, name, groups and exp", async () => {
  reset(p);
  const { oidc, start, res } = await signIn(p);
  const loc = new URL(start.location);
  assert.equal(loc.origin + loc.pathname, `${p.issuer}/authorize`);
  assert.equal(loc.searchParams.get("response_type"), "code");
  assert.equal(loc.searchParams.get("scope"), "openid email profile groups");
  assert.equal(loc.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/auth/callback");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.equal(loc.searchParams.get("client_id"), CLIENT_ID);
  assert.ok(res.ok);
  assert.deepEqual(Object.keys(res.session).sort(), ["email", "exp", "groups", "name"]);
  assert.equal(res.session.email, "alice@example.test");
  assert.deepEqual(res.session.groups, [], "no admin group set: the session keeps no groups");
  const tr = p.tokenRequests[0]!;
  assert.equal(tr.pkceOk, true);
  const v = tr.form.get("code_verifier")!;
  assert.ok(v.length >= 43 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v));
  assert.equal(tr.auth, undefined, "a public client sends no secret");
  const session = res.setCookies.find((c) => c.startsWith("squad_session="))!;
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /Path=\//);
  assert.match(session, /Max-Age=43200/);
  assert.doesNotMatch(session, /Secure/);
  assert.ok(res.setCookies.some((c) => c.startsWith("squad_oidc=;") && /Max-Age=0/.test(c)), "the login cookie is cleared");
  assert.equal(oidc.readSession(cookieOf(session))?.email, "alice@example.test");
  assert.ok(!session.includes("fake-access"));
});

test("the login cookie is httpOnly, Lax, Path=/auth, 10 minutes; Secure only for an https web URL", async () => {
  reset(p);
  const plain = await createOidc(cfgOf(p)).startLogin();
  assert.match(plain.setCookie, /^squad_oidc=/);
  for (const a of ["HttpOnly", "SameSite=Lax", "Path=/auth", "Max-Age=600"]) assert.ok(plain.setCookie.includes(a), a);
  assert.doesNotMatch(plain.setCookie, /Secure/);
  const https = await createOidc(cfgOf(p, { url: "https://squad.example.test", secure: true })).startLogin();
  assert.match(https.setCookie, /; Secure/);
  assert.equal(new URL(https.location).searchParams.get("redirect_uri"), "https://squad.example.test/auth/callback");
});

test("the ES256 provider works too", async () => {
  reset(pEc);
  const { res } = await signIn(pEc);
  assert.ok(res.ok);
});

test("a client secret goes in client_secret_basic, not the body", async () => {
  reset(p);
  const { res } = await signIn(p, createOidc(cfgOf(p, { clientSecret: "s3/cret+" })));
  assert.ok(res.ok);
  const tr = p.tokenRequests[0]!;
  assert.equal(tr.auth, `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent("s3/cret+")}`).toString("base64")}`);
  assert.equal(tr.form.get("client_secret"), null);
});

const refused = async (prov: FakeOidc, reason: string, oidc?: ReturnType<typeof createOidc>, tweak?: (q: URLSearchParams) => void): Promise<void> => {
  const { res } = await signIn(prov, oidc, tweak);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, reason);
};

test("a wrong state is refused before the code is used", async () => {
  reset(p);
  await refused(p, "state-mismatch", undefined, (q) => q.set("state", "x".repeat(43)));
  assert.equal(p.tokenRequests.length, 0);
});

test("no login cookie, or a tampered one, is refused", async () => {
  reset(p);
  const oidc = createOidc(cfgOf(p));
  const start = await oidc.startLogin();
  const auth = await fetch(start.location, { redirect: "manual" });
  const q = new URL(auth.headers.get("location")!).searchParams;
  assert.deepEqual(await oidc.finishLogin(q, undefined), { ok: false, reason: "no-login-cookie", setCookies: [expiredLogin] });
  const c = cookieOf(start.setCookie);
  const bad = `${c.slice(0, -2)}${c.endsWith("AA") ? "BB" : "AA"}`;
  const r = await oidc.finishLogin(q, bad);
  assert.equal(r.ok, false);
});
const expiredLogin = "squad_oidc=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0";

test("a login cookie older than 10 minutes is refused", async () => {
  reset(p);
  let t = Date.now();
  const oidc = createOidc(cfgOf(p), { now: () => t });
  const start = await oidc.startLogin();
  const q = new URL((await fetch(start.location, { redirect: "manual" })).headers.get("location")!).searchParams;
  t += 11 * 60_000;
  const r = await oidc.finishLogin(q, cookieOf(start.setCookie));
  assert.equal(r.ok === false && r.reason, "no-login-cookie");
});

test("a provider error in the callback is refused", async () => {
  reset(p);
  const oidc = createOidc(cfgOf(p));
  const start = await oidc.startLogin();
  const r = await oidc.finishLogin(new URLSearchParams({ error: "access_denied" }), cookieOf(start.setCookie));
  assert.equal(r.ok === false && r.reason, "provider-error");
});

test("a bad signature is refused", async () => {
  reset(p);
  const other = makeKey("RS256", "k1");
  p.forge = (claims) => jwt({ alg: "RS256", kid: "k1" }, claims, signWith(other));
  await refused(p, "bad-id-token");
});

test("a wrong issuer is refused", async () => {
  reset(p);
  p.mutate = (c) => { c.iss = "https://evil.example.test"; };
  await refused(p, "bad-id-token");
});

test("a wrong audience is refused; several audiences need azp", async () => {
  reset(p);
  p.mutate = (c) => { c.aud = "someone-else"; };
  await refused(p, "bad-id-token");
  p.mutate = (c) => { c.aud = [CLIENT_ID, "other"]; };
  await refused(p, "bad-id-token");
  p.mutate = (c) => { c.aud = [CLIENT_ID, "other"]; c.azp = CLIENT_ID; };
  assert.ok((await signIn(p)).res.ok);
  p.mutate = (c) => { c.aud = [CLIENT_ID, "other"]; c.azp = "other"; };
  await refused(p, "bad-id-token");
});

test("an expired token is refused", async () => {
  reset(p);
  p.mutate = (c) => { c.exp = Math.floor(Date.now() / 1000) - 5; };
  await refused(p, "bad-id-token");
});

test("an iat in the future is refused, a small skew is not", async () => {
  reset(p);
  p.mutate = (c) => { c.iat = Math.floor(Date.now() / 1000) + 3600; };
  await refused(p, "bad-id-token");
  p.mutate = (c) => { c.iat = Math.floor(Date.now() / 1000) + 30; };
  assert.ok((await signIn(p)).res.ok);
});

test("a nonce mismatch is refused", async () => {
  reset(p);
  p.mutate = (c) => { c.nonce = "not-mine"; };
  await refused(p, "bad-id-token");
});

test("an unverified email, or none, is refused", async () => {
  reset(p);
  p.mutate = (c) => { c.email_verified = false; };
  await refused(p, "email-unverified");
  p.mutate = (c) => { c.email_verified = "true"; };
  await refused(p, "email-unverified");
  p.mutate = (c) => { delete c.email; };
  await refused(p, "email-unverified");
});

test("a required group must be in groups; no group setting lets any user in", async () => {
  reset(p);
  const need = createOidc(cfgOf(p, { group: "squad-admins" }));
  await refused(p, "not-in-group", need);
  p.mutate = (c) => { c.groups = ["squad-admins"]; };
  assert.ok((await signIn(p, createOidc(cfgOf(p, { group: "squad-admins" })))).res.ok);
  p.mutate = (c) => { delete c.groups; };
  assert.ok((await signIn(p)).res.ok);
  await refused(p, "not-in-group", createOidc(cfgOf(p, { group: "squad-admins" })));
});

const manyGroups = (): string[] => Array.from({ length: 500 }, (_, i) => `team-${String(i).padStart(3, "0")}-${"x".repeat(60)}`);

test("a person with 500 long groups still gets a session cookie that fits 4 KB, and is admin", async () => {
  reset(p);
  p.mutate = (c) => { c.groups = [...manyGroups(), "squad-admins"]; };
  const { oidc, res } = await signIn(p, createOidc(cfgOf(p, { adminGroup: "squad-admins" })));
  assert.ok(res.ok);
  assert.deepEqual(res.session.groups, ["squad-admins"]);
  const set = res.setCookies.find((c) => c.startsWith("squad_session="))!;
  assert.ok(set.length < 4096, `cookie line is ${set.length} bytes`);
  const read = oidc.readSession(cookieOf(set));
  assert.deepEqual(read?.groups, ["squad-admins"]);
});

test("with no admin group set the session holds no groups, however many the person has", async () => {
  reset(p);
  p.mutate = (c) => { c.groups = [...manyGroups(), "squad-admins"]; };
  const { oidc, res } = await signIn(p);
  assert.ok(res.ok);
  assert.deepEqual(res.session.groups, []);
  const set = res.setCookies.find((c) => c.startsWith("squad_session="))!;
  assert.ok(set.length < 4096);
  assert.deepEqual(oidc.readSession(cookieOf(set))?.groups, []);
});

test("the sign-in group is checked on the full list; a member who is not admin gets a session without groups", async () => {
  reset(p);
  const cfg = { group: "squad", adminGroup: "squad-admins" };
  p.mutate = (c) => { c.groups = [...manyGroups(), "squad"]; };
  const member = await signIn(p, createOidc(cfgOf(p, cfg)));
  assert.ok(member.res.ok);
  assert.deepEqual(member.res.session.groups, []);
  p.mutate = (c) => { c.groups = [...manyGroups(), "squad", "squad-admins"]; };
  const admin = await signIn(p, createOidc(cfgOf(p, cfg)));
  assert.ok(admin.res.ok);
  assert.deepEqual(admin.res.session.groups, ["squad-admins"]);
  p.mutate = (c) => { c.groups = [...manyGroups(), "squad-admins"]; };
  await refused(p, "not-in-group", createOidc(cfgOf(p, cfg)));
});

test("an unknown kid makes one JWKS refetch; a rotated key then works, an unknown one is refused", async () => {
  reset(p);
  const oidc = createOidc(cfgOf(p));
  assert.ok((await signIn(p, oidc)).res.ok);
  const before = p.jwksFetches;
  assert.ok((await signIn(p, oidc)).res.ok);
  assert.equal(p.jwksFetches, before, "a known kid uses the cache");
  const k2 = makeKey("RS256", "k2");
  p.jwks = [...p.jwks, k2];
  p.signer = k2;
  assert.ok((await signIn(p, oidc)).res.ok);
  assert.equal(p.jwksFetches, before + 1);
  p.signer = makeKey("RS256", "ghost");
  await refused(p, "bad-id-token", oidc);
  assert.equal(p.jwksFetches, before + 2, "one refetch, no more");
});

test("alg none and HS256 are refused", async () => {
  reset(p);
  p.forge = (claims) => jwt({ alg: "none", kid: "k1" }, claims, () => Buffer.alloc(0));
  await refused(p, "bad-id-token");
  p.forge = (claims) => hs256(claims, JSON.stringify(p.jwks[0]!.jwk));
  await refused(p, "bad-id-token");
  p.forge = (claims) => jwt({ alg: "HS256", kid: "k1" }, claims, () => Buffer.from("x"));
  await refused(p, "bad-id-token");
});

test("a token endpoint error is refused", async () => {
  reset(p);
  p.tokenStatus = 500;
  await refused(p, "token-endpoint");
  p.tokenStatus = 400;
  await refused(p, "token-endpoint");
});

test("a discovery document with another issuer is refused", async () => {
  reset(p);
  p.discoveryIssuer = "https://evil.example.test";
  await assert.rejects(createOidc(cfgOf(p)).startLogin(), /issuer/);
  reset(p);
});

test("a session cookie from another key, or past its exp, is no session", async () => {
  reset(p);
  let t = Date.now();
  const a = createOidc(cfgOf(p), { now: () => t });
  const { res } = await signIn(p, a);
  assert.ok(res.ok);
  const c = cookieOf(res.setCookies.find((x) => x.startsWith("squad_session="))!);
  assert.ok(a.readSession(c));
  assert.equal(createOidc(cfgOf(p)).readSession(c), undefined, "another session key");
  assert.equal(a.readSession(`other=1; ${c}; x=2`)?.email, "alice@example.test", "found among other cookies");
  assert.equal(a.readSession(undefined), undefined);
  t += 13 * 3600_000;
  assert.equal(a.readSession(c), undefined, "past 12 h");
  assert.match(a.clearSessionCookie(), /^squad_session=; .*Max-Age=0/);
});

test("safeReturnPath keeps a same-origin path and sends everything else to /", () => {
  const bad = ["//evil.com", "/\\evil.com", "\\evil.com", "https://evil.com", "javascript:alert(1)", "/auth/login", "/auth", "/auth/callback?x=1", "%2F%2Fevil.com", "/%2Fevil.com", "/%5Cevil.com", "/a\\b", "/a\nb", "/a\u0000b", "/a\u007fb", "/日本", "/caf\u00e9", "/a b", "", "accounts", undefined, null, "/" + "a".repeat(2100)];
  for (const raw of bad) assert.equal(safeReturnPath(raw), "/", JSON.stringify(raw));
  assert.equal(safeReturnPath("/accounts/pi/dev?x=1"), "/accounts/pi/dev?x=1");
  assert.equal(safeReturnPath("/"), "/");
  assert.equal(safeReturnPath("/authors"), "/authors");
});

test("the return path rides in the sealed login cookie and comes back from finishLogin", async () => {
  reset(p);
  const oidc = createOidc(cfgOf(p));
  const start = await oidc.startLogin("/accounts/pi/dev?x=1");
  assert.ok(!start.setCookie.includes("accounts"), "sealed, not plain");
  assert.ok(!start.location.includes("accounts"), "not sent to the provider");
  const auth = await fetch(start.location, { redirect: "manual" });
  const back = new URL(auth.headers.get("location")!);
  const res = await oidc.finishLogin(back.searchParams, cookieOf(start.setCookie));
  assert.ok(res.ok);
  assert.equal(res.ok && res.to, "/accounts/pi/dev?x=1");
  const evil = await oidc.startLogin("//evil.com");
  const a2 = await fetch(evil.location, { redirect: "manual" });
  const r2 = await oidc.finishLogin(new URL(a2.headers.get("location")!).searchParams, cookieOf(evil.setCookie));
  assert.equal(r2.ok && r2.to, "/");
  const none = await signIn(p);
  assert.equal(none.res.ok && none.res.to, "/");
});

test("a discovery or jwks failure carries a fixed reason code", async () => {
  reset(p);
  p.discoveryIssuer = "https://evil.example.test";
  await assert.rejects(createOidc(cfgOf(p)).startLogin(), (e: unknown) => e instanceof OidcError && e.reason === "issuer-mismatch");
  reset(p);
  const down = createOidc(cfgOf(p), { fetch: async () => { throw new Error("connect ECONNREFUSED http://secret.internal/x"); } });
  await assert.rejects(down.startLogin(), (e: unknown) => e instanceof OidcError && e.reason === "network" && !/secret/.test(e.message));
  const http = createOidc(cfgOf(p), { fetch: async () => new Response("{}", { status: 503 }) });
  await assert.rejects(http.startLogin(), (e: unknown) => e instanceof OidcError && e.reason === "discovery-http" && e.status === 503);
  const partial = createOidc(cfgOf(p), { fetch: async () => new Response(JSON.stringify({ issuer: p.issuer }), { status: 200 }) });
  await assert.rejects(partial.startLogin(), (e: unknown) => e instanceof OidcError && e.reason === "discovery-incomplete");
});

test("startSession gives the same session and cookie as a sign-in; an empty name falls back to the email", () => {
  let nowMs = 1_800_000_000_000;
  const oidc = createOidc(cfgOf(p, { secure: true, adminGroup: "dev" }), { now: () => nowMs });
  const { session, setCookie } = oidc.startSession({ email: "ada@example.test", name: "", groups: ["dev", "other"] });
  assert.deepEqual(session, { email: "ada@example.test", name: "ada@example.test", groups: ["dev"], exp: 1_800_000_000 + 12 * 3600 });
  assert.match(setCookie, /^squad_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200; Secure$/);
  assert.deepEqual(oidc.readSession(cookieOf(setCookie)), session);
  nowMs += 13 * 3600_000;
  assert.equal(oidc.readSession(cookieOf(setCookie)), undefined);
});
