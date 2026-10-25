// `squad web`: the HTTP server. It serves exactly the contract's ROUTES under /api, the OIDC sign-in
// under /auth, and the built web app as static files.
//
// A person sees only the accounts whose owner email is theirs; any other id is a 404, so ids do not
// leak. An admin (the ID token's groups hold SQUAD_OIDC_ADMIN_GROUP) sees every account and may set
// floors, key caps and a key's entered balance, enable or disable, test, reset the health of and remove any of them; consent, login, a new
// secret and a limit reset stay with the owner. Every JSON answer passes `findForbidden` first. An answer or a log line never holds a token,
// a cookie, the client secret or the session key.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { bundledPath } from "../paths.ts";
import { AUTH_PATHS, CAP_MAX_USD, isAccountUserEmail, LIMIT_RESET_WHICH, NO_SESSION_ROUTES, ROUTES, SIGNED_OUT_PATH, SIGNED_OUT_SQUAD_ONLY, type LogoutEverywhere, findForbidden, matchPath, type AccountView, type LimitResetWhich, type ProviderView, type Api, type ApiError, type ErrorCode, type RoomPoint, type RouteName, type UsageRow as ApiUsageRow } from "@squad/contract";
import { AccountExists, createFileAccount, secretShapeError } from "../accounts/add.ts";
import { catalogCtx, catalogModelCompare, catalogProviderDetail, catalogProviderList, isModelIdParam, isProviderIdParam, priceHistory } from "../catalog.ts";
import { getLogo } from "../logos.ts";
import { loadProviders } from "../prices.ts";
import { authJsonFor, modelsJsonFor, piProvidersIn, providerEntries } from "../providers.ts";
import { getAccount, getHealth, listAccounts, resetHealth, roomSince, setOwnerBalance, setOwnerCaps, setOwnerFloors, setSharing, setState, type AccountRow } from "../accounts/store.ts";
import { removeAccount, replacePiKey, replaceToken, revokeNote } from "../accounts/care.ts";
import { servedModels } from "../accounts/serves.ts";
import { TOKEN_EXACT } from "../claude-token.ts";
import type { HomeLayout } from "../home.ts";
import { makeLog, type Log } from "../log.ts";
import { flockBusy, lockPathOf } from "../run.ts";
import { ACCOUNT_NAME } from "../accounts/store.ts";
import { SQUAD_DOCKER_ENV, SQUAD_DRY_RUN_ENV, SQUAD_PRICES_URL_ENV, SQUAD_PROBE_MODEL_CLAUDE_ENV, SQUAD_PROBE_MODEL_CODEX_ENV, SQUAD_PROBE_MODEL_PI_ENV, envOn, envOptional, type EnvSpec } from "../settings.ts";
import type { Store } from "../store/db.ts";
import { USAGE_BYS, getPassRow, listPassesPage, usageBy, usageSeries, type UsageBy } from "../usage/report.ts";
import { ConnectPairs, clientKeyOf, squadVersion } from "./connect.ts";
import { DeviceLogins, LoginRefused, dockerLoginRunner, type LoginRunner, type LoginTimers } from "./device-login.ts";
import { createOidc, OidcError, safeReturnPath, type FailReason, type Session } from "./oidc.ts";
import { accountView } from "./account-view.ts";
import { passDetail, passViews } from "./passes.ts";
import { SQUAD_WEB_BRAND_DIR_ENV, allowedProviders, loadWebConfig } from "./settings.ts";
import { SetupTokenLogins, codeShapeError, dockerPtyRunner, type PtyRunner } from "./setup-token.ts";
import { LimitResets } from "./limit-reset.ts";
import { startTicker, type Timers } from "./ticker.ts";
import type { ProbeLimits, ProbeOutcome } from "../cli/squad.ts";

