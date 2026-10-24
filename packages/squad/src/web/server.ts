// `squad web`: the HTTP server. It serves exactly the contract's ROUTES under /api, the OIDC sign-in
// under /auth, and the built web app as static files.
//
// A person sees only the accounts whose owner email is theirs; any other id is a 404, so ids do not
// leak. Every JSON answer passes `findForbidden` first. An answer or a log line never holds a token,
// a cookie, the client secret or the session key.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { bundledPath } from "../paths.ts";
import { ROUTES, findForbidden, matchPath, type AccountView, type Api, type ApiError, type ErrorCode, type RouteName, type UsageRow as ApiUsageRow } from "@squad/contract";
import { getAccount, getHealth, healthOf, listAccounts, setConsent, setOwnerFloors, setState, type AccountRow } from "../accounts/store.ts";
import type { HomeLayout } from "../home.ts";
import { makeLog, type Log } from "../log.ts";
import { flockBusy, lockPathOf } from "../run.ts";
import { SQUAD_DOCKER_ENV, SQUAD_FLOOR_DEFAULT_ENV, envNum, envOptional } from "../settings.ts";
import type { Store } from "../store/db.ts";
import { USAGE_BYS, usageBy, type UsageBy } from "../usage/report.ts";
import { DeviceLogins, LoginRefused, dockerLoginRunner, type LoginRunner, type LoginTimers } from "./device-login.ts";
import { createOidc, OidcError, safeReturnPath, type FailReason, type Session } from "./oidc.ts";
import { loadWebConfig } from "./settings.ts";
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
  readonly login?: Partial<LoginRunner> & { readonly timers?: LoginTimers };
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
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const floor = (v: unknown): number | null => {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) return v;
  throw bad("a floor is a number from 0 to 100, or null");
};

type Inputs = { [N in RouteName]: { query?: (q: URLSearchParams) => Api[N]["query"]; body?: (b: unknown) => Api[N]["body"] } };
const INPUTS: Inputs = {
  me: {}, listAccounts: {}, getAccount: {}, startLogin: {}, loginStatus: {},
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

function makeHandlers(o: WebOpts, logins: DeviceLogins): Handlers {
  const db = o.store.db;
  const now = o.now ?? (() => new Date());
  const busyOf = o.busy ?? ((a: AccountRow): boolean => {
    if (a.kind !== "login") return false;
    const lock = lockPathOf(o.home, a);
    return existsSync(lock) && flockBusy(lock);
  });
  const mine = (s: Session): AccountRow[] => listAccounts(db).filter((a) => a.ownerEmail !== null && a.ownerEmail.toLowerCase() === s.email.toLowerCase());
  /** The person's own account, or a 404 that looks the same as "no such account". */
  const owned = (s: Session, runner: string, name: string): AccountRow => {
    const a = getAccount(db, `${runner}/${name}`);
    if (a === undefined || a.ownerEmail === null || a.ownerEmail.toLowerCase() !== s.email.toLowerCase()) throw NOT_FOUND;
    return a;
  };
  const view = (a: AccountRow): AccountView => {
    const h = getHealth(db, a.id);
    const health = healthOf(a, h, now());
    const dflt = envNum(SQUAD_FLOOR_DEFAULT_ENV, o.env);
    const lastCode = a.deadCode ?? h.lastFailCode;
    return {
      account: a.id, runner: a.runner, name: a.name, kind: a.kind, ownerEmail: a.ownerEmail ?? "", pools: [], health,
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
    me: ({ session }) => ({ email: session.email, name: session.name, admin: false }),
    listAccounts: ({ session }) => mine(session).map(view),
    getAccount: ({ session, params }) => view(owned(session, params.runner, params.name)),
    setFloor: ({ session, params, body }) => {
      const a = owned(session, params.runner, params.name);
      setOwnerFloors(db, a.id, body.floor5h, body.floorWeek);
      return view(getAccount(db, a.id)!);
    },
    setEnabled: ({ session, params, body }) => {
      const a = owned(session, params.runner, params.name);
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
    loginStatus: ({ session, params }) => refuse(() => logins.status(session.email, params.loginId)),
    usage: ({ session, query }) => {
      if (!(USAGE_BYS as readonly string[]).includes(query.by)) throw bad(`by must be one of ${USAGE_BYS.join(", ")}`);
      const spec = query.since ?? "7d";
      const rel = SINCE.exec(spec);
      const since = rel !== null ? new Date(now().getTime() - Number(rel[1]) * (rel[2] === "d" ? 86_400_000 : 3_600_000)) : /^\d{4}-\d{2}-\d{2}/.test(spec) ? new Date(spec) : new Date(NaN);
      if (Number.isNaN(since.getTime())) throw bad("since must look like 7d, 12h or 2026-10-01");
      let ids = mine(session).map((a) => a.id);
      if (query.account !== undefined) {
        const [runner = "", ...rest] = query.account.split("/");
        ids = [owned(session, runner, rest.join("/")).id];
      }
      return usageBy(db, query.by as UsageBy, since, ids).map((r): ApiUsageRow => ({
        key: r.key, passes: r.passes, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, reasoning: r.reasoning,
        ...(r.costUsd === null ? {} : { costUsd: r.costUsd }),
      }));
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

/** The CSP of a page: the base, plus the hash of each inline script and style the build made. */
function pageCsp(html: string): string {
  const hashes = (tag: "script" | "style"): string[] => {
    const re = new RegExp(`<${tag}(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)</${tag}>`, "g");
    return [...html.matchAll(re)].filter((m) => m[1] !== "").map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
  };
  const s = hashes("script");
  const c = hashes("style");
  return `default-src 'self'${s.length > 0 ? `; script-src 'self' ${s.join(" ")}` : ""}${c.length > 0 ? `; style-src 'self' ${c.join(" ")}` : ""}; frame-ancestors 'none'`;
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
  const handlers = makeHandlers(opts, logins);
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
    const data = readFileSync(file);
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const html = extname(file) === ".html";
    if (html) res.setHeader("content-security-policy", pageCsp(data.toString("utf8")));
    res.writeHead(200, {
      "content-type": type, "content-length": data.length,
      "cache-control": html ? "no-cache" : pathname.startsWith("/_astro/") ? "public, max-age=31536000, immutable" : "no-cache",
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
    const run = isApi ? api(req, res, pathname, url, (r) => (route = r)) : isAuth ? auth(req, res, pathname, url, (r) => (route = r)) : Promise.resolve(opts.apiOnly === true ? sendText(res, 404, "not found\n") : serveStatic(req, res, pathname));
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
      ]);
    },
  };
}
