// The HTTP API between `squad web` (the backend) and the web app (the frontend). Both import this
// file, so a change to a route or a shape breaks the type check on both sides at once.
//
// Every route is one entry in ROUTES (method and path) and one entry in Api (its params, query, body
// and response). The backend serves exactly these routes; the frontend calls them through `call`.
//
// No shape here may carry a token, a refresh token or an auth file. `findForbidden` (secrets.ts)
// enforces it at run time on every response.

/** Who is signed in, from the OIDC ID token. */
export interface Me {
  readonly email: string;
  /** The display name from the ID token; unset when the token had none. */
  readonly name?: string;
  /** An admin sees and sets every account; an owner only their own. */
  readonly admin: boolean;
}

export type Runner = "claude" | "codex" | "pi" | "dsh";
export type AccountKind = "login" | "key" | "token";
export type Health = "ok" | "suspect" | "cooling" | "dead" | "disabled" | "moved";

/** One account as the web app shows it. */
export interface AccountView {
  /** `<runner>/<name>`, such as `codex/alice`. */
  readonly account: string;
  readonly runner: Runner;
  readonly name: string;
  readonly kind: AccountKind;
  readonly ownerEmail: string;
  readonly pools: readonly string[];
  readonly health: Health;
  readonly coolUntil?: string;
  /** The last exact failure code, such as `token_revoked`. */
  readonly lastCode?: string;
  /** Percent left in each window from the latest usage read; unset = no read. */
  readonly left5h?: number;
  readonly leftWeek?: number;
  readonly readAt?: string;
  /** The floors in force, and whether the owner set them or they are the default. */
  readonly floor5h: number;
  readonly floorWeek: number;
  readonly floorSource: "default" | "owner";
  readonly consentAt?: string;
  /** A pass holds it now. */
  readonly busy: boolean;
}

export type UsageBy = "project" | "flow" | "action" | "task" | "session" | "account" | "model" | "day" | "window";

export interface UsageRow {
  /** The group's value, such as an account or a day. */
  readonly key: string;
  readonly passes: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  /** Money only for `key` accounts; seats show room left instead. */
  readonly costUsd?: number;
  /** For `window`: the drop in percent left that the pool's passes caused. */
  readonly used5hPct?: number;
  readonly usedWeekPct?: number;
}

export interface SetFloorBody {
  /** Percent of each window left for the owner, 0 to 100. Null = back to the default. */
  readonly floor5h: number | null;
  readonly floorWeek: number | null;
}

/** A login the owner started from the web app. The page shows only the user code, never a token. */
export interface LoginStart {
  readonly loginId: string;
  readonly userCode: string;
  readonly verifyUrl: string;
  readonly expiresAt: string;
}

export type LoginState = "pending" | "done" | "failed" | "expired";

export interface LoginStatus {
  readonly loginId: string;
  readonly state: LoginState;
  /** For `failed`: why, such as `owner-mismatch` (the login belongs to another email). */
  readonly reason?: string;
}

export type ErrorCode = "unauthenticated" | "forbidden" | "not-found" | "bad-request" | "conflict" | "disabled" | "internal";

export interface ApiError {
  readonly error: ErrorCode;
  readonly message: string;
}

/** The routes. A path param is `:name`. */
export const ROUTES = {
  me: { method: "GET", path: "/api/me" },
  listAccounts: { method: "GET", path: "/api/accounts" },
  getAccount: { method: "GET", path: "/api/accounts/:runner/:name" },
  setFloor: { method: "PUT", path: "/api/accounts/:runner/:name/floor" },
  setEnabled: { method: "PUT", path: "/api/accounts/:runner/:name/enabled" },
  consent: { method: "POST", path: "/api/accounts/:runner/:name/consent" },
  startLogin: { method: "POST", path: "/api/accounts/:runner/:name/login" },
  loginStatus: { method: "GET", path: "/api/logins/:loginId" },
  usage: { method: "GET", path: "/api/usage" },
} as const satisfies Record<string, { readonly method: "GET" | "POST" | "PUT" | "DELETE"; readonly path: `/api/${string}` }>;

export type RouteName = keyof typeof ROUTES;

type AccountParams = { readonly runner: Runner; readonly name: string };

/** What each route takes and gives. `void` = nothing. */
export interface Api {
  me: { params: void; query: void; body: void; res: Me };
  listAccounts: { params: void; query: void; body: void; res: readonly AccountView[] };
  getAccount: { params: AccountParams; query: void; body: void; res: AccountView };
  setFloor: { params: AccountParams; query: void; body: SetFloorBody; res: AccountView };
  setEnabled: { params: AccountParams; query: void; body: { readonly enabled: boolean }; res: AccountView };
  consent: { params: AccountParams; query: void; body: { readonly agree: true }; res: AccountView };
  startLogin: { params: AccountParams; query: void; body: void; res: LoginStart };
  loginStatus: { params: { readonly loginId: string }; query: void; body: void; res: LoginStatus };
  usage: { params: void; query: { readonly by: UsageBy; readonly since?: string; readonly account?: string }; body: void; res: readonly UsageRow[] };
}

// Every route has a type entry, and every type entry a route.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const routesMatchApi: Same<RouteName, keyof Api> = true;
void routesMatchApi;

/** The path of a route with its params filled in, each one URL-encoded. */
export function pathOf(path: string, params: Readonly<Record<string, string>> | void): string {
  return path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
    const v = params?.[key];
    if (v === undefined || v === "") throw new Error(`missing path param ${key} for ${path}`);
    return encodeURIComponent(v);
  });
}

/** Matches a request path against a route path; returns the decoded params, or undefined. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) {
      if (g === "") return undefined;
      params[w.slice(1)] = decodeURIComponent(g);
    } else if (w !== g) {
      return undefined;
    }
  }
  return params;
}
