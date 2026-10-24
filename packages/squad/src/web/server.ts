// `squad web`: the HTTP server. It serves exactly the contract's ROUTES under /api, the OIDC sign-in
// under /auth, and the built web app as static files.
//
// A person sees only the accounts whose owner email is theirs; any other id is a 404, so ids do not
// leak. An admin (the ID token's groups hold SQUAD_OIDC_ADMIN_GROUP) sees every account and may set
// floors and enable or disable any of them; consent and login stay with the owner. Every JSON answer passes `findForbidden` first. An answer or a log line never holds a token,
// a cookie, the client secret or the session key.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { bundledPath } from "../paths.ts";
import { ROUTES, findForbidden, matchPath, type AccountView, type ProviderView, type Api, type ApiError, type ErrorCode, type RoomPoint, type RouteName, type UsageRow as ApiUsageRow } from "@squad/contract";
import { AccountExists, createFileAccount, secretShapeError } from "../accounts/add.ts";
import { getLogo } from "../logos.ts";
import { loadProviders } from "../prices.ts";
import { authJsonFor, modelsJsonFor, piProvidersIn, providerEntries } from "../providers.ts";
import { getAccount, getHealth, healthOf, listAccounts, roomSince, setConsent, setOwnerFloors, setState, type AccountRow } from "../accounts/store.ts";
import type { HomeLayout } from "../home.ts";
import { makeLog, type Log } from "../log.ts";
import { flockBusy, lockPathOf } from "../run.ts";
import { ACCOUNT_NAME } from "../accounts/store.ts";
import { SQUAD_DOCKER_ENV, SQUAD_DRY_RUN_ENV, SQUAD_FLOOR_DEFAULT_ENV, SQUAD_PRICES_URL_ENV, envNum, envOn, envOptional } from "../settings.ts";
import type { Store } from "../store/db.ts";
import { USAGE_BYS, getPassRow, listPassesPage, usageBy, usageSeries, type UsageBy } from "../usage/report.ts";
import { DeviceLogins, LoginRefused, dockerLoginRunner, type LoginRunner, type LoginTimers } from "./device-login.ts";
import { createOidc, OidcError, safeReturnPath, type FailReason, type Session } from "./oidc.ts";
import { passDetail, passViews } from "./passes.ts";
import { allowedProviders, loadWebConfig } from "./settings.ts";
import { SetupTokenLogins, codeShapeError, dockerPtyRunner, type PtyRunner } from "./setup-token.ts";
import { startTicker, type Timers } from "./ticker.ts";

export interface Ctx<N extends RouteName> {
  readonly params: Api[N]["params"];
  readonly query: Api[N]["query"];
  readonly body: Api[N]["body"];
  readonly session: Session;
}
export type Handlers = { [N in RouteName]: (c: Ctx<N>) => Api[N]["res"] | Promise<Api[N]["res"]> };

export interface WebOpts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: HomeLayout;
  readonly store: Store;
  /** No static files: the API alone, for `npm run dev -w @squad/web`. */
  readonly apiOnly?: boolean;
  /** The built web app. Default: `apps/web/dist/` found from this file. */
  readonly staticDir?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly log?: Log;
  /** Whether a pass holds the account now. Default: a login account whose lock is held. */
  readonly busy?: (a: AccountRow) => boolean;
  /**
   * Runs one probe pass on an account (the same code as `squad probe`). The background loop starts only
   * when this is given, so a caller that does not want real passes never gets them.
   */
  readonly probe?: (account: AccountRow, model: string) => Promise<void>;
  /** Replaces the loop's timers. For tests only. */
  readonly ticker?: { readonly timers?: Timers };
  /** Replaces the docker calls of a web login, and its timers. For tests only. */
  readonly login?: Partial<LoginRunner> & { readonly timers?: LoginTimers; readonly pty?: PtyRunner };
  /** Replaces handlers. For tests only. */
  readonly handlers?: Partial<Handlers>;
}

