// No API answer may carry a token. The backend runs `findForbidden` on every response body before it
// sends it, and refuses to send one that fails; a backend test also walks every route with it.
//
// It checks key names and value shapes. A key name is exact (lower-cased, `-` and `_` removed), never a
// substring guess, so `tokens` (a count) or `tokenUse` pass and `access_token` does not.

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(
  ["token", "access_token", "refresh_token", "id_token", "api_key", "apikey", "secret", "client_secret", "password", "auth_json", "credentials", "cookie", "authorization"].map(norm),
);

function norm(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/** Value shapes that are a credential whatever their key: a JWT, an OpenAI or Anthropic key. */
const SECRET_VALUES: readonly RegExp[] = [/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /^sk-[A-Za-z0-9_-]{16,}/, /^sk-ant-[A-Za-z0-9_-]{16,}/];

/** The JSON path of the first forbidden key or secret-shaped value, or undefined when clean. */
export function findForbidden(value: unknown, path = "$"): string | undefined {
  if (typeof value === "string") return SECRET_VALUES.some((re) => re.test(value)) ? path : undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbidden(value[i], `${path}[${i}]`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(norm(k))) return `${path}.${k}`;
      const hit = findForbidden(v, `${path}.${k}`);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** The same shapes as SECRET_VALUES, but found inside a longer text. A word edge keeps `task-force-...` safe. */
const SECRET_IN_TEXT: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /(?<=Bearer )[A-Za-z0-9._~+/=-]{16,}/g,
];
/** `"key": "value"`, also as escaped JSON inside a string. Only a forbidden key loses its value. */
const KEYED_VALUE = /(\\?"([A-Za-z0-9_-]+)\\?"\s*:\s*\\?")([^"\\]*)(\\?")/g;

export const HIDDEN = "[hidden]";

/**
 * The text with every credential replaced by `[hidden]`: the value shapes of findForbidden, and the
 * value of a forbidden key such as `access_token` in an auth file snippet. For text that an answer
 * carries, such as a prompt or a transcript.
 */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_IN_TEXT) out = out.replace(re, HIDDEN);
  return out.replace(KEYED_VALUE, (whole, head: string, key: string, _v: string, tail: string) => (FORBIDDEN_KEYS.has(norm(key)) ? `${head}${HIDDEN}${tail}` : whole));
}
