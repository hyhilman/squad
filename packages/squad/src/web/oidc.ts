// OIDC sign-in: code flow with PKCE, no library. This file never keeps the access, refresh or ID
// token. It checks the ID token once, then the session holds only the email, name, the admin group (if any) and expiry.
// An error from here carries a fixed reason word, never a token, a code or a claim.
import { createHash, createPublicKey, timingSafeEqual, verify, randomBytes, type KeyObject } from "node:crypto";
import { deriveKey, seal, unseal } from "./seal.ts";

export interface OidcConfig {
  /** The public base URL of the web app, no trailing slash: the default for a sign-in that names none. */
  readonly url: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly group?: string;
  /** The one group the session keeps, when the person has it. */
  readonly adminGroup?: string;
  readonly clientSecret?: string;
  readonly sessionKey: Buffer;
  readonly secure: boolean;
}

export interface Session {
  readonly email: string;
  readonly name: string;
  readonly groups: readonly string[];
  /** Epoch seconds. */
  readonly exp: number;
}

export type FailReason = "no-login-cookie" | "provider-error" | "state-mismatch" | "token-endpoint" | "bad-id-token" | "email-unverified" | "not-in-group";

/** Why discovery or the key fetch failed. A fixed word, so a log line can carry it. */
export type SetupReason = "network" | "discovery-http" | "issuer-mismatch" | "discovery-incomplete" | "jwks-failed";

/** The message is fixed too: it never holds a URL, a body or the text of the cause. */
export class OidcError extends Error {
  readonly reason: SetupReason;
  readonly status: number | undefined;
  constructor(reason: SetupReason, status?: number) {
    super(
      reason === "issuer-mismatch" ? "oidc discovery issuer does not match SQUAD_OIDC_ISSUER"
      : reason === "discovery-incomplete" ? "oidc discovery document is incomplete"
      : reason === "discovery-http" ? "oidc discovery failed"
      : reason === "jwks-failed" ? "jwks fetch failed"
      : "oidc provider unreachable",
    );
    this.reason = reason;
    this.status = status;
  }
}