type NoSession = (typeof NO_SESSION_ROUTES)[number];
export interface Ctx<N extends RouteName> {
  readonly params: Api[N]["params"];
  readonly query: Api[N]["query"];
  readonly body: Api[N]["body"];
  /** A route in NO_SESSION_ROUTES has none. */
  readonly session: N extends NoSession ? undefined : Session;
  /**
   * Who the client is, for a rate limit: the peer address, or the tunnel's `cf-connecting-ip` when the
   * peer is loopback (clientKeyOf). Never used to grant anything.
   */
  readonly ip: string;
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
  readonly probe?: (account: AccountRow, model: string, limits?: ProbeLimits) => Promise<ProbeOutcome | void>;
  /** Replaces the loop's timers. For tests only. */
  readonly ticker?: { readonly timers?: Timers };
  /** Replaces the docker calls of a web login, and its timers. For tests only. */
  readonly login?: Partial<LoginRunner> & { readonly timers?: LoginTimers; readonly pty?: PtyRunner };
  /** Replaces the terminal of the limit reset. For tests only. */
  readonly limitPty?: PtyRunner;
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
/** The connect token route takes one token: a much smaller body is plenty. */
const MAX_TOKEN_BODY = 8 * 1024;
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

const cap = (v: unknown): number | null => {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= CAP_MAX_USD) return v;
  throw bad(`a cap is dollars above 0 and at most ${CAP_MAX_USD}, or null`);
};

const balance = (v: unknown): number | null => {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= CAP_MAX_USD) return v;
  throw bad(`a balance is dollars from 0 to ${CAP_MAX_USD}, or null`);
};

