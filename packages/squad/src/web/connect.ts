// "Use my computer" claude sign-ins. The page starts one and shows a command; the person runs
// `squad connect` on their own computer, where the real claude CLI opens their browser and its
// localhost callback finishes there, with no typing. The helper then sends the token here once.
//
// The pair code is the helper's only proof: 256 random bits, single use, valid 10 minutes, bound to
// the person and the account name. The server keeps only its SHA-256 and compares it in constant time.
// Wrong codes are counted per client (see clientKeyOf) and for the whole server. Everything lives in memory. No answer and no log line
// holds the code or the token.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { findForbidden, type ConnectStart, type ConnectStatus, type LoginState } from "@squad/contract";
import { AccountExists, createFileAccount } from "../accounts/add.ts";
import { replaceToken } from "../accounts/care.ts";
import { ACCOUNT_NAME, accountId, liveAccount } from "../accounts/store.ts";
import { TOKEN_EXACT } from "../claude-token.ts";
import type { HomeLayout } from "../home.ts";
import type { Log } from "../log.ts";
import { SQUAD_DRY_RUN_ENV, SQUAD_NO_WEB_LOGIN_ENV, envOn } from "../settings.ts";
import type { Store } from "../store/db.ts";
import { KEEP_MS, LoginRefused } from "./device-login.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const CONNECT_LIFE_MS = 10 * 60_000;
/** Wrong pair codes one client may send in a minute; then every try is refused for that minute. */
export const WRONG_PER_MINUTE = 30;
/** Wrong pair codes all clients together may send in a minute: a bound on guessing from many addresses. */
export const WRONG_ALL_PER_MINUTE = 300;
const MINUTE_MS = 60_000;
/** Pending connects at once, for the whole server. */
const MAX_PENDING = 20;
/** Client addresses tracked at once; past this, every unknown address shares one bucket. */
const MAX_ADDRESSES = 1000;
export const PAIR_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/;

/** Where the helper tarball of a version lives: the GitHub release that `npm pack` output is attached to. */
const RELEASE = "https://github.com/hyhilman/squad/releases/download";

const NOT_FOUND = (): LoginRefused => new LoginRefused(404, "not-found", "not found");

const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who a wrong code is counted for. Behind cloudflared every peer is loopback, so one bad client would
 * hold everyone: there the tunnel's `cf-connecting-ip` is the client. Only a loopback peer is trusted
 * with it; a local caller that forges it only moves its own count. A header that is not one plain IP
 * is ignored.
 */
export function clientKeyOf(peer: string, header: string | readonly string[] | undefined): string {
  if (!LOOPBACK.has(peer) || typeof header !== "string") return peer;
  const h = header.trim();
  return h.length <= 45 && isIP(h) !== 0 ? h : peer;
}

/**
 * A fresh pair code. It is drawn again when it starts with `-` (a shell or an option parser would take
 * it for a flag) or looks like a key to findForbidden (the start answer would then be refused).
 */
export function newPairCode(draw: () => string = () => randomBytes(32).toString("base64url")): string {
  for (;;) {
    const c = draw();
    if (PAIR_SHAPE.test(c) && findForbidden(c) === undefined) return c;
  }
}

const hashOf = (code: string): Buffer => createHash("sha256").update(code, "utf8").digest();

/** This package's version, from its package.json: one folder up from `src/` and from `dist/`. */
export function squadVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error("package.json has no version");
  return pkg.version;
}

export function connectCommand(version: string, origin: string, pairCode: string): { command: string; shortCommand: string } {
  const args = `connect --url ${origin} --pair ${pairCode}`;
  return { command: `npx -y ${RELEASE}/v${version}/squad-${version}.tgz ${args}`, shortCommand: `squad ${args}` };
}

export interface ConnectDeps {
  readonly env: Env;
  readonly home: HomeLayout;
  readonly store: Store;
  readonly log: Log;
  readonly now: () => Date;
  /** The public origin (SQUAD_WEB_URL) the helper sends the token to. */
  readonly origin: string;
  readonly version: string;
}

interface Entry {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  /** A new token for this existing account, in place of a new account. */
  readonly replace: boolean;
  readonly accountId: string;
  readonly hash: Buffer;
  readonly expiresAt: number;
  state: LoginState;
  reason?: string;
  finishedAt?: number;
}

export class ConnectPairs {
  private readonly d: ConnectDeps;
  private readonly entries = new Map<string, Entry>();
  /** Wrong codes per client address: the minute's start and the count. */
  private readonly wrong = new Map<string, { since: number; n: number }>();
  /** Wrong codes of every client in this minute. */
  private all = { since: 0, n: 0 };

  constructor(d: ConnectDeps) {
    this.d = d;
  }

  private off(): LoginRefused | undefined {
    if (envOn(SQUAD_NO_WEB_LOGIN_ENV, this.d.env)) return new LoginRefused(501, "disabled", "web login is off (SQUAD_NO_WEB_LOGIN=1)");
    if (envOn(SQUAD_DRY_RUN_ENV, this.d.env)) return new LoginRefused(501, "disabled", "no account is written while SQUAD_DRY_RUN=1");
    return undefined;
  }

  private end(e: Entry, state: LoginState, reason?: string): void {
    e.state = state;
    if (reason !== undefined) e.reason = reason;
    e.finishedAt = this.d.now().getTime();
    if (state === "done") this.d.log.info("connect_done", { account: e.accountId });
    else this.d.log.warn("connect_failed", { account: e.accountId, reason: reason ?? state });
  }