const MAX_TO = 2048;
/** A same-origin path to come back to after sign-in, or "/". Stops open redirects (a `to` that leaves the site). */
export function safeReturnPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length > MAX_TO || !plainPath(raw)) return "/";
  // The browser removes dot segments (`.`, `..`, and `%2e` in any case) before it asks the server, so
  // "/./auth/embed" lands on /auth/embed. Check where it lands, and send the browser exactly there.
  let url: URL;
  try {
    url = new URL(raw, "https://squad.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "https://squad.invalid" || underAuth(url.pathname)) return "/";
  // A proxy in front may decode the path (and fold its case) before squad sees it, so "/%61uth/embed"
  // or "/x%2f..%2fauth" would reach /auth there. Check the decoded form too.
  let decoded: URL;
  try {
    decoded = new URL(decodeURIComponent(url.pathname), "https://squad.invalid");
  } catch {
    return "/";
  }
  if (decoded.origin !== "https://squad.invalid" || underAuth(decoded.pathname)) return "/";
  // The resolved path is checked again: "/a/..//evil.com" resolves to "//evil.com", which leaves the site.
  const resolved = url.pathname + url.search + url.hash;
  return resolved.length <= MAX_TO && plainPath(resolved) ? resolved : "/";
}

const underAuth = (path: string): boolean => /^\/auth(\/|;|$)/i.test(path);

function plainPath(raw: string): boolean {
  if (raw.length === 0 || raw[0] !== "/" || raw[1] === "/" || raw[1] === "\\") return false;
  // Printable ASCII only: the browser sends its path percent-encoded, and Node throws on a
  // Location header with a character above 0xff.
  if (/[^\x21-\x7e]|\\/.test(raw)) return false;
  if (/^\/(%2f|%5c)/i.test(raw)) return false;
  return !(raw === "/auth" || raw.startsWith("/auth/") || raw.startsWith("/auth?"));
}

export type FinishResult =
  | { readonly ok: true; readonly session: Session; readonly to: string; readonly setCookies: readonly string[] }
  | { readonly ok: false; readonly reason: FailReason; readonly setCookies: readonly string[] };

export interface OidcDeps {
  readonly fetch?: typeof globalThis.fetch;
  /** Epoch milliseconds. */
  readonly now?: () => number;
}

export const SESSION_COOKIE = "squad_session";
export const LOGIN_COOKIE = "squad_oidc";
const LOGIN_TTL_S = 600;
const SESSION_TTL_S = 12 * 3600;
const MAX_NAME = 200;
const DOC_TTL_MS = 3600_000;
const SKEW_S = 60;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_JSON = 1_000_000;

interface Doc {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  /** RP-initiated logout; a provider may have none. */
  readonly end_session_endpoint?: string;
}
type Jwk = Record<string, unknown>;
type Claims = Record<string, unknown>;

const b64u = (n: number): string => randomBytes(n).toString("base64url");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Compares in constant time: both sides are hashed first, so the lengths match. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function cookies(header: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}

export function createOidc(cfg: OidcConfig, deps: OidcDeps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const loginKey = deriveKey(cfg.sessionKey, "login");
  const sessionKey = deriveKey(cfg.sessionKey, "session");
  const redirectUri = (origin: string): string => `${origin}/auth/callback`;

  const cookie = (name: string, value: string, path: string, maxAge: number): string =>
    `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${cfg.secure ? "; Secure" : ""}`;
  const clearLogin = (): string => cookie(LOGIN_COOKIE, "", "/auth", 0);

  async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      text = await res.text();
    } catch {
      throw new OidcError("network"); // the cause text can hold a URL
    }
    let body: unknown;
    try {
      body = text.length > MAX_JSON ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }

  let doc: { value: Doc; at: number } | undefined;
  async function discovery(): Promise<Doc> {
    if (doc !== undefined && now() - doc.at < DOC_TTL_MS) return doc.value;
    const { status, body } = await getJson(`${cfg.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (status !== 200) throw new OidcError("discovery-http", status);
    if (!isObj(body)) throw new OidcError("discovery-incomplete");
    if (body.issuer !== cfg.issuer) throw new OidcError("issuer-mismatch");
    const { authorization_endpoint, token_endpoint, jwks_uri } = body;
    if (!isStr(authorization_endpoint) || !isStr(token_endpoint) || !isStr(jwks_uri)) throw new OidcError("discovery-incomplete");
    const end = body.end_session_endpoint;
    const endOk = isStr(end) && URL.canParse(end) && ["https:", "http:"].includes(new URL(end).protocol);
    doc = { value: { authorization_endpoint, token_endpoint, jwks_uri, ...(endOk ? { end_session_endpoint: end } : {}) }, at: now() };
    return doc.value;
  }

  let jwks: Jwk[] | undefined;
  async function keys(refetch: boolean): Promise<Jwk[]> {
    if (jwks !== undefined && !refetch) return jwks;
    const { status, body } = await getJson((await discovery()).jwks_uri);
    if (status !== 200 || !isObj(body) || !Array.isArray(body.keys)) throw new OidcError("jwks-failed", status);
    jwks = body.keys.filter(isObj);
    return jwks;
  }

  /** The keys that may have signed a token with this header. */
  function candidates(all: readonly Jwk[], alg: "RS256" | "ES256", kid: unknown): KeyObject[] {
    const out: KeyObject[] = [];
    for (const jwk of all) {
      if (kid !== undefined && jwk.kid !== kid) continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      if (jwk.alg !== undefined && jwk.alg !== alg) continue;
      if (jwk.kty !== (alg === "RS256" ? "RSA" : "EC") || (alg === "ES256" && jwk.crv !== "P-256")) continue;
      try {
        const key = createPublicKey({ key: jwk as never, format: "jwk" });
        if (alg === "RS256" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
        out.push(key);
      } catch {
        // a key we cannot read is not a candidate
      }
    }
    // A token with no kid is only accepted when one key could have signed it.
    return kid === undefined && out.length !== 1 ? [] : out;
  }

  /** The claims of a token whose signature, issuer, audience, times and nonce all check. Throws otherwise. */
  async function verifyIdToken(token: string, nonce: string): Promise<Claims> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new Error("malformed");
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (!isObj(header) || (header.alg !== "RS256" && header.alg !== "ES256")) throw new Error("alg");
    const alg = header.alg;
    const input = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2]!, "base64url");
    const good = (list: readonly KeyObject[]): boolean =>
      list.some((k) => (alg === "RS256" ? verify("sha256", input, k, sig) : sig.length === 64 && verify("sha256", input, { key: k, dsaEncoding: "ieee-p1363" }, sig)));
    let ok = good(candidates(await keys(false), alg, header.kid));
    if (!ok && header.kid !== undefined) ok = good(candidates(await keys(true), alg, header.kid));
    if (!ok) throw new Error("signature");
    const c: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!isObj(c)) throw new Error("claims");
    const nowS = Math.floor(now() / 1000);
    if (c.iss !== cfg.issuer) throw new Error("iss");
    const aud = c.aud;
    if (!(aud === cfg.clientId || (Array.isArray(aud) && aud.includes(cfg.clientId)))) throw new Error("aud");
    if (Array.isArray(aud) && aud.length > 1 && c.azp !== cfg.clientId) throw new Error("azp");
    if (typeof c.exp !== "number" || c.exp <= nowS) throw new Error("exp");
    if (typeof c.iat !== "number" || c.iat > nowS + SKEW_S) throw new Error("iat");
    if (!isStr(c.nonce) || !sameSecret(c.nonce, nonce)) throw new Error("nonce");
    return c;
  }

  /**
   * An empty name falls back to the email. The session keeps only the admin group, never the whole
   * list: a browser drops a cookie over 4 KB, so a person with many groups would land signed out.
   */
  function startSession(who: { readonly email: string; readonly name: string; readonly groups: readonly string[] }): { session: Session; setCookie: string } {
    const groups = cfg.adminGroup !== undefined && who.groups.includes(cfg.adminGroup) ? [cfg.adminGroup] : [];
    // The name is only shown, so it is cut by code point rather than refused; a long one would push
    // the cookie past the browser's limit too.
    const name = Array.from(who.name === "" ? who.email : who.name).slice(0, MAX_NAME).join("");
    const session: Session = { email: who.email, name, groups, exp: Math.floor(now() / 1000) + SESSION_TTL_S };
    return { session, setCookie: cookie(SESSION_COOKIE, seal(sessionKey, session), "/", SESSION_TTL_S) };
  }

  return {
    /**
     * Where to send the browser, and the login cookie to set with it. `origin` is the public origin the
     * browser is on: the provider sends it back there, where the session cookie must land.
     */
    async startLogin(to?: string, origin: string = cfg.url): Promise<{ location: string; setCookie: string }> {
      const d = await discovery();
      const state = b64u(32);
      const nonce = b64u(32);
      const verifier = b64u(32);
      const u = new URL(d.authorization_endpoint);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", cfg.clientId);
      u.searchParams.set("redirect_uri", redirectUri(origin));
      u.searchParams.set("scope", "openid email profile groups");
      u.searchParams.set("state", state);
      u.searchParams.set("nonce", nonce);
      u.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      u.searchParams.set("code_challenge_method", "S256");
      const sealed = seal(loginKey, { state, nonce, verifier, origin, to: safeReturnPath(to), exp: now() + LOGIN_TTL_S * 1000 });
      return { location: u.toString(), setCookie: cookie(LOGIN_COOKIE, sealed, "/auth", LOGIN_TTL_S) };
    },

    async finishLogin(query: URLSearchParams, cookieHeader: string | undefined, origin: string = cfg.url): Promise<FinishResult> {
      const fail = (reason: FailReason): FinishResult => ({ ok: false, reason, setCookies: [clearLogin()] });
      const raw = cookies(cookieHeader).get(LOGIN_COOKIE);
      const login = raw === undefined ? undefined : unseal(loginKey, raw);
      if (!isObj(login) || !isStr(login.state) || !isStr(login.nonce) || !isStr(login.verifier) || typeof login.exp !== "number" || login.exp <= now()) return fail("no-login-cookie");
      if (query.has("error")) return fail("provider-error");
      const state = query.get("state");
      const code = query.get("code");
      if (state === null || !sameSecret(state, login.state)) return fail("state-mismatch");
      // The token endpoint wants the exact redirect_uri the sign-in started with. A login cookie from
      // before origins were sealed started on the default one.
      const started = isStr(login.origin) ? login.origin : cfg.url;
      if (started !== origin) return fail("state-mismatch");
      if (code === null || code === "") return fail("provider-error");

      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(started), code_verifier: login.verifier });
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      if (cfg.clientSecret === undefined) form.set("client_id", cfg.clientId);
      else headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64")}`;
      let idToken: unknown;
      try {
        const { status, body } = await getJson((await discovery()).token_endpoint, { method: "POST", headers, body: form.toString() });
        if (status !== 200 || !isObj(body)) return fail("token-endpoint");
        idToken = body.id_token; // the access and refresh tokens in `body` are dropped unread
      } catch {
        return fail("token-endpoint");
      }
      if (!isStr(idToken)) return fail("token-endpoint");

      let claims: Claims;
      try {
        claims = await verifyIdToken(idToken, login.nonce);
      } catch {
        return fail("bad-id-token");
      }
      if (!isStr(claims.email) || claims.email_verified !== true) return fail("email-unverified");
      const groups = Array.isArray(claims.groups) ? claims.groups.filter(isStr) : [];
      if (cfg.group !== undefined && !groups.includes(cfg.group)) return fail("not-in-group");
      const { session, setCookie } = startSession({ email: claims.email, name: isStr(claims.name) ? claims.name : isStr(claims.preferred_username) ? claims.preferred_username : "", groups });
      return { ok: true, session, to: safeReturnPath(typeof login.to === "string" ? login.to : undefined), setCookies: [setCookie, clearLogin()] };
    },

    /**
     * A session, and the cookie that holds it, for a person another party has already vouched for
     * (the embed ticket). It is the same session and cookie as a normal sign-in.
     */
    startSession,

    /** The session in a Cookie header, or undefined when none, forged, or past its expiry. */
    readSession(cookieHeader: string | undefined): Session | undefined {
      const raw = cookies(cookieHeader).get(SESSION_COOKIE);
      const s = raw === undefined ? undefined : unseal(sessionKey, raw);
      if (!isObj(s) || !isStr(s.email) || typeof s.name !== "string" || !Array.isArray(s.groups) || typeof s.exp !== "number") return undefined;
      if (s.exp <= Math.floor(now() / 1000)) return undefined;
      return { email: s.email, name: s.name, groups: s.groups.filter(isStr), exp: s.exp };
    },

    clearSessionCookie: (): string => cookie(SESSION_COOKIE, "", "/", 0),

    /**
     * The provider's end-session URL (OIDC RP-initiated logout), or undefined when it has none. The
     * session keeps no ID token, so there is no id_token_hint: the spec then wants client_id. There is
     * no post_logout_redirect_uri, so nothing has to be registered at the provider: the page opens
     * this link in its own tab, and the provider shows its own signed-out page there.
     */
    async endSessionUrl(): Promise<string | undefined> {
      const end = (await discovery()).end_session_endpoint;
      if (end === undefined) return undefined;
      const u = new URL(end);
      u.searchParams.set("client_id", cfg.clientId);
      return u.toString();
    },
  };
}

export type Oidc = ReturnType<typeof createOidc>;
