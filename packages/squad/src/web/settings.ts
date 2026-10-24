// The settings of `squad web` and its secret file. Each setting is one EnvSpec row. The two secrets
// (the OIDC client secret, the session key) live in `squad.secret.toml` in the home, never in the env.
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { HomeLayout } from "../home.ts";
import { SQUAD_NO_WEB_LOGIN_ENV, envNum, envOn, envOptional, type EnvSpec } from "../settings.ts";

export const SQUAD_WEB_URL_ENV: EnvSpec = {
  key: "SQUAD_WEB_URL",
  why: "the public base URL of the web app, such as https://squad.example.com; required to start. Sign-in sends the browser back to it",
};
export const SQUAD_WEB_PORT_ENV: EnvSpec = { key: "SQUAD_WEB_PORT", default: "20140", why: "the port `squad web` listens on; 0 = any free port" };
export const SQUAD_WEB_BIND_ENV: EnvSpec = { key: "SQUAD_WEB_BIND", default: "127.0.0.1", why: "the address `squad web` listens on; keep the loopback and put a TLS proxy in front" };
export const SQUAD_OIDC_ISSUER_ENV: EnvSpec = { key: "SQUAD_OIDC_ISSUER", why: "the OIDC issuer URL, exactly as the identity server's discovery document names it; required to start" };
export const SQUAD_OIDC_CLIENT_ID_ENV: EnvSpec = { key: "SQUAD_OIDC_CLIENT_ID", why: "the OIDC client id of squad at the identity server; required to start" };
export const SQUAD_OIDC_GROUP_ENV: EnvSpec = { key: "SQUAD_OIDC_GROUP", why: "a group the ID token's `groups` claim must hold; unset = any signed-in user with a verified email" };

export const SQUAD_OIDC_ADMIN_GROUP_ENV: EnvSpec = { key: "SQUAD_OIDC_ADMIN_GROUP", why: "a group the ID token's `groups` claim must hold for a person to be an admin who sees every account; unset = nobody is admin" };

export const SQUAD_WEB_PROVIDERS_ENV: EnvSpec = {
  key: "SQUAD_WEB_PROVIDERS",
  default: "all",
  why: "which providers the web app offers for a new account: `all`, or a comma list of ids (codex, claude, or a pi provider id); the server refuses any other",
};

export const WEB_SETTINGS: readonly EnvSpec[] = [SQUAD_WEB_URL_ENV, SQUAD_WEB_PORT_ENV, SQUAD_WEB_BIND_ENV, SQUAD_OIDC_ISSUER_ENV, SQUAD_OIDC_CLIENT_ID_ENV, SQUAD_OIDC_GROUP_ENV, SQUAD_OIDC_ADMIN_GROUP_ENV, SQUAD_WEB_PROVIDERS_ENV];

/** The ids the setting allows; undefined = all. */
export function allowedProviders(env: Readonly<Record<string, string | undefined>>): ReadonlySet<string> | undefined {
  const raw = (envOptional(SQUAD_WEB_PROVIDERS_ENV, env) ?? "all").trim();
  if (raw.toLowerCase() === "all") return undefined;
  return new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""));
}

export interface WebConfig {
  /** The public base URL, without a trailing slash. */
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  readonly bind: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly group?: string;
  /** The group that makes an admin; unset = nobody. */
  readonly adminGroup?: string;
  readonly clientSecret?: string;
  readonly sessionKey: Buffer;
  /** Cookies get `Secure` when the public URL is https. */
  readonly secure: boolean;
}

const SECRET_KEYS: readonly string[] = ["oidc_client_secret", "session_key"];
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
  let key = kv.session_key;
  if (key === undefined) {
    key = randomBytes(32).toString("base64url");
    const line = `session_key = "${key}"\n`;
    if (text === undefined) writeFileSync(path, line, { mode: 0o600, flag: "wx" });
    else appendFileSync(path, `${text.endsWith("\n") || text === "" ? "" : "\n"}${line}`);
  }
  const sessionKey = /^[A-Za-z0-9_-]+$/.test(key) ? Buffer.from(key, "base64url") : Buffer.alloc(0);
  if (sessionKey.length < 32) throw new Error("squad.secret.toml: session_key must be 32 random bytes in base64url");
  return { ...(kv.oidc_client_secret === undefined || kv.oidc_client_secret === "" ? {} : { clientSecret: kv.oidc_client_secret }), sessionKey };
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
  const web = parseUrl(SQUAD_WEB_URL_ENV, envOptional(SQUAD_WEB_URL_ENV, env));
  if (web.pathname !== "/") throw new Error("SQUAD_WEB_URL must be an origin with no path");
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
    port,
    bind: envOptional(SQUAD_WEB_BIND_ENV, env)!,
    issuer: issuerRaw!,
    clientId,
    ...(group === undefined ? {} : { group }),
    ...(adminGroup === undefined ? {} : { adminGroup }),
    ...(secrets.clientSecret === undefined ? {} : { clientSecret: secrets.clientSecret }),
    sessionKey: secrets.sessionKey,
    secure: web.protocol === "https:",
  };
}