  /** Ends what ran out of time, and forgets what ended long ago. */
  private sweep(): void {
    const now = this.d.now().getTime();
    for (const [id, e] of this.entries) {
      if (e.state === "pending" && now > e.expiresAt) this.end(e, "expired", "expired");
      if (e.finishedAt !== undefined && now - e.finishedAt > KEEP_MS) this.entries.delete(id);
    }
    for (const [ip, w] of this.wrong) if (now - w.since >= MINUTE_MS) this.wrong.delete(ip);
    if (now - this.all.since >= MINUTE_MS) this.all = { since: now, n: 0 };
  }

  /** A connect for a NEW claude token account the person owns, or (`replace`) a new token for their own one. */
  start(email: string, name: string, replace = false): ConnectStart {
    const off = this.off();
    if (off !== undefined) throw off;
    if (!ACCOUNT_NAME.test(name)) throw new LoginRefused(400, "bad-request", "the name must be lower-case letters, digits, dot, dash or underscore, and start with a letter or digit");
    const aid = accountId("claude", name);
    const there = liveAccount(this.d.store.db, aid);
    if (replace) {
      // Someone else's account looks the same as none.
      if (there === undefined || there.kind !== "token" || there.ownerEmail?.toLowerCase() !== email.toLowerCase()) throw NOT_FOUND();
    } else if (there !== undefined) throw new LoginRefused(409, "conflict", "an account with this name exists");
    this.sweep();
    const pending = [...this.entries.values()].filter((e) => e.state === "pending");
    if (pending.some((e) => e.accountId === aid)) throw new LoginRefused(409, "conflict", "a sign-in is already waiting for this account");
    if (pending.length >= MAX_PENDING) throw new LoginRefused(409, "conflict", "too many sign-ins are waiting: try again soon");
    const id = randomBytes(16).toString("base64url");
    const code = newPairCode();
    const expiresAt = this.d.now().getTime() + CONNECT_LIFE_MS;
    this.entries.set(id, { id, owner: email.toLowerCase(), name, replace, accountId: aid, hash: hashOf(code), expiresAt, state: "pending" });
    this.d.log.info("connect_started", { account: aid });
    return { connectId: id, pairCode: code, expiresAt: new Date(expiresAt).toISOString(), ...connectCommand(this.d.version, this.d.origin, code) };
  }

  status(email: string, connectId: string): ConnectStatus {
    this.sweep();
    const e = this.entries.get(connectId);
    if (e === undefined || e.owner !== email.toLowerCase()) throw new LoginRefused(404, "not-found", "no such sign-in");
    return { connectId, state: e.state, ...(e.reason === undefined || e.state === "expired" ? {} : { reason: e.reason }), ...(e.state === "done" ? { account: e.accountId } : {}) };
  }

  private held(ip: string): boolean {
    if (this.all.n >= WRONG_ALL_PER_MINUTE) return true;
    const w = this.wrong.get(ip) ?? this.wrong.get("*");
    return w !== undefined && w.n >= WRONG_PER_MINUTE;
  }

  private countWrong(ip: string): void {
    this.all.n += 1;
    const key = this.wrong.has(ip) || this.wrong.size < MAX_ADDRESSES ? ip : "*";
    const w = this.wrong.get(key);
    if (w === undefined) this.wrong.set(key, { since: this.d.now().getTime(), n: 1 });
    else w.n += 1;
  }

  /**
   * The helper's token for the pair code. The limit is checked before the code, so a held address
   * learns nothing about it. The code is used up by any answer but 404 and 429.
   */
  /** `email`: the account user, already shape-checked by the route; unset = unknown. */
  redeem(ip: string, pairCode: string, token: unknown, email?: string): { account: string } {
    const off = this.off();
    if (off !== undefined) throw off;
    this.sweep();
    if (this.held(ip)) throw new LoginRefused(429, "too-many", "too many tries: wait a minute");
    const h = hashOf(pairCode);
    let hit: Entry | undefined;
    for (const e of this.entries.values()) if (timingSafeEqual(e.hash, h) && e.state === "pending") hit = e;
    if (hit === undefined) {
      this.countWrong(ip);
      throw NOT_FOUND();
    }
    if (typeof token !== "string" || !TOKEN_EXACT.test(token)) {
      this.end(hit, "failed", "bad-token");
      throw new LoginRefused(400, "bad-request", "the token has a wrong shape");
    }
    try {
      if (hit.replace) {
        const row = liveAccount(this.d.store.db, hit.accountId);
        if (row === undefined || row.kind !== "token" || row.ownerEmail?.toLowerCase() !== hit.owner) throw new AccountExists("the account is gone");
        replaceToken(this.d.store, this.d.home, row, token, hit.owner, this.d.now(), email ?? null);
      } else createFileAccount(this.d.store.db, this.d.home, { runner: "claude", name: hit.name, kind: "token", ownerEmail: hit.owner, ...(email === undefined ? {} : { loginEmail: email }), consent: { by: hit.owner } }, [{ name: "token", body: token }], this.d.now());
    } catch (err) {
      if (err instanceof AccountExists) {
        this.end(hit, "failed", "exists");
        throw new LoginRefused(409, "conflict", "an account with this name exists");
      }
      this.end(hit, "failed", "internal");
      throw new LoginRefused(500, "internal", "cannot write the account");
    }
    this.end(hit, "done");
    return { account: hit.accountId };
  }
}
