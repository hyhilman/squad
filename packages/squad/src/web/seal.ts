// Sealed cookies: AES-256-GCM with a key derived (HKDF) from the session key, one key per purpose, so
// a login cookie can never pass as a session. A cookie that fails to open is simply no cookie.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export function deriveKey(sessionKey: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionKey, Buffer.from("squad-web-v1"), Buffer.from(purpose), 32));
}

/** `base64url(iv | tag | ciphertext)` of the JSON value. */
export function seal(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function unseal(key: Buffer, text: string): unknown {
  try {
    const raw = Buffer.from(text, "base64url");
    if (raw.length < 29) return undefined;
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
  } catch {
    return undefined;
  }
}
