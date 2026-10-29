// The settings of `squad web` and its secret file. Each setting is one EnvSpec row. The secrets
// (the OIDC client secret, the session key, the embed key) live in `squad.secret.toml` in the home, never in the env.
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { HomeLayout } from "../home.ts";
import { SQUAD_NO_WEB_LOGIN_ENV, envNum, envOn, envOptional, type EnvSpec } from "../settings.ts";

export const SQUAD_WEB_URL_ENV: EnvSpec = {
  key: "SQUAD_WEB_URL",
  why: "the public base URL of the web app, such as https://squad.example.com, or a comma list of them when one squad answers on more than one host; required to start. Each request uses the entry whose host matches its Host header, and the first entry when none does. Sign-in sends the browser back to that entry",
};
export const SQUAD_WEB_PORT_ENV: EnvSpec = { key: "SQUAD_WEB_PORT", default: "20140", why: "the port `squad web` listens on; 0 = any free port" };
export const SQUAD_WEB_BIND_ENV: EnvSpec = { key: "SQUAD_WEB_BIND", default: "127.0.0.1", why: "the address `squad web` listens on; keep the loopback and put a TLS proxy in front" };
export const SQUAD_OIDC_ISSUER_ENV: EnvSpec = { key: "SQUAD_OIDC_ISSUER", why: "the OIDC issuer URL, exactly as the identity server's discovery document names it; required to start" };
export const SQUAD_OIDC_CLIENT_ID_ENV: EnvSpec = { key: "SQUAD_OIDC_CLIENT_ID", why: "the OIDC client id of squad at the identity server; required to start" };
export const SQUAD_OIDC_GROUP_ENV: EnvSpec = { key: "SQUAD_OIDC_GROUP", why: "a group the ID token's `groups` claim must hold; unset = any signed-in user with a verified email" };

export const SQUAD_OIDC_ADMIN_GROUP_ENV: EnvSpec = { key: "SQUAD_OIDC_ADMIN_GROUP", why: "a group the ID token's `groups` claim must hold for a person to be an admin who sees every account; a person who gains the group is admin from their next sign-in; unset = nobody is admin" };

export const SQUAD_WEB_PROVIDERS_ENV: EnvSpec = {
  key: "SQUAD_WEB_PROVIDERS",
  default: "all",
  why: "which providers the web app offers for a new account: `all`, or a comma list of ids (codex, claude, or a pi provider id); the server refuses any other",
};

export const SQUAD_WEB_FRAME_ANCESTORS_ENV: EnvSpec = {
  key: "SQUAD_WEB_FRAME_ANCESTORS",
  why: "the sites that may show the web app in an iframe, as a comma list of https origins (a host may start with `*.`); unset = no site may frame it",
};

export const SQUAD_WEB_API_ORIGINS_ENV: EnvSpec = {
  key: "SQUAD_WEB_API_ORIGINS",
  why: "the https origins of other apps on the same site that may call /api with the session cookie (CORS), as a comma list, exact match, no wildcards; unset = none",
};

export const SQUAD_WEB_BRAND_DIR_ENV: EnvSpec = {
  key: "SQUAD_WEB_BRAND_DIR",
  why: "a folder whose logo-light.png, logo-dark.png, favicon.ico and apple-touch-icon.png replace the built-in ones at /brand/ (one logo stands in for both); unset = the built-in files",
};

export const WEB_SETTINGS: readonly EnvSpec[] = [SQUAD_WEB_URL_ENV, SQUAD_WEB_PORT_ENV, SQUAD_WEB_BIND_ENV, SQUAD_OIDC_ISSUER_ENV, SQUAD_OIDC_CLIENT_ID_ENV, SQUAD_OIDC_GROUP_ENV, SQUAD_OIDC_ADMIN_GROUP_ENV, SQUAD_WEB_PROVIDERS_ENV, SQUAD_WEB_FRAME_ANCESTORS_ENV, SQUAD_WEB_API_ORIGINS_ENV, SQUAD_WEB_BRAND_DIR_ENV];