export interface WebHandle {
  readonly port: number;
  readonly bind: string;
  /** The public URL (SQUAD_WEB_URL). */
  readonly url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const INTERNAL: ApiError = { error: "internal", message: "internal error" };
const MAX_BODY = 64 * 1024;
const NOT_FOUND = new HttpError(404, "not-found", "no such account");
const bad = (message: string): HttpError => new HttpError(400, "bad-request", message);

// ---- input checks, one per route that takes a query or a body ----

const SINCE = /^(\d+)([hd])$/;
const PASS_ID = /^[0-9A-Za-z]{1,40}$/;
const PASS_LIMIT_DEFAULT = 50;
const PASS_LIMIT_MAX = 200;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const floor = (v: unknown): number | null => {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) return v;
  throw bad("a floor is a number from 0 to 100, or null");
};

type Inputs = { [N in RouteName]: { query?: (q: URLSearchParams) => Api[N]["query"]; body?: (b: unknown) => Api[N]["body"] } };
const INPUTS: Inputs = {
  me: {}, listAccounts: {}, getAccount: {}, startLogin: {}, loginStatus: {}, getPass: {},
  submitLoginCode: {
    // The code is secret and short-lived: the message is fixed, nothing from the body is echoed.
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["code"]) || typeof b.code !== "string" || codeShapeError(b.code) !== undefined) throw bad("body must be {code}, 1 to 512 visible characters with no space");
      return { code: b.code };
    },
  },
  listProviders: {},
  addAccount: {
    // The messages are fixed text: a refused body may hold a key, so nothing from it is echoed.
    body: (b) => {
      const shape = 'body must be {runner: "codex", name}, {runner: "claude", name[, token]} or {runner: "pi", name, provider, key}';
      if (!isObj(b) || typeof b.name !== "string") throw bad(shape);
      if (b.runner === "codex" && onlyKeys(b, ["runner", "name"])) return { runner: "codex", name: b.name };
      if (b.runner === "claude" && onlyKeys(b, ["runner", "name"])) return { runner: "claude", name: b.name };
      if (b.runner === "claude" && onlyKeys(b, ["runner", "name", "token"]) && typeof b.token === "string") return { runner: "claude", name: b.name, token: b.token };
      if (b.runner === "pi" && onlyKeys(b, ["runner", "name", "provider", "key"]) && typeof b.provider === "string" && typeof b.key === "string") return { runner: "pi", name: b.name, provider: b.provider, key: b.key };
      throw bad(shape);
    },
  },
  usageSeries: {
    query: (q) => {
      const by = q.get("by");
      if (by !== "day" && by !== "hour") throw bad("by must be day or hour");
      const since = q.get("since");
      const account = q.get("account");
      return { by, ...(since === null ? {} : { since }), ...(account === null ? {} : { account }) };
    },
  },
  roomSeries: {
    query: (q) => {
      const since = q.get("since");
      return since === null ? {} : { since };
    },
  },
  listPasses: {
    query: (q) => {
      const account = q.get("account");
      const since = q.get("since");
      const before = q.get("before");
      const rawLimit = q.get("limit");
      let limit: number | undefined;
      if (rawLimit !== null) {
        limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
        if (!(limit >= 1 && limit <= PASS_LIMIT_MAX)) throw bad(`limit must be a whole number from 1 to ${PASS_LIMIT_MAX}`);
      }
      if (before !== null && !PASS_ID.test(before)) throw bad("before must be a pass id");
      return { ...(account === null ? {} : { account }), ...(since === null ? {} : { since }), ...(limit === undefined ? {} : { limit }), ...(before === null ? {} : { before }) };
    },
  },
  setFloor: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["floor5h", "floorWeek"]) || !("floor5h" in b) || !("floorWeek" in b)) throw bad("body must be {floor5h, floorWeek}");
      return { floor5h: floor(b.floor5h), floorWeek: floor(b.floorWeek) };
    },
  },
  setEnabled: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["enabled"]) || typeof b.enabled !== "boolean") throw bad("body must be {enabled: boolean}");
      return { enabled: b.enabled };
    },
  },
  consent: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["agree"]) || b.agree !== true) throw bad("body must be {agree: true}");
      return { agree: true };
    },
  },
  usage: {
    query: (q) => {
      const by = q.get("by");
      if (by === null) throw bad("by is required");
      const since = q.get("since");
      const account = q.get("account");
      return { by: by as UsageBy, ...(since === null ? {} : { since }), ...(account === null ? {} : { account }) };
    },
  },
};