type Inputs = { [N in RouteName]: { query?: (q: URLSearchParams) => Api[N]["query"]; body?: (b: unknown) => Api[N]["body"] } };
const INPUTS: Inputs = {
  me: {}, getAccount: {}, startLogin: {}, loginStatus: {}, getPass: {}, connectStatus: {},
  startConnect: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["runner", "name", "replace"]) || b.runner !== "claude" || typeof b.name !== "string" || (b.replace !== undefined && b.replace !== true)) throw bad('body must be {runner: "claude", name[, replace: true]}');
      return { runner: "claude", name: b.name, ...(b.replace === true ? { replace: true as const } : {}) };
    },
  },
  connectToken: {
    // The token is secret: the message is fixed, nothing from the body is echoed.
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["token", "email"]) || typeof b.token !== "string" || (b.email !== undefined && !isAccountUserEmail(b.email))) throw bad("body must be {token[, email]}");
      return { token: b.token, ...(b.email === undefined ? {} : { email: b.email as string }) };
    },
  },
  submitLoginCode: {
    // The code is secret and short-lived: the message is fixed, nothing from the body is echoed.
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["code"]) || typeof b.code !== "string" || codeShapeError(b.code) !== undefined) throw bad("body must be {code}, 1 to 512 visible characters with no space");
      return { code: b.code };
    },
  },
  listProviders: {}, catalogProviders: {}, catalogProvider: {}, catalogModel: {},
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
  setCaps: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["cap5h", "capWeek", "cap30d"]) || !("cap5h" in b) || !("capWeek" in b) || !("cap30d" in b)) throw bad("body must be {cap5h, capWeek, cap30d}");
      return { cap5h: cap(b.cap5h), capWeek: cap(b.capWeek), cap30d: cap(b.cap30d) };
    },
  },
  setBalance: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["balance"]) || !("balance" in b)) throw bad("body must be {balance}");
      return { balance: balance(b.balance) };
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
      if (!isObj(b) || !onlyKeys(b, ["agree"]) || typeof b.agree !== "boolean") throw bad("body must be {agree: boolean}");
      return { agree: b.agree };
    },
  },
  // ---- account care ----
  listAccounts: { query: (q) => (q.get("all") === "1" ? { all: "1" as const } : {}) },
  accountModels: {},
  resetHealth: {},
  testAccount: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["model"]) || (b.model !== undefined && (typeof b.model !== "string" || b.model.length > 200))) throw bad("body must be {model?: string}");
      return b.model === undefined ? {} : { model: b.model };
    },
  },
  removeAccount: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["confirm"]) || typeof b.confirm !== "string") throw bad("body must be {confirm: \"<runner>/<name>\"}");
      return { confirm: b.confirm };
    },
  },
  replaceSecret: {
    // The secret may be in the body: the messages are fixed, nothing from it is echoed.
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["secret", "provider"]) || typeof b.secret !== "string" || (b.provider !== undefined && typeof b.provider !== "string")) throw bad("body must be {secret[, provider]}");
      return { secret: b.secret, ...(typeof b.provider === "string" ? { provider: b.provider } : {}) };
    },
  },
  limitReset: {
    body: (b) => {
      if (!isObj(b) || !onlyKeys(b, ["which"]) || !(LIMIT_RESET_WHICH as readonly unknown[]).includes(b.which)) throw bad(`body must be {which}, one of ${LIMIT_RESET_WHICH.join(", ")}`);
      return { which: b.which as LimitResetWhich };
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

const PROBE_MODEL: Readonly<Record<string, EnvSpec>> = { codex: SQUAD_PROBE_MODEL_CODEX_ENV, claude: SQUAD_PROBE_MODEL_CLAUDE_ENV, pi: SQUAD_PROBE_MODEL_PI_ENV };
/** One test pass per account in this time. */
export const TEST_EVERY_MS = 60_000;
/**
 * The Test pass answers an open HTTP request. Behind the Cloudflare tunnel the browser gets a 524
 * after about 100 s, so the deadline, plus the stop's grace time (20 s by default) and the kill's
 * 2 s, stays under that. A deadline answers the failure kind `timeout`.
 */
export const TEST_LIMITS = { idleMs: 45_000, deadlineMs: 60_000 } as const;

function makeHandlers(o: WebOpts, logins: DeviceLogins, setups: SetupTokenLogins, connects: ConnectPairs, resets: LimitResets, adminGroup: string | undefined): Handlers {
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
  // A removed account's history is still the owner's to read.
  const mine = (s: Session): AccountRow[] => listAccounts(db, undefined, { withRemoved: true }).filter((a) => a.ownerEmail !== null && a.ownerEmail.toLowerCase() === s.email.toLowerCase());
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
  const visible = (s: Session, withRemoved = false): AccountRow[] => (isAdmin(s) ? listAccounts(db, undefined, { withRemoved }) : mine(s).filter((a) => withRemoved || a.state !== "removed"));
  /** Marks the passes of an account that was removed since. */
  const marked = <V extends { readonly account?: string }>(v: V): V => (v.account !== undefined && getAccount(db, v.account)?.state === "removed" ? { ...v, accountRemoved: true as const } : v);
  /** The account ids a query may cover: undefined = every account, also the passes that found none (an admin). */
  const scope = (s: Session, account: string | undefined): string[] | undefined => {
    if (account !== undefined) {
      const [runner = "", ...rest] = account.split("/");
      return [managed(s, runner, rest.join("/")).id];
    }
    return isAdmin(s) ? undefined : mine(s).map((a) => a.id);
  };
  const view = (a: AccountRow): AccountView => accountView({ db, env: o.env, now: now(), busy: busyOf }, a);
  /** A removed or moved account takes no act: it is history here. */
  const live = (a: AccountRow): AccountRow => {
    if (a.state === "removed" || a.state === "moved") throw new HttpError(409, "conflict", `the account is ${a.state}`);
    return a;
  };
  const tested = new Map<string, number>();
  /** The login module's refusals carry their own status; the API error is built here. */
  const refuse = <T,>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof LoginRefused) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  };
  const offered = (runner: string, id: string) => providerEntries(loadProviders(o.home), allowedProviders(o.env)).find((e) => e.id === id && e.runner === runner);
  const refuseAsync = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LoginRefused) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  };

  /** How many accounts of each provider the person sees: codex and claude by runner, pi by the providers in auth.json. */
  const usedProviders = (s: Session): Map<string, number> => {
    const used = new Map<string, number>();
    const bump = (id: string): void => void used.set(id, (used.get(id) ?? 0) + 1);
    for (const a of visible(s)) {
      if (a.runner === "pi") for (const id of piProvidersOf(a)) bump(id);
      else bump(a.runner);
    }
    return used;
  };
  const piProvidersOf = (a: AccountRow): string[] => piProvidersIn(join(o.home.accounts, "pi", a.name, "auth.json"));
  const catalogOf = (s: Session) => {
    const catalog = loadProviders(o.home);
    return { catalog, ctx: catalogCtx(providerEntries(catalog, allowedProviders(o.env)), usedProviders(s)) };
  };
  const HISTORY_DAYS = 90;

  const real: Handlers = {
    me: ({ session }) => ({ email: session.email, name: session.name, admin: isAdmin(session) }),
    listAccounts: ({ session, query }) => visible(session, query.all === "1").map(view),
    getAccount: ({ session, params }) => view(managed(session, params.runner, params.name)),
    setFloor: ({ session, params, body }) => {
      const a = live(managed(session, params.runner, params.name));
      setOwnerFloors(db, a.id, body.floor5h, body.floorWeek);
      return view(getAccount(db, a.id)!);
    },
    setCaps: ({ session, params, body }) => {
      const a = live(managed(session, params.runner, params.name));
      if (a.kind !== "key") throw bad("dollar caps are for a key account only; a seat has floors");
      setOwnerCaps(db, a.id, body.cap5h, body.capWeek, body.cap30d);
      return view(getAccount(db, a.id)!);
    },
    setBalance: ({ session, params, body }) => {
      const a = live(managed(session, params.runner, params.name));
      if (a.kind !== "key") throw bad("a balance is for a key account only");
      setOwnerBalance(db, a.id, body.balance, now());
      return view(getAccount(db, a.id)!);
    },
    setEnabled: ({ session, params, body }) => {
      const a = live(managed(session, params.runner, params.name));
      // A dead account comes back only through a fresh login; a moved one lives in another home.
      if (a.state === "dead" || a.state === "moved") throw new HttpError(409, "conflict", `the account is ${a.state}`);
      setState(db, a.id, body.enabled ? "active" : "disabled");
      return view(getAccount(db, a.id)!);
    },
    consent: ({ session, params, body }) => {
      const a = live(owned(session, params.runner, params.name));
      setSharing(db, a.id, body.agree ? session.email.toLowerCase() : null, now());
      return view(getAccount(db, a.id)!);
    },
    startLogin: ({ session, params }) => {
      const a = live(owned(session, params.runner, params.name));
      if (a.runner === "claude" && a.kind === "token") return refuseAsync(() => setups.startReplace(session.email, a));
      if (a.runner === "pi") throw bad("a pi key account takes a new key (Replace key); for a pi login run `squad login` on the host");
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
      return passViews(o.home, rows).map(marked);
    },
    getPass: ({ session, params }) => {
      const row = PASS_ID.test(params.passId) ? getPassRow(db, params.passId) : undefined;
      // A pass that found no account has no owner: only an admin reads it.
      const owner = row?.account === null || row === undefined ? undefined : getAccount(db, row.account);
      if (row === undefined || !(isAdmin(session) || (owner !== undefined && owner.ownerEmail !== null && owner.ownerEmail.toLowerCase() === session.email.toLowerCase()))) throw new HttpError(404, "not-found", "no such pass");
      return marked(passDetail(o.home, row));
    },
    listProviders: ({ session }) => {
      const used = usedProviders(session);
      return providerEntries(loadProviders(o.home), allowedProviders(o.env)).map((e): ProviderView => ({
        id: e.id, name: e.name, runner: e.runner, kind: e.kind, ...(e.builtin === true ? { builtin: true as const } : {}), models: e.models, accounts: used.get(e.id) ?? 0,
      }));
    },
    startConnect: ({ session, body }) => {
      if (offered(body.runner, body.runner) === undefined) throw bad("this provider is not offered");
      return refuse(() => connects.start(session.email, body.name, body.replace === true));
    },
    connectStatus: ({ session, params }) => refuse(() => connects.status(session.email, params.connectId)),
    connectToken: ({ ip, params, body }) => refuse(() => connects.redeem(ip, params.pairCode, body.token, body.email)),
    catalogProviders: ({ session }) => {
      const { catalog, ctx } = catalogOf(session);
      return catalogProviderList(catalog, ctx);
    },
    catalogProvider: ({ session, params }) => {
      if (!isProviderIdParam(params.provider)) throw bad("a provider id is a letter or digit, then up to 63 letters, digits, dots, dashes or underscores");
      const { catalog, ctx } = catalogOf(session);
      const d = catalogProviderDetail(catalog, params.provider, ctx);
      if (d === undefined) throw new HttpError(404, "not-found", "no such provider in the catalog");
      return d;
    },
    catalogModel: ({ session, params }) => {
      if (!isModelIdParam(params.modelId)) throw bad("a model id is 1 to 200 visible characters");
      const { catalog, ctx } = catalogOf(session);
      const first = catalogModelCompare(catalog, params.modelId, ctx, []);
      if (first === undefined) throw new HttpError(404, "not-found", "no such model in the catalog");
      const since = new Date(now().getTime() - HISTORY_DAYS * 86_400_000);
      return { ...first, history: priceHistory(db, first.offers, since) };
    },
    addAccount: ({ session, body }) => {
      // The setting is enforced here, not only in the list the page shows.
      const entry = offered(body.runner, body.runner === "pi" ? body.provider : body.runner);
      if (entry === undefined) throw bad("this provider is not offered");
      if (body.runner === "codex") return refuseAsync(() => logins.startAdd(session.email, body.name));
      if (body.runner === "claude" && body.token === undefined) return refuseAsync(() => setups.start(session.email, body.name));
      if (envOn(SQUAD_DRY_RUN_ENV, o.env)) throw new HttpError(501, "disabled", "no account is written while SQUAD_DRY_RUN=1");
      if (!ACCOUNT_NAME.test(body.name)) throw bad("the name must be lower-case letters, digits, dot, dash or underscore, and start with a letter or digit");
      const secret = body.runner === "claude" ? body.token! : body.key;
      const why = secretShapeError(secret);
      if (why !== undefined) throw bad(why);
      const spec = { runner: body.runner, name: body.name, kind: entry.kind, ownerEmail: session.email.toLowerCase(), consent: { by: session.email.toLowerCase() } };
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
    // ---- account care ----
    accountModels: ({ session, params }) => {
      const a = managed(session, params.runner, params.name);
      const dflt = PROBE_MODEL[a.runner] === undefined ? undefined : envOptional(PROBE_MODEL[a.runner]!, o.env);
      return { models: servedModels(o.home, a, loadProviders(o.home)), ...(dflt === undefined ? {} : { defaultModel: dflt }) };
    },
    testAccount: async ({ session, params, body }) => {
      const a = live(managed(session, params.runner, params.name));
      if (o.probe === undefined || envOn(SQUAD_DRY_RUN_ENV, o.env)) throw new HttpError(501, "disabled", "this server runs no test pass");
      const served = servedModels(o.home, a, loadProviders(o.home));
      const dflt = PROBE_MODEL[a.runner] === undefined ? undefined : envOptional(PROBE_MODEL[a.runner]!, o.env);
      const model = body.model !== undefined && served.includes(body.model) ? body.model : dflt;
      if (model === undefined) throw bad("pick a model: this account has no default test model");
      const t = now().getTime();
      const last = tested.get(a.id);
      if (last !== undefined && t - last < TEST_EVERY_MS) throw new HttpError(429, "too-many", "one test per account per minute");
      // Counted when it starts, so a second click while the first runs is refused too.
      tested.set(a.id, t);
      const res = await o.probe(a, model, TEST_LIMITS);
      if (res === undefined) throw new HttpError(501, "disabled", "this server runs no test pass");
      const h = getHealth(db, a.id);
      return {
        ok: res.failure === undefined, model: res.model, ms: res.ms,
        ...(res.failure === undefined ? {} : { failureKind: res.failure.kind, ...(res.failure.code === "" ? {} : { failureCode: res.failure.code }) }),
        ...(h.left5h === null ? {} : { left5h: h.left5h }), ...(h.leftWeek === null ? {} : { leftWeek: h.leftWeek }),
      };
    },
    removeAccount: async ({ session, params, body }) => {
      const a = live(managed(session, params.runner, params.name));
      if (body.confirm !== a.id) throw bad("confirm must be the account id, <runner>/<name>");
      if (envOn(SQUAD_DRY_RUN_ENV, o.env)) throw new HttpError(501, "disabled", "nothing is removed while SQUAD_DRY_RUN=1");
      if ((await removeAccount(o.store, o.home, a, now())) === "busy") throw new HttpError(409, "conflict", "a pass is using this account: try again when it ends");
      return { account: a.id, revoke: revokeNote(a) };
    },
    resetHealth: ({ session, params }) => {
      const a = live(managed(session, params.runner, params.name));
      if (resetHealth(db, a.id) === "log-in-again") throw new HttpError(409, "conflict", `the login was revoked (${a.deadCode}): log in again`);
      return view(getAccount(db, a.id)!);
    },
    replaceSecret: ({ session, params, body }) => {
      const a = live(owned(session, params.runner, params.name));
      if (envOn(SQUAD_DRY_RUN_ENV, o.env)) throw new HttpError(501, "disabled", "no account is written while SQUAD_DRY_RUN=1");
      const why = secretShapeError(body.secret);
      if (why !== undefined) throw bad(why);
      const by = session.email.toLowerCase();
      if (a.runner === "claude" && a.kind === "token") {
        if (!TOKEN_EXACT.test(body.secret)) throw bad("a claude token is the sk-ant-oat01- token that `claude setup-token` prints");
        // A pasted token says nothing about whose seat it is.
        replaceToken(o.store, o.home, a, body.secret, by, now(), null);
      } else if (a.runner === "pi" && a.kind === "key") {
        const r = replacePiKey(o.store, o.home, a, body.provider, body.secret, by, now());
        if (r === "pick-provider") throw bad("this account has keys for several providers: say which one");
        if (r === "unknown-provider") throw bad("this account has no key for that provider");
      } else throw bad("only a claude token account or a pi key account takes a new secret here; log in again instead");
      return view(getAccount(db, a.id)!);
    },
    limitReset: async ({ session, params, body }) => {
      const a = live(owned(session, "claude", params.name));
      const r = await refuseAsync(() => resets.run(a, body.which));
      if (r === "busy") throw new HttpError(409, "conflict", "a pass is using this account: try again when it ends");
      return r;
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
function pageCsp(html: string, nonce: string, frameAncestors: string): string {
  const hashes = (tag: "script" | "style"): string[] => {
    const re = new RegExp(`<${tag}(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)</${tag}>`, "g");
    return [...html.matchAll(re)].filter((m) => m[1] !== "").map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
  };
  const s = hashes("script");
  const c = hashes("style");
  return `default-src 'self'${s.length > 0 ? `; script-src 'self' ${s.join(" ")}` : ""}; style-src 'self' 'nonce-${nonce}'${c.length > 0 ? ` ${c.join(" ")}` : ""}; frame-ancestors ${frameAncestors}`;
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
  // A path with no known file type is a route of the client router: a model id such as qwen3.8-max
  // looks like it has an extension.
  if (TYPES[extname(parts.at(-1) ?? "").toLowerCase()] !== undefined) return undefined;
  const index = real(join(base, "index.html"));
  return index !== undefined && index.startsWith(base + sep) ? index : undefined;
}

// ---- brand files ----

/** The only names a brand folder may replace, and the other logo each may stand in for. */
const BRAND_NAMES: Readonly<Record<string, readonly string[]>> = {
  "logo-light.png": ["logo-light.png", "logo-dark.png"],
  "logo-dark.png": ["logo-dark.png", "logo-light.png"],
  "favicon.ico": ["favicon.ico"],
  "apple-touch-icon.png": ["apple-touch-icon.png"],
};
const BRAND_MAX_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_MAGIC = Buffer.from([0, 0, 1, 0]);

/**
 * One file of the brand folder, or undefined. The folder is the operator's, but the same rules as the
 * built app hold: nothing outside it (also through a symlink), a plain file, at most 2 MB, and bytes
 * that start as the image its name says.
 */
function brandFile(dir: string, name: string): Buffer | undefined {
  try {
    const base = realpathSync(dir);
    const found = realpathSync(join(base, name));
    if (!found.startsWith(base + sep)) return undefined;
    const st = statSync(found);
    if (!st.isFile() || st.size > BRAND_MAX_BYTES) return undefined;
    const data = readFileSync(found);
    if (data.length > BRAND_MAX_BYTES) return undefined;
    const magic = name.endsWith(".ico") ? ICO_MAGIC : PNG_MAGIC;
    return data.subarray(0, magic.length).equals(magic) ? data : undefined;
  } catch {
    return undefined;
  }
}

// ---- the server ----

/** A path under /api/connect/ with a pair code in it: `/api/connect/<code>/...`. Matched by prefix, so a wrong method or a longer path counts too. */
const isPairPath = (p: string): boolean => /^\/api\/connect\/[^/]*\/./.test(p);
/** The path as the access log keeps it: a pair code is a credential, so its segment is hidden. */
const logPath = (p: string): string => (isPairPath(p) ? p.replace(/^\/api\/connect\/[^/]*/, "/api/connect/[hidden]") : p);

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
  const connects = new ConnectPairs({ env: opts.env, home: opts.home, store: opts.store, log, now: opts.now ?? (() => new Date()), origin: cfg.origin, version: squadVersion() });
  const resets = new LimitResets({
    env: opts.env, home: opts.home, store: opts.store, log, now: opts.now ?? (() => new Date()), docker,
    user: process.getuid === undefined || process.getgid === undefined ? null : { uid: process.getuid(), gid: process.getgid() },
    start: opts.limitPty?.start ?? realPty.start, stop: opts.limitPty?.stop ?? realPty.stop,
  });
  const handlers = makeHandlers(opts, logins, setups, connects, resets, cfg.adminGroup);
  const staticRoot = opts.staticDir ?? bundledPath("webapp");

  const csrfOk = (req: IncomingMessage): boolean => req.headers["x-squad-csrf"] === "1" && req.headers.origin === cfg.origin;
  // /api writes may also come from a listed origin. /auth/logout keeps the strict check.
  const apiOrigin = (req: IncomingMessage): string | undefined => {
    const o = req.headers.origin;
    return o !== undefined && cfg.apiOrigins.includes(o) ? o : undefined;
  };
  const apiCsrfOk = (req: IncomingMessage): boolean => req.headers["x-squad-csrf"] === "1" && (req.headers.origin === cfg.origin || apiOrigin(req) !== undefined);
  const CORS_METHODS = [...new Set(Object.values(ROUTES).map((r) => r.method))].join(", ");

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
  const readBody = (req: IncomingMessage, max: number): Promise<string | HttpError> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= max) chunks.push(c);
      });
      req.on("end", () => resolve(size > max ? new HttpError(413, "bad-request", "body too large") : Buffer.concat(chunks).toString("utf8")));
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
    // squad connect is no browser: it has no cookie for CSRF to guard, and its pair code is the proof.
    const open = (NO_SESSION_ROUTES as readonly RouteName[]).includes(name);
    if (write && !open && !apiCsrfOk(req)) return apiError(res, name, new HttpError(403, "forbidden", "missing or wrong csrf proof"));
    const session = open ? undefined : oidc.readSession(req.headers.cookie);
    if (!open && session === undefined) return apiError(res, name, new HttpError(401, "unauthenticated", "sign in first"));
    try {
      const input = INPUTS[name] as { query?: (q: URLSearchParams) => unknown; body?: (b: unknown) => unknown };
      let body: unknown;
      if (write) {
        const raw = await readBody(req, open ? MAX_TOKEN_BODY : MAX_BODY);
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
      const handler = handlers[name] as (c: { params: unknown; query: unknown; body: unknown; session: Session | undefined; ip: string }) => unknown;
      const out = await handler({ params: hit.params, query, body, session, ip: clientKeyOf(req.socket.remoteAddress ?? "", req.headers["cf-connecting-ip"]) });
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
    } else if (pathname === AUTH_PATHS.logout) {
      if (method !== "POST") return sendText(res, 405, "method not allowed\n", { allow: "POST" });
      if (!csrfOk(req)) return sendText(res, 403, "forbidden\n");
      res.writeHead(204, { "set-cookie": oidc.clearSessionCookie() });
      return void res.end();
    } else if (pathname === AUTH_PATHS.logoutEverywhere) {
      // A page move cannot carry the csrf header, so this is a POST that answers where to go next,
      // and the page goes there itself.
      if (method !== "POST") return sendText(res, 405, "method not allowed\n", { allow: "POST" });
      if (!csrfOk(req)) return sendText(res, 403, "forbidden\n");
      res.setHeader("set-cookie", oidc.clearSessionCookie());
      let end: string | undefined;
      try {
        end = await oidc.endSessionUrl();
      } catch (e) {
        // squad's session is over either way; the page says the provider's may not be.
        log.warn("end_session_unavailable", e instanceof OidcError ? { reason: e.reason } : { reason: "unknown" });
      }
      const body: LogoutEverywhere = end === undefined ? { to: `${SIGNED_OUT_PATH}?${SIGNED_OUT_SQUAD_ONLY}`, provider: false } : { to: end, provider: true };
      return sendJson(res, "auth/logout/everywhere", 200, body);
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

  const brandDir = envOptional(SQUAD_WEB_BRAND_DIR_ENV, opts.env);

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed\n", { allow: "GET, HEAD" });
    const asked = pathname.startsWith("/brand/") ? pathname.slice("/brand/".length) : "";
    const brand = brandDir !== undefined && Object.hasOwn(BRAND_NAMES, asked) ? BRAND_NAMES[asked] : undefined;
    if (brand !== undefined) {
      for (const name of brand) {
        const data = brandFile(brandDir!, name);
        if (data === undefined) continue;
        res.writeHead(200, { "content-type": TYPES[extname(name)]!, "content-length": data.length, "cache-control": "no-cache" });
        return void res.end(req.method === "HEAD" ? undefined : data);
      }
    }
    const file = fileFor(staticRoot, pathname);
    if (file === undefined) return sendText(res, 404, "not found\n");
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const html = extname(file) === ".html";
    let data = readFileSync(file);
    if (html) {
      // A fresh nonce per answer: one that repeats would let an injected style reuse it.
      const nonce = randomBytes(16).toString("base64");
      const page = data.toString("utf8");
      res.setHeader("content-security-policy", pageCsp(page, nonce, cfg.frameAncestors));
      // The loader shows before any script runs, so only the request can say it is in a frame. A
      // framed loader is see-through, so the parent page shows behind it.
      const framed = req.headers["sec-fetch-dest"] === "iframe";
      res.setHeader("vary", "sec-fetch-dest");
      const marked = framed ? page.replace(/<html(?=[\s>])/, '<html data-framed=""') : page;
      data = Buffer.from(marked.replace("<head>", `<head><meta name="csp-nonce" content="${nonce}">`), "utf8");
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
    res.on("finish", () => log.info("access", { method: req.method ?? "-", route, path: logPath(pathname).slice(0, 200), status: res.statusCode, ms: Math.round(performance.now() - t0) }));
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
    // The helper's token route never gets CORS: no page of any origin may send it a token.
    if (isApi && !isPairPath(pathname)) {
      const allowed = apiOrigin(req);
      if (allowed !== undefined) {
        // The reply depends on Origin, so a shared cache must key on it.
        res.setHeader("vary", "origin");
        res.setHeader("access-control-allow-origin", allowed);
        res.setHeader("access-control-allow-credentials", "true");
        if (req.method === "OPTIONS") {
          route = "api-preflight";
          res.writeHead(204, { "access-control-allow-methods": CORS_METHODS, "access-control-allow-headers": "content-type, x-squad-csrf", "access-control-max-age": "600" });
          return void res.end();
        }
      }
    }
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
        resets.close(),
      ]);
    },
  };
}