// An https origin, its host optionally starting with "*." (as CSP allows), with an optional port and
// nothing else: the value goes into a CSP header, so nothing may close the directive or add another.
const FRAME_ORIGIN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]{1,5})?$/;

/** The CSP `frame-ancestors` value from the setting. */
function frameAncestorsOf(raw: string | undefined): string {
  if (raw === undefined) return "'none'";
  const list = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
  if (list.length === 0) return "'none'";
  for (const o of list) if (!FRAME_ORIGIN.test(o)) throw new Error(`SQUAD_WEB_FRAME_ANCESTORS: each entry must be an https origin such as https://app.example.com`);
  return list.join(" ");
}

// An exact https origin, no wildcard, no path: the server compares it to the Origin header as text.
const API_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]{1,5})?$/;

function apiOriginsOf(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const list = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
  for (const o of list) if (!API_ORIGIN.test(o)) throw new Error("SQUAD_WEB_API_ORIGINS: each entry must be an exact https origin such as https://app.example.com");
  return list;
}

/** The ids the setting allows; undefined = all. */
export function allowedProviders(env: Readonly<Record<string, string | undefined>>): ReadonlySet<string> | undefined {
  const raw = (envOptional(SQUAD_WEB_PROVIDERS_ENV, env) ?? "all").trim();
  if (raw.toLowerCase() === "all") return undefined;
  return new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""));
}

export interface WebConfig {
  /** The first public base URL, without a trailing slash: the default for a request on no listed host. */
  readonly url: string;
  readonly origin: string;
  /** Every public origin, the first one first. */
  readonly origins: readonly string[];
  readonly port: number;
  readonly bind: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly group?: string;
  /** The group that makes an admin; unset = nobody. */
  readonly adminGroup?: string;
  /** The CSP frame-ancestors value for pages: 'none', or the sites that may frame the app. */
  readonly frameAncestors: string;
  /** Origins that may call /api with the session cookie, besides the app's own. */
  readonly apiOrigins: readonly string[];
  readonly clientSecret?: string;
  readonly sessionKey: Buffer;
  /** The key shared with the hub for embed tickets (`/auth/embed`); unset = that route is off. */
  readonly embedKey?: Buffer;
  /** Cookies get `Secure` when the public URLs are https. */
  readonly secure: boolean;
}

const SECRET_KEYS: readonly string[] = ["oidc_client_secret", "session_key", "embed_key"];
const LINE = /^([a-z][a-z0-9_]*)\s*=\s*"([^"\\]*)"$/;

/**
 * Reads `key = "value"` lines, blank lines and `#` comment lines. Anything else is refused. An error
 * names the line number, never the line: it may hold a secret.
 */
export function parseSecretToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = LINE.exec(line);
    if (m === null) throw new Error(`squad.secret.toml line ${i + 1}: only key = "value" lines are allowed`);
    if (Object.hasOwn(out, m[1]!)) throw new Error(`squad.secret.toml line ${i + 1}: the key is set twice`);
    out[m[1]!] = m[2]!;
  });
  return out;
}

interface Secrets {
  readonly clientSecret?: string;
  readonly sessionKey: Buffer;
  readonly embedKey?: Buffer;
}

/** Reads the secret file (mode 0600 only), and makes the session key on the first start. */
function loadSecrets(path: string): Secrets {
  let text: string | undefined;
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) throw new Error("squad.secret.toml must be mode 0600");
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const kv = text === undefined ? {} : parseSecretToml(text);
  for (const k of Object.keys(kv)) if (!SECRET_KEYS.includes(k)) throw new Error(`squad.secret.toml: unknown key ${k}`);
  // Before the file is written: a refused start must not change it. The value is never in the message.
  if (kv.embed_key !== undefined && kv.embed_key !== "" && !/^[0-9a-fA-F]{64}$/.test(kv.embed_key)) throw new Error("squad.secret.toml: embed_key must be exactly 64 hex characters (32 bytes)");
  let key = kv.session_key;
  if (key === undefined) {
    key = randomBytes(32).toString("base64url");
    const line = `session_key = "${key}"\n`;
    if (text === undefined) writeFileSync(path, line, { mode: 0o600, flag: "wx" });
    else appendFileSync(path, `${text.endsWith("\n") || text === "" ? "" : "\n"}${line}`);
  }
  const sessionKey = /^[A-Za-z0-9_-]+$/.test(key) ? Buffer.from(key, "base64url") : Buffer.alloc(0);
  if (sessionKey.length < 32) throw new Error("squad.secret.toml: session_key must be 32 random bytes in base64url");
  return {
    ...(kv.embed_key === undefined || kv.embed_key === "" ? {} : { embedKey: Buffer.from(kv.embed_key, "hex") }),
    ...(kv.oidc_client_secret === undefined || kv.oidc_client_secret === "" ? {} : { clientSecret: kv.oidc_client_secret }),
    sessionKey,
  };
}