// ---- the handlers ----

function makeHandlers(o: WebOpts, logins: DeviceLogins, setups: SetupTokenLogins, adminGroup: string | undefined): Handlers {
  const db = o.store.db;
  const now = o.now ?? (() => new Date());
  const busyOf = o.busy ?? ((a: AccountRow): boolean => {
    if (a.kind !== "login") return false;
    const lock = lockPathOf(o.home, a);
    return existsSync(lock) && flockBusy(lock);
  });
  /** The groups claim holds the admin group, by exact string equality. Unset = nobody. */
  const isAdmin = (s: Session): boolean => adminGroup !== undefined && s.groups.includes(adminGroup);
  const sinceOf = (spec: string, fallback: string): Date => {
    const rel = SINCE.exec(spec === "" ? fallback : spec);
    const at = rel !== null ? new Date(now().getTime() - Number(rel[1]) * (rel[2] === "d" ? 86_400_000 : 3_600_000)) : /^\d{4}-\d{2}-\d{2}/.test(spec) ? new Date(spec) : new Date(NaN);
    if (Number.isNaN(at.getTime())) throw bad("since must look like 7d, 12h or 2026-10-01");
    return at;
  };
  const mine = (s: Session): AccountRow[] => listAccounts(db).filter((a) => a.ownerEmail !== null && a.ownerEmail.toLowerCase() === s.email.toLowerCase());
  /** The person's own account, or a 404 that looks the same as "no such account". */
  const owned = (s: Session, runner: string, name: string): AccountRow => {
    const a = getAccount(db, `${runner}/${name}`);
    if (a === undefined || a.ownerEmail === null || a.ownerEmail.toLowerCase() !== s.email.toLowerCase()) throw NOT_FOUND;
    return a;
  };
  /** An admin reads and manages any account; a person only their own. Else the same 404. */
  const managed = (s: Session, runner: string, name: string): AccountRow => {
    if (!isAdmin(s)) return owned(s, runner, name);
    const a = getAccount(db, `${runner}/${name}`);
    if (a === undefined) throw NOT_FOUND;
    return a;
  };
  const visible = (s: Session): AccountRow[] => (isAdmin(s) ? listAccounts(db) : mine(s));
  /** The account ids a query may cover: undefined = every account, also the passes that found none (an admin). */
  const scope = (s: Session, account: string | undefined): string[] | undefined => {
    if (account !== undefined) {
      const [runner = "", ...rest] = account.split("/");
      return [managed(s, runner, rest.join("/")).id];
    }
    return isAdmin(s) ? undefined : mine(s).map((a) => a.id);
  };
  const view = (a: AccountRow): AccountView => {
    const h = getHealth(db, a.id);
    const health = healthOf(a, h, now());
    const dflt = envNum(SQUAD_FLOOR_DEFAULT_ENV, o.env);
    const lastCode = a.deadCode ?? h.lastFailCode;
    return {
      account: a.id, runner: a.runner, name: a.name, kind: a.kind, ownerEmail: a.ownerEmail ?? "", ...(a.loginEmail === null ? {} : { loginEmail: a.loginEmail }), pools: [], health,
      ...(health === "cooling" && h.coolUntil !== null ? { coolUntil: h.coolUntil } : {}),
      ...(lastCode === null ? {} : { lastCode }),
      ...(h.left5h === null ? {} : { left5h: h.left5h }),
      ...(h.leftWeek === null ? {} : { leftWeek: h.leftWeek }),
      ...(h.readAt === null ? {} : { readAt: h.readAt }),
      floor5h: a.floor5h ?? dflt, floorWeek: a.floorWeek ?? dflt, floorSource: a.floor5h !== null || a.floorWeek !== null ? "owner" : "default",
      ...(a.consentAt === null ? {} : { consentAt: a.consentAt }),
      busy: busyOf(a),
    };
  };
  /** The login module's refusals carry their own status; the API error is built here. */
  const refuse = <T,>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof LoginRefused) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  };
  const refuseAsync = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LoginRefused) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  };

  const real: Handlers = {
    me: ({ session }) => ({ email: session.email, name: session.name, admin: isAdmin(session) }),
    listAccounts: ({ session }) => visible(session).map(view),
    getAccount: ({ session, params }) => view(managed(session, params.runner, params.name)),
    setFloor: ({ session, params, body }) => {
      const a = managed(session, params.runner, params.name);
      setOwnerFloors(db, a.id, body.floor5h, body.floorWeek);
      return view(getAccount(db, a.id)!);
    },
    setEnabled: ({ session, params, body }) => {
      const a = managed(session, params.runner, params.name);
      // A dead account comes back only through a fresh login; a moved one lives in another home.
      if (a.state === "dead" || a.state === "moved") throw new HttpError(409, "conflict", `the account is ${a.state}`);
      setState(db, a.id, body.enabled ? "active" : "disabled");
      return view(getAccount(db, a.id)!);
    },
    consent: ({ session, params }) => {
      const a = owned(session, params.runner, params.name);
      setConsent(db, a.id, now());
      return view(getAccount(db, a.id)!);
    },
    startLogin: ({ session, params }) => {
      const a = owned(session, params.runner, params.name);
      return refuseAsync(() => logins.start(session.email, a));
    },
    loginStatus: ({ session, params }) => refuse(() => {
      try {
        return logins.status(session.email, params.loginId);
      } catch (e) {
        // A login id belongs to one of the two managers.
        if (e instanceof LoginRefused && e.status === 404) return setups.status(session.email, params.loginId);
        throw e;
      }
    }),
    submitLoginCode: ({ session, params, body }) => refuse(() => setups.submitCode(session.email, params.loginId, body.code)),
    usage: ({ session, query }) => {
      if (!(USAGE_BYS as readonly string[]).includes(query.by)) throw bad(`by must be one of ${USAGE_BYS.join(", ")}`);
      const since = sinceOf(query.since ?? "7d", "7d");
      return usageBy(db, query.by as UsageBy, since, scope(session, query.account)).map((r): ApiUsageRow => ({
        key: r.key, passes: r.passes, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, reasoning: r.reasoning,
        ...(r.costUsd === null ? {} : { costUsd: r.costUsd }),
        ...(r.cliCostUsd === null ? {} : { cliCostUsd: r.cliCostUsd }),
        ...(r.catalogCostUsd === null ? {} : { catalogCostUsd: r.catalogCostUsd }),
      }));
    },
    usageSeries: ({ session, query }) => {
      const since = sinceOf(query.since ?? "", query.by === "hour" ? "2d" : "30d");
      return usageSeries(db, query.by, since, scope(session, query.account)).map((r) => ({
        bucket: r.bucket, account: r.account, passes: r.passes, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, reasoning: r.reasoning,
        ...(r.costUsd === null ? {} : { costUsd: r.costUsd }),
        ...(r.cliCostUsd === null ? {} : { cliCostUsd: r.cliCostUsd }),
        ...(r.catalogCostUsd === null ? {} : { catalogCostUsd: r.catalogCostUsd }),
      }));
    },
    roomSeries: ({ session, params, query }) => {
      const a = managed(session, params.runner, params.name);
      return roomSince(db, a.id, sinceOf(query.since ?? "", "7d")).map((r): RoomPoint => ({
        at: r.at, source: r.source, ...(r.left5h === null ? {} : { left5h: r.left5h }), ...(r.leftWeek === null ? {} : { leftWeek: r.leftWeek }),
      }));
    },
    listPasses: ({ session, query }) => {
      const accounts = scope(session, query.account);
      const rows = listPassesPage(db, {
        limit: query.limit ?? PASS_LIMIT_DEFAULT,
        ...(accounts === undefined ? {} : { accounts }),
        ...(query.since === undefined ? {} : { since: sinceOf(query.since, "7d") }),
        ...(query.before === undefined ? {} : { before: query.before }),
      });
      return passViews(o.home, rows);
    },
    getPass: ({ session, params }) => {
      const row = PASS_ID.test(params.passId) ? getPassRow(db, params.passId) : undefined;
      // A pass that found no account has no owner: only an admin reads it.
      const owner = row?.account === null || row === undefined ? undefined : getAccount(db, row.account);
      if (row === undefined || !(isAdmin(session) || (owner !== undefined && owner.ownerEmail !== null && owner.ownerEmail.toLowerCase() === session.email.toLowerCase()))) throw new HttpError(404, "not-found", "no such pass");
      return passDetail(o.home, row);
    },
    listProviders: ({ session }) => {
      const used = new Map<string, number>();
      const bump = (id: string): void => void used.set(id, (used.get(id) ?? 0) + 1);
      for (const a of visible(session)) {
        if (a.runner === "pi") for (const id of piProvidersIn(join(o.home.accounts, "pi", a.name, "auth.json"))) bump(id);
        else bump(a.runner);
      }
      return providerEntries(loadProviders(o.home), allowedProviders(o.env)).map((e): ProviderView => ({
        id: e.id, name: e.name, runner: e.runner, kind: e.kind, ...(e.builtin === true ? { builtin: true as const } : {}), models: e.models, accounts: used.get(e.id) ?? 0,
      }));
    },
    addAccount: ({ session, body }) => {
      // The setting is enforced here, not only in the list the page shows.
      const wanted = body.runner === "pi" ? body.provider : body.runner;
      const entry = providerEntries(loadProviders(o.home), allowedProviders(o.env)).find((e) => e.id === wanted && e.runner === body.runner);
      if (entry === undefined) throw bad("this provider is not offered");
      if (body.runner === "codex") return refuseAsync(() => logins.startAdd(session.email, body.name));
      if (body.runner === "claude" && body.token === undefined) return refuseAsync(() => setups.start(session.email, body.name));
      if (envOn(SQUAD_DRY_RUN_ENV, o.env)) throw new HttpError(501, "disabled", "no account is written while SQUAD_DRY_RUN=1");
      if (!ACCOUNT_NAME.test(body.name)) throw bad("the name must be lower-case letters, digits, dot, dash or underscore, and start with a letter or digit");
      const secret = body.runner === "claude" ? body.token! : body.key;
      const why = secretShapeError(secret);
      if (why !== undefined) throw bad(why);
      const spec = { runner: body.runner, name: body.name, kind: entry.kind, ownerEmail: session.email.toLowerCase() };
      const files = body.runner === "claude"
        ? [{ name: "token", body: secret }]
        : [{ name: "auth.json", body: authJsonFor(body.provider, secret) }, ...(entry.source === undefined ? [] : [{ name: "models.json", body: modelsJsonFor(entry.source) }])];
      try {
        return view(createFileAccount(db, o.home, spec, files, now()));
      } catch (e) {
        if (e instanceof AccountExists) throw new HttpError(409, "conflict", e.message);
        throw e;
      }
    },
  };
  return { ...real, ...o.handlers };
}

