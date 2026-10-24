// The pure parts of a `claude setup-token` run, shared by the server sign-in (web/setup-token.ts) and
// the helper on a person's own computer (cli/connect.ts): the sign-in link allowlist, and the token
// matched by its exact shape. Nothing here keeps or logs a value.

/** The only page a setup-token sign-in may send a person to. */
const AUTH_HOST = "claude.com";
const AUTH_PATH = "/cai/oauth/authorize";
/** The page that shows the code to paste: the CLI's "manual" sign-in. */
export const MANUAL_REDIRECT = "https://platform.claude.com/oauth/code/callback";
/** The opened URL is one short line; anything longer is not the CLI's. */
export const MAX_OPENED = 8 * 1024;

const TOKEN_SHAPE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g;
const TOKEN_CHAR = /[A-Za-z0-9_-]/;
/** A whole value that is a setup-token token, nothing more. */
export const TOKEN_EXACT = /^sk-ant-oat01-[A-Za-z0-9_-]{20,4000}$/;
const CODE_SHAPE = /^[\x21-\x7e]{1,512}$/;
const LOCAL_CALLBACK = /^http:\/\/localhost:(\d{1,5})\/callback$/;

/**
 * Plain text from terminal output. A cursor move takes the place of a space in the CLI's UI, so
 * the prose loses its spaces: callers match on a URL or a token, never on prose. `sep` stands where an
 * escape sequence was.
 */
export function strip(raw: string, sep: string): string {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, sep)
    .replace(/\u001b\[[0-9;?<=>]*[ -/]*[@-~]/g, sep)
    .replace(/\u001b[()#][0-9A-Za-z]|\u001b[@-Z\\-_]/g, sep)
    .replace(/\r\n|\r/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, sep);
}

/** https://claude.com/cai/oauth/authorize exactly: no port, no user, no fragment. */
export const allowedUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname === AUTH_HOST && u.port === "" && u.username === "" && u.password === "" && u.pathname === AUTH_PATH && u.hash === "";
  } catch {
    return false;
  }
};

export type Parsed = { readonly kind: "wait" } | { readonly kind: "bad" } | { readonly kind: "ready"; readonly url: string };

/**
 * Finds the sign-in link in the CLI's output. Only whole lines count, so a half-printed link is never
 * judged. Every link in the output must pass the allowlist; one that does not is `bad`.
 */
export function parseSetupOutput(raw: string): Parsed {
  const text = strip(raw, "");
  const whole = text.slice(0, text.lastIndexOf("\n") + 1);
  let url: string | undefined;
  for (const m of whole.matchAll(/[a-z][a-z0-9+.-]*:\/\/\S*/gi)) {
    if (!allowedUrl(m[0])) return { kind: "bad" };
    url = m[0];
  }
  return url === undefined ? { kind: "wait" } : { kind: "ready", url };
}

/**
 * The manual sign-in link, built from the URL the CLI gave to $BROWSER. That URL carries the same
 * PKCE challenge and state as the printed one (checked on a real run); only its redirect is the CLI's
 * own localhost listener, which the person's browser cannot reach. So the redirect is set to the page
 * that shows a code, and every other byte stays as the CLI wrote it. Undefined when anything is off.
 */
export function linkFromOpened(raw: string): string | undefined {
  if (raw.length > MAX_OPENED) return undefined;
  const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  // One printable line with no space: the CLI's URL and nothing else.
  // The raw bytes are kept, so they must start exactly so: URL parsing would hide `:443` or upper case.
  if (!/^[\x21-\x7e]+$/.test(line) || !line.startsWith(`https://${AUTH_HOST}${AUTH_PATH}?`) || !allowedUrl(line)) return undefined;
  const q = line.indexOf("?");
  const parts = line.slice(q + 1).split("&");
  const at = parts.flatMap((p, i) => (p.startsWith("redirect_uri=") ? [i] : []));
  if (at.length !== 1) return undefined;
  let redirect: string;
  try {
    redirect = decodeURIComponent(parts[at[0]!]!.slice("redirect_uri=".length));
  } catch {
    return undefined;
  }
  const port = LOCAL_CALLBACK.exec(redirect)?.[1];
  if (port === undefined || Number(port) < 1 || Number(port) > 65535) return undefined;
  parts[at[0]!] = `redirect_uri=${encodeURIComponent(MANUAL_REDIRECT)}`;
  const out = `${line.slice(0, q)}?${parts.join("&")}`;
  return allowedUrl(out) ? out : undefined;
}

/**
 * The token the CLI printed, by its exact shape. It must be whole: followed by something that cannot be
 * in a token, or (`ended`) the output has ended. No other text is read.
 */
export function findToken(raw: string, ended: boolean): string | undefined {
  const text = strip(raw, "\u0001");
  for (const m of text.matchAll(TOKEN_SHAPE)) {
    const next = text[m.index + m[0].length];
    if (next === undefined ? ended : !TOKEN_CHAR.test(next)) return m[0];
  }
  return undefined;
}

/** What the CLI printed after a sign-in, made safe to keep: every run of 20 or more token characters is replaced. */
export function maskedTrace(raw: string): string {
  return strip(raw, " ").replace(/sk-ant[A-Za-z0-9_-]*/g, "[token?]").replace(/[A-Za-z0-9_-]{20,}/g, "[long]").replace(/[ \t]+/g, " ");
}

/** Why a pasted code is refused by shape, or undefined. The text never holds the value. */
export function codeShapeError(v: unknown): string | undefined {
  return typeof v === "string" && CODE_SHAPE.test(v) ? undefined : "the code must be 1 to 512 visible characters with no space";
}
