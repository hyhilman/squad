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
  /** The email of the seat that is logged in (the ID token's); it can differ from the owner. Unset for a key or token account. */
  readonly loginEmail?: string;
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
  /** Money only for `key` accounts; seats show room left instead. Equal to `catalogCostUsd` there. */
  readonly costUsd?: number;
  /** The sum of what each CLI said the pass cost (pi, claude). Unset when no pass in the group has one. */
  readonly cliCostUsd?: number;
  /** The sum of tokens times the catalog price at the pass time, for every kind of account. Unset when no pass has a price. */
  readonly catalogCostUsd?: number;
  /** For `window`: the drop in percent left that the pool's passes caused. */
  readonly used5hPct?: number;
  readonly usedWeekPct?: number;
}

/** One bucket of `usageSeries` for one account. `bucket` is the UTC start: `2026-10-24` or `2026-10-24T13:00:00Z`. */
export interface UsageSeriesPoint {
  readonly bucket: string;
  readonly account: string;
  readonly passes: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly costUsd?: number;
  readonly cliCostUsd?: number;
  readonly catalogCostUsd?: number;
}

/** One reading of the room left in an account's windows. */
export interface RoomPoint {
  readonly at: string;
  /** `read`: the usage read of a codex login. `pass`: the rate-limit event of a pass. */
  readonly source: "read" | "pass";
  readonly left5h?: number;
  readonly leftWeek?: number;
}

export interface PassTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

/** One pass as the history lists it. */
export interface PassView {
  readonly passId: string;
  /** Unset for a pass that found no account. */
  readonly account?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly caller: { readonly flow: string; readonly action: string };
  readonly task?: { readonly kind: string; readonly id: string };
  readonly model: string;
  /** Unset while the pass runs. */
  readonly outcome?: string;
  readonly failKind?: string;
  readonly failCode?: string;
  readonly tokens: PassTokens;
  readonly costUsd?: number;
  /** What the CLI itself said the pass cost (pi, claude). Unset for codex. */
  readonly cliCostUsd?: number;
  /** Tokens times the catalog price at the pass time. Unset when the catalog has no price for the model. */
  readonly catalogCostUsd?: number;
  /** The stored stream is still on disk. */
  readonly hasTranscript: boolean;
}

/** What the assistant said, parsed from the stored stream; never the raw stream. Secrets are `[hidden]`. */
export interface PassTranscript {
  readonly texts: readonly string[];
  readonly final: string;
}

export interface PassDetail extends PassView {
  readonly prompt?: string;
  readonly transcript?: PassTranscript;
  /** The prompt or the stream file is gone (cleaned up by age) though the pass should have kept it. */
  readonly expired?: true;
  /** The prompt or the transcript was cut at 256 KB. */
  readonly truncated?: true;
}

export interface SetFloorBody {
  /** Percent of each window left for the owner, 0 to 100. Null = back to the default. */
  readonly floor5h: number | null;
  readonly floorWeek: number | null;
}

/** A login the owner started from the web app. The page shows only a code or a link, never a token. */
export interface LoginStart {
  readonly loginId: string;
  /** The code the person types at the link (codex device login). Unset when `needsCode` is. */
  readonly userCode?: string;
  readonly verifyUrl: string;
  readonly expiresAt: string;
  /** The person signs in at the link, then pastes the code that page shows (claude setup-token). */
  readonly needsCode?: true;
}

export type LoginState = "pending" | "done" | "failed" | "expired";

export interface LoginStatus {
  readonly loginId: string;
  readonly state: LoginState;
  /** For `failed`: why, such as `seat-mismatch` (a re-login with another seat's email). */
  readonly reason?: string;
}

/** One provider the web app may offer when a person adds an account. */
export interface ProviderView {
  /** `codex`, `claude`, or a pi provider id such as `opencode-go`. */
  readonly id: string;
  readonly name: string;
  readonly runner: Runner;
  /** `login`: device login. `token`: a claude setup-token. `key`: an API key. */
  readonly kind: AccountKind;
  /** A provider pi knows by itself: only the key is written, no models.json. */
  readonly builtin?: true;
  /** How many models the catalog lists for it. */
  readonly models: number;
  /** How many accounts of this provider the person who asks can see. Codex and claude count by runner; a pi account by the providers in its auth.json. */
  readonly accounts: number;
}

/** What a person sends to add an account. The token and the key are shape-checked, never echoed. */
export type AddAccountBody =
  | { readonly runner: "codex"; readonly name: string }
  | { readonly runner: "claude"; readonly name: string; readonly token?: string }
  | { readonly runner: "pi"; readonly name: string; readonly provider: string; readonly key: string };

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
  submitLoginCode: { method: "POST", path: "/api/logins/:loginId/code" },
  usage: { method: "GET", path: "/api/usage" },
  usageSeries: { method: "GET", path: "/api/usage/series" },
  roomSeries: { method: "GET", path: "/api/accounts/:runner/:name/room" },
  listPasses: { method: "GET", path: "/api/passes" },
  getPass: { method: "GET", path: "/api/passes/:passId" },
  addAccount: { method: "POST", path: "/api/accounts" },
  listProviders: { method: "GET", path: "/api/providers" },
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
  /** Gives a claude setup-token login the code the sign-in page showed. One try. The code is never echoed or logged. */
  submitLoginCode: { params: { readonly loginId: string }; query: void; body: { readonly code: string }; res: LoginStatus };
  usage: { params: void; query: { readonly by: UsageBy; readonly since?: string; readonly account?: string }; body: void; res: readonly UsageRow[] };
  usageSeries: { params: void; query: { readonly by: "day" | "hour"; readonly since?: string; readonly account?: string }; body: void; res: readonly UsageSeriesPoint[] };
  roomSeries: { params: AccountParams; query: { readonly since?: string }; body: void; res: readonly RoomPoint[] };
  listPasses: { params: void; query: { readonly account?: string; readonly since?: string; readonly limit?: number; readonly before?: string }; body: void; res: readonly PassView[] };
  getPass: { params: { readonly passId: string }; query: void; body: void; res: PassDetail };
  /**
   * codex: starts a device login for a NEW account (the answer is a LoginStart; the account exists once the login ends well).
   * claude with no token: starts a setup-token sign-in on the server (the answer is a LoginStart with `needsCode`).
   * claude with a token, or pi with a provider and a key: writes the account at once (the answer is its AccountView).
   * The person who is signed in owns it.
   */
  addAccount: { params: void; query: void; body: AddAccountBody; res: LoginStart | AccountView };
  listProviders: { params: void; query: void; body: void; res: readonly ProviderView[] };
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