/** The public URLs, in order. One scheme for all of them: the cookie's `Secure` flag is one choice. */
function webUrlsOf(raw: string | undefined): readonly URL[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (list.length === 0) throw new Error(`${SQUAD_WEB_URL_ENV.key} is required`);
  const urls = list.map((one) => {
    const u = parseUrl(SQUAD_WEB_URL_ENV, one);
    if (u.pathname !== "/") throw new Error("SQUAD_WEB_URL must be an origin with no path");
    return u;
  });
  if (new Set(urls.map((u) => u.host)).size !== urls.length) throw new Error("SQUAD_WEB_URL: each host may be listed once");
  if (new Set(urls.map((u) => u.protocol)).size !== 1) throw new Error("SQUAD_WEB_URL: every entry must have the same scheme");
  return urls;
}

const isLoopback = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "[::1]";

function parseUrl(spec: EnvSpec, raw: string | undefined): URL {
  if (raw === undefined) throw new Error(`${spec.key} is required`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${spec.key} must be a URL`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) throw new Error(`${spec.key} must be https (plain http only for the loopback)`);
  if (u.search !== "" || u.hash !== "") throw new Error(`${spec.key} must have no query or fragment`);
  return u;
}

/** Everything `squad web` needs. Throws, with a message free of secrets, when it cannot start. */
export function loadWebConfig(env: Readonly<Record<string, string | undefined>>, home: HomeLayout): WebConfig {
  if (envOn(SQUAD_NO_WEB_LOGIN_ENV, env)) throw new Error("SQUAD_NO_WEB_LOGIN=1: the web app does not start");
  const webs = webUrlsOf(envOptional(SQUAD_WEB_URL_ENV, env));
  const web = webs[0]!;
  const issuerRaw = envOptional(SQUAD_OIDC_ISSUER_ENV, env);
  parseUrl(SQUAD_OIDC_ISSUER_ENV, issuerRaw);
  const clientId = envOptional(SQUAD_OIDC_CLIENT_ID_ENV, env);
  if (clientId === undefined) throw new Error("SQUAD_OIDC_CLIENT_ID is required");
  const port = envNum(SQUAD_WEB_PORT_ENV, env);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("SQUAD_WEB_PORT must be a port from 0 to 65535");
  const secrets = loadSecrets(join(home.root, "squad.secret.toml"));
  const group = envOptional(SQUAD_OIDC_GROUP_ENV, env);
  const adminGroup = envOptional(SQUAD_OIDC_ADMIN_GROUP_ENV, env);
  return {
    url: web.origin,
    origin: web.origin,
    origins: webs.map((u) => u.origin),
    port,
    bind: envOptional(SQUAD_WEB_BIND_ENV, env)!,
    issuer: issuerRaw!,
    clientId,
    ...(group === undefined ? {} : { group }),
    ...(adminGroup === undefined ? {} : { adminGroup }),
    frameAncestors: frameAncestorsOf(envOptional(SQUAD_WEB_FRAME_ANCESTORS_ENV, env)),
    apiOrigins: apiOriginsOf(envOptional(SQUAD_WEB_API_ORIGINS_ENV, env)),
    ...(secrets.clientSecret === undefined ? {} : { clientSecret: secrets.clientSecret }),
    sessionKey: secrets.sessionKey,
    ...(secrets.embedKey === undefined ? {} : { embedKey: secrets.embedKey }),
    secure: web.protocol === "https:",
  };
}