// ---- static files ----

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
};

const BASE_CSP = "default-src 'self'; frame-ancestors 'none'";

/**
 * The CSP of a page: the base, plus the hash of each inline script and style the build made, plus
 * this answer's style nonce. Ant Design writes its styles at run time, so no hash can cover them;
 * it puts the nonce from the page's meta tag on each one.
 */
function pageCsp(html: string, nonce: string): string {
  const hashes = (tag: "script" | "style"): string[] => {
    const re = new RegExp(`<${tag}(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)</${tag}>`, "g");
    return [...html.matchAll(re)].filter((m) => m[1] !== "").map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
  };
  const s = hashes("script");
  const c = hashes("style");
  return `default-src 'self'${s.length > 0 ? `; script-src 'self' ${s.join(" ")}` : ""}; style-src 'self' 'nonce-${nonce}'${c.length > 0 ? ` ${c.join(" ")}` : ""}; frame-ancestors 'none'`;
}

/** The file for a request path, or undefined. It never leaves the root, also through a symlink. */
function fileFor(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  // Never source or debug files, even if a build left one in the root.
  if (/\.(d\.ts|mts|cts|ts|js\.map)$/i.test(decoded)) return undefined;
  const parts = decoded.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "..")) return undefined;
  const real = (p: string): string | undefined => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const base = real(root);
  if (base === undefined) return undefined;
  const found = real(join(base, ...parts));
  if (found !== undefined && (found === base || found.startsWith(base + sep)) && statSync(found).isFile()) return found;
  if (found !== undefined && found.startsWith(base) && statSync(found).isDirectory()) {
    const idx = real(join(found, "index.html"));
    if (idx !== undefined && idx.startsWith(base + sep)) return idx;
  }
  // A path with no file extension is a route of the client router.
  if (extname(parts.at(-1) ?? "") !== "") return undefined;
  const index = real(join(base, "index.html"));
  return index !== undefined && index.startsWith(base + sep) ? index : undefined;
}

