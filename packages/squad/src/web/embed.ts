// The embed ticket: a short signed note from the hub's backend that says "this person is signed in
// with me". squad checks it and makes its own normal session, so a framed squad needs no sign-in click.
// An answer from here carries a fixed reason word, never the ticket or a claim from it.
import { createHmac } from "node:crypto";
import { sameSecret } from "./oidc.ts";

export interface EmbedConfig {
  /** The 32-byte key the hub and squad share. */
  readonly key: Buffer;
  /** squad's public base URL; the ticket's `aud` must equal it. */
  readonly url: string;
  /** A group the ticket's `groups` must hold, as for a normal sign-in. */
  readonly group?: string;
}

export interface EmbedWho {
  readonly email: string;
  readonly name: string;
  readonly groups: readonly string[];
}

export type EmbedReason =
  | "too-long" | "bad-shape" | "bad-mac" | "bad-payload" | "bad-version" | "bad-aud" | "bad-lifetime"
  | "future" | "expired" | "before-start" | "reused" | "memory-full" | "not-in-group";

export type EmbedResult = { readonly ok: true; readonly who: EmbedWho } | { readonly ok: false; readonly reason: EmbedReason };

export interface EmbedDeps {
  /** Epoch milliseconds. */
  readonly now?: () => number;
}

const MAX_LIFETIME_S = 60;
// How far ahead of this server's clock a ticket's iat may be (the hub's clock may run ahead). The
// same number moves the start line: a ticket used just before a restart has iat <= (that second) + 5
// <= start + 5, so the new process always refuses it, and the lost used-id memory cannot let it run
// twice. The cost: for about 6 seconds after each start every ticket is refused, and the frame shows
// the signed-out card with its Sign in button.
const EMBED_SKEW_S = 5;
const MAX_TICKET = 8192;
/** The most ids kept. At the cap a new ticket is refused: forgetting an id would let its ticket run again. */
export const MAX_USED = 10_000;
const B64U = /^[A-Za-z0-9_-]+$/;
const JTI = /^[A-Za-z0-9_-]{22}$/;
const FIELDS = ["aud", "email", "exp", "groups", "iat", "jti", "name", "v"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export function createEmbed(cfg: EmbedConfig, deps: EmbedDeps = {}) {
  const now = deps.now ?? Date.now;
  // The used ids below are lost on a restart, so a ticket from before it must not pass again.
  const startedS = Math.floor(now() / 1000);
  /** jti -> exp (epoch seconds) */
  const used = new Map<string, number>();

  return {
    /** Checks the ticket and spends its id. The first failing check names the reason. */
    check(ticket: unknown): EmbedResult {
      const no = (reason: EmbedReason): EmbedResult => ({ ok: false, reason });
      if (typeof ticket === "string" && ticket.length > MAX_TICKET) return no("too-long"); // before any decoding
      if (typeof ticket !== "string") return no("bad-shape");
      const parts = ticket.split(".");
      if (parts.length !== 2 || !B64U.test(parts[0]!) || !B64U.test(parts[1]!)) return no("bad-shape");
      const [body, mac] = parts as [string, string];
      if (!sameSecret(mac, createHmac("sha256", cfg.key).update(body).digest("base64url"))) return no("bad-mac");

      let p: unknown;
      try {
        p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        return no("bad-payload");
      }
      if (!isObj(p) || Object.keys(p).sort().join() !== FIELDS.join()) return no("bad-payload");
      const { v, aud, email, name, groups, iat, exp, jti } = p;
      if (!isInt(v) || typeof aud !== "string" || typeof email !== "string" || email === "" || typeof name !== "string") return no("bad-payload");
      if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string") || !isInt(iat) || !isInt(exp)) return no("bad-payload");
      if (typeof jti !== "string" || !JTI.test(jti)) return no("bad-payload");
      if (v !== 1) return no("bad-version");
      if (aud !== cfg.url) return no("bad-aud");
      if (exp - iat < 1 || exp - iat > MAX_LIFETIME_S) return no("bad-lifetime");
      const nowS = Math.floor(now() / 1000);
      if (iat > nowS + EMBED_SKEW_S) return no("future");
      if (exp <= nowS) return no("expired");
      if (iat <= startedS + EMBED_SKEW_S) return no("before-start");

      for (const [id, until] of used) if (until <= nowS) used.delete(id);
      if (used.has(jti)) return no("reused");
      if (used.size >= MAX_USED) return no("memory-full");
      const list = groups as string[];
      // Last, so that a refused ticket never spends its id.
      if (cfg.group !== undefined && !list.includes(cfg.group)) return no("not-in-group");
      used.set(jti, exp);
      return { ok: true, who: { email, name, groups: list.filter((g) => g !== "") } };
    },
  };
}

export type Embed = ReturnType<typeof createEmbed>;
