// Failure kinds come from exact tables, never from free text. An unknown status is never `auth`,
// because `auth` can mark an account dead.

import type { Failure, FailureKind } from "./types.ts";

export function kindOfHttpStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate-limit";
  return "provider";
}

/** Codes that mean the login can never refresh again. Codex uses them. */
export const PERMANENT_AUTH_CODES: ReadonlySet<string> = new Set(["token_revoked", "refresh_token_invalidated", "refresh_token_reused", "invalid_grant"]);

/**
 * Exact `<status>:<type>` codes whose meaning differs from their status. Checked before the status
 * table. FreeTierError is a 403, but the key is fine: the provider refuses that free model for this
 * client. Reading it as `auth` would mark a healthy key account suspect.
 */
export const CODE_KINDS: Record<string, FailureKind> = {
  "403:FreeTierError": "provider",
};

const PI_ERROR = /^(\d{3}): ([\s\S]*)$/;

/** pi writes `errorMessage` as `<status>: <body>`. The status is a structural parse of the start. */
export function parsePiError(errorMessage: string): Failure {
  const m = PI_ERROR.exec(errorMessage);
  if (m === null) return { kind: "provider", code: "", message: errorMessage.slice(0, 500) };
  const status = Number(m[1]);
  const rest = m[2]!;
  let code = String(status);
  let message = rest.slice(0, 500);
  try {
    const body: unknown = JSON.parse(rest);
    if (typeof body === "object" && body !== null) {
      const b = body as { type?: unknown; message?: unknown };
      if (typeof b.type === "string") code = `${status}:${b.type}`;
      if (typeof b.message === "string") message = b.message;
    }
  } catch {
    // The body is not JSON; the raw text stays as the message.
  }
  return { kind: CODE_KINDS[code] ?? kindOfHttpStatus(status), code, message };
}

/**
 * Exact codex error codes, checked before the status table. A model the account cannot use is a
 * 400 `model_not_found`: a request problem, not a bad login. Every permanent auth code is `auth`.
 */
export const CODEX_CODE_KINDS: Record<string, FailureKind> = {
  usage_limit_reached: "quota",
  rate_limit_exceeded: "rate-limit",
  model_not_found: "provider",
  ...Object.fromEntries([...PERMANENT_AUTH_CODES].map((c) => [c, "auth" as const])),
};

/**
 * codex writes a failure message as a JSON string: `{"type":"error","status":400,"error":{"message":..,"code":..}}`.
 * The code is `error.code` when it is a string, else the status. A message that is not JSON is a provider failure with no code.
 */
export function parseCodexError(message: string): Failure {
  let body: unknown;
  try {
    body = JSON.parse(message);
  } catch {
    return { kind: "provider", code: "", message: message.slice(0, 500) };
  }
  if (typeof body !== "object" || body === null) return { kind: "provider", code: "", message: message.slice(0, 500) };
  const b = body as { status?: unknown; error?: unknown };
  const err = typeof b.error === "object" && b.error !== null ? (b.error as { code?: unknown; message?: unknown }) : {};
  const status = typeof b.status === "number" ? b.status : undefined;
  const text = typeof err.message === "string" ? err.message : message.slice(0, 500);
  if (typeof err.code === "string") {
    const kind = Object.hasOwn(CODEX_CODE_KINDS, err.code) ? CODEX_CODE_KINDS[err.code]! : status === undefined ? "provider" : kindOfHttpStatus(status);
    return { kind, code: err.code, message: text };
  }
  if (status !== undefined) return { kind: kindOfHttpStatus(status), code: String(status), message: text };
  return { kind: "provider", code: "", message: text };
}