// ---- the server ----

const REFUSAL: Record<FailReason, number> = {
  "no-login-cookie": 400, "provider-error": 400, "state-mismatch": 400, "token-endpoint": 502, "bad-id-token": 401, "email-unverified": 403, "not-in-group": 403,
};

export async function startWeb(opts: WebOpts): Promise<WebHandle> {
  const cfg = loadWebConfig(opts.env, opts.home);
  const log = opts.log ?? makeLog();
  const oidc = createOidc(cfg, opts.fetch === undefined ? {} : { fetch: opts.fetch });
  const docker = envOptional(SQUAD_DOCKER_ENV, opts.env)!;
  const real = dockerLoginRunner(opts.env, docker);
  const logins = new DeviceLogins({
    env: opts.env, home: opts.home, store: opts.store, log, now: opts.now ?? (() => new Date()), docker,
    user: process.getuid === undefined || process.getgid === undefined ? null : { uid: process.getuid(), gid: process.getgid() },
    start: opts.login?.start ?? real.start, stop: opts.login?.stop ?? real.stop,
    ...(opts.login?.timers === undefined ? {} : { timers: opts.login.timers }),
  });
  const realPty = dockerPtyRunner(opts.env, docker);
  const setups = new SetupTokenLogins({
    env: opts.env, home: opts.home, store: opts.store, log, now: opts.now ?? (() => new Date()), docker,
    user: process.getuid === undefined || process.getgid === undefined ? null : { uid: process.getuid(), gid: process.getgid() },
    start: opts.login?.pty?.start ?? realPty.start, stop: opts.login?.pty?.stop ?? realPty.stop,
    ...(opts.login?.timers === undefined ? {} : { timers: opts.login.timers }),
  });
  const handlers = makeHandlers(opts, logins, setups, cfg.adminGroup);
  const staticRoot = opts.staticDir ?? bundledPath("webapp");

  const csrfOk = (req: IncomingMessage): boolean => req.headers["x-squad-csrf"] === "1" && req.headers.origin === cfg.origin;

  function sendJson(res: ServerResponse, route: string, status: number, body: unknown): void {
    if (findForbidden(body) !== undefined) {
      log.error("response_refused", { route });
      status = 500;
      body = INTERNAL;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }
  const sendText = (res: ServerResponse, status: number, text: string, extra: Record<string, string | string[]> = {}): void => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text), ...extra });
    res.end(text);
  };
  const apiError = (res: ServerResponse, route: string, e: HttpError): void => sendJson(res, route, e.status, { error: e.code, message: e.message } satisfies ApiError);

  /** The JSON body, or undefined when there is none. Bytes past the limit are dropped, then 413. */
  const readBody = (req: IncomingMessage): Promise<string | HttpError> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
      });
      req.on("end", () => resolve(size > MAX_BODY ? new HttpError(413, "bad-request", "body too large") : Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(bad("cannot read the body")));
    });

  async function api(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL, setRoute: (r: string) => void): Promise<void> {
    let hit: { name: RouteName; params: Record<string, string> } | undefined;
    let pathMatched = false;
    try {
      for (const [name, route] of Object.entries(ROUTES) as [RouteName, (typeof ROUTES)[RouteName]][]) {
        const params = matchPath(route.path, pathname);
        if (params === undefined) continue;
        pathMatched = true;
        if (route.method === req.method) hit = { name, params };
      }
    } catch {
      return apiError(res, "api", bad("bad path"));
    }
    if (hit === undefined) {
      setRoute("api-unknown");
      return apiError(res, "api-unknown", pathMatched ? new HttpError(405, "bad-request", "method not allowed") : new HttpError(404, "not-found", "no such route"));
    }
    const name = hit.name;
    setRoute(name);
    const write = req.method !== "GET";
    if (write && !csrfOk(req)) return apiError(res, name, new HttpError(403, "forbidden", "missing or wrong csrf proof"));
    const session = oidc.readSession(req.headers.cookie);
    if (session === undefined) return apiError(res, name, new HttpError(401, "unauthenticated", "sign in first"));
    try {
      const input = INPUTS[name] as { query?: (q: URLSearchParams) => unknown; body?: (b: unknown) => unknown };
      let body: unknown;
      if (write) {
        const raw = await readBody(req);
        if (raw instanceof HttpError) return apiError(res, name, raw);
        if (input.body !== undefined) {
          if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw bad("content-type must be application/json");
          let json: unknown;
          try {
            json = JSON.parse(raw);
          } catch {
            throw bad("body is not JSON");
          }
          body = input.body(json);
        }
      }
      const query = input.query?.(url.searchParams);
      const handler = handlers[name] as (c: { params: unknown; query: unknown; body: unknown; session: Session }) => unknown;
      const out = await handler({ params: hit.params, query, body, session });
      sendJson(res, name, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return apiError(res, name, e);
      log.error("handler_failed", { route: name }); // the error text may hold anything, so it is not logged
      sendJson(res, name, 500, INTERNAL);
    }
  }

  async function auth(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL, setRoute: (r: string) => void): Promise<void> {
    setRoute(pathname.slice(1));
    const method = req.method;
    if (pathname === "/auth/login" || pathname === "/auth/callback") {
      if (method !== "GET") return sendText(res, 405, "method not allowed\n", { allow: "GET" });
    } else if (pathname === "/auth/logout") {
      if (method !== "POST") return sendText(res, 405, "method not allowed\n", { allow: "POST" });
      if (!csrfOk(req)) return sendText(res, 403, "forbidden\n");
      res.writeHead(204, { "set-cookie": oidc.clearSessionCookie() });
      return void res.end();
    } else {
      return sendText(res, 404, "not found\n");
    }
    if (pathname === "/auth/login") {
      try {
        const s = await oidc.startLogin(safeReturnPath(url.searchParams.get("to")));
        res.writeHead(302, { location: s.location, "set-cookie": s.setCookie });
        return void res.end();
      } catch (e) {
        // Only the fixed reason and an HTTP status are logged: the error text can hold a URL.
        log.error("signin_unavailable", e instanceof OidcError ? { reason: e.reason, status: e.status } : { reason: "unknown" });
        return sendText(res, 502, "sign-in unavailable\n");
      }
    }
    const done = await oidc.finishLogin(url.searchParams, req.headers.cookie);
    if (done.ok) {
      res.writeHead(302, { location: done.to, "set-cookie": [...done.setCookies] });
      return void res.end();
    }
    log.warn("signin_refused", { reason: done.reason });
    sendText(res, REFUSAL[done.reason], "sign-in refused\n", { "set-cookie": [...done.setCookies] });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed\n", { allow: "GET, HEAD" });
    const file = fileFor(staticRoot, pathname);
    if (file === undefined) return sendText(res, 404, "not found\n");
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const html = extname(file) === ".html";
    let data = readFileSync(file);
    if (html) {
      // A fresh nonce per answer: one that repeats would let an injected style reuse it.
      const nonce = randomBytes(16).toString("base64");
      const page = data.toString("utf8");
      res.setHeader("content-security-policy", pageCsp(page, nonce));
      data = Buffer.from(page.replace("<head>", `<head><meta name="csp-nonce" content="${nonce}">`), "utf8");
    }
    res.writeHead(200, {
      "content-type": type, "content-length": data.length,
      "cache-control": html ? "no-cache" : pathname.startsWith("/_astro/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  /** GET /logos/<id>.svg: public data, so no session; the cache bounds the rate. An SVG opened by itself can run no script. */
  async function serveLogo(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed\n", { allow: "GET, HEAD" });
    const m = /^\/logos\/([^/]+)\.svg$/.exec(pathname);
    // Read the raw value: an empty address means "no fetch", which envOptional would turn into the default.
    const url = opts.env[SQUAD_PRICES_URL_ENV.key] ?? SQUAD_PRICES_URL_ENV.default ?? "";
    const data = m === null ? undefined : await getLogo({ home: opts.home, url, id: m[1]!, now: (opts.now ?? (() => new Date()))().getTime(), fetch: opts.fetch ?? globalThis.fetch, env: opts.env });
    if (data === undefined) return sendText(res, 404, "not found\n");
    res.writeHead(200, {
      "content-type": "image/svg+xml", "content-length": data.length, "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "cache-control": "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  const server = createServer((req, res) => {
    const t0 = performance.now();
    let route = "static";
    let pathname = "/";
    res.on("finish", () => log.info("access", { method: req.method ?? "-", route, path: pathname.slice(0, 200), status: res.statusCode, ms: Math.round(performance.now() - t0) }));
    res.setHeader("content-security-policy", BASE_CSP);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    const fail = (): void => {
      if (!res.headersSent) sendJson(res, route, 500, INTERNAL);
      else res.end();
    };
    let url: URL;
    try {
      if (!(req.url ?? "").startsWith("/") || req.url!.startsWith("//")) throw new Error("not an origin-form target");
      url = new URL(req.url!, "http://squad.local");
    } catch {
      return sendText(res, 400, "bad request\n");
    }
    pathname = url.pathname;
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    const isAuth = pathname === "/auth" || pathname.startsWith("/auth/");
    if (isApi || isAuth) res.setHeader("cache-control", "no-store");
    const isLogo = pathname.startsWith("/logos/");
    if (isLogo) route = "logo";
    const run = isApi ? api(req, res, pathname, url, (r) => (route = r)) : isLogo ? serveLogo(req, res, pathname) : isAuth ? auth(req, res, pathname, url, (r) => (route = r)) : Promise.resolve(opts.apiOnly === true ? sendText(res, 404, "not found\n") : serveStatic(req, res, pathname));
    run.catch((e: unknown) => {
      log.error("request_failed", { route });
      void e;
      fail();
    });
  });
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : cfg.port;
  const probe = opts.probe;
  const ticker = probe === undefined ? undefined : startTicker({
    env: opts.env, home: opts.home, store: opts.store, log, now: opts.now ?? (() => new Date()), fetch: opts.fetch ?? globalThis.fetch, probe,
    ...(opts.apiOnly === undefined ? {} : { apiOnly: opts.apiOnly }), ...(opts.ticker?.timers === undefined ? {} : { timers: opts.ticker.timers }),
  });
  return {
    port, bind: cfg.bind, url: cfg.url,
    close: async () => {
      ticker?.stop();
      await Promise.all([
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
        logins.close(),
        setups.close(),
      ]);
    },
  };
}
