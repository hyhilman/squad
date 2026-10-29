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
export type Health = "ok" | "suspect" | "cooling" | "dead" | "disabled" | "moved" | "removed";

/** One account as the web app shows it. */
export interface AccountView {
  /** `<runner>/<name>`, such as `codex/alice`. */
  readonly account: string;
  readonly runner: Runner;
  readonly name: string;
  readonly kind: AccountKind;
  readonly ownerEmail: string;
  /**
   * The account user: the email of the provider account this is (a codex ID token's, or what claude's
   * setup-token left in its config). It can differ from the owner. Unset when squad could not read it:
   * a pi key, a pasted claude token.
   */
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
  // ---- account care (consent, reset, week badge) ----
  /** The owner shares it: the pool may run passes on it. False = squad refuses every pass on it. */
  readonly sharing: boolean;
  /** Who gave the consent: an email, `cli` or `migration`. Unset while not sharing. */
  readonly consentBy?: string;
  /** When each window resets, from the latest read. */
  readonly resets5h?: string;
  readonly resetsWeek?: string;
  /** "Reset health" would be taken: cooling, suspect, or dead without a permanent code. */
  readonly canResetHealth: boolean;
  // ---- key use: a key account only (kind `key`) ----
  /**
   * Dollars this key used in squad's own passes over the last 5 hours, 7 days and 30 days. Use outside
   * squad does not count: squad cannot see it. Unset for a seat (a login or a token account).
   */
  readonly used5h?: number;
  readonly usedWeek?: number;
  readonly used30d?: number;
  /**
   * The owner's caps in dollars, per window, on a key account. When the used sum of a window reaches its
   * cap, the pool stops picking the key. Unset = no cap (the default).
   */
  readonly cap5h?: number;
  readonly capWeek?: number;
  readonly cap30d?: number;
  /**
   * The balance the owner typed from the provider's console, in dollars, and when (ISO). squad never asks a
   * provider for a balance. Unset when none is entered, and always for a seat. Display only: the pool
   * never reads it.
   */
  readonly balanceUsd?: number;
  readonly balanceAt?: string;
  /**
   * An estimate: balanceUsd minus what squad's own passes used since balanceAt. It may go below 0. Use
   * outside squad does not count: squad cannot see it.
   */
  readonly balanceLeft?: number;
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
  /** The account was removed after this pass. */
  readonly accountRemoved?: true;
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

/** The highest dollar cap the API takes. */
export const CAP_MAX_USD = 1_000_000;

export interface SetCapsBody {
  /** Dollars above 0, at most CAP_MAX_USD, for a key account only. Null = no cap in that window. */
  readonly cap5h: number | null;
  readonly capWeek: number | null;
  readonly cap30d: number | null;
}

export interface SetBalanceBody {
  /** Dollars from 0 to CAP_MAX_USD, for a key account only. Null = no balance. Setting one stamps the time. */
  readonly balance: number | null;
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

/** Dollars per million tokens, as the catalog gives them. A cache price is unset when the catalog has none. */
export interface CatalogPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** One provider of squad's saved copy of the catalog. */
export interface CatalogProviderView {
  /** The catalog id, such as `opencode-go`, `openai` or `anthropic`. */
  readonly id: string;
  readonly name: string;
  /** The runner that serves it: `openai` runs on codex, `anthropic` on claude, the rest on pi. */
  readonly runner: Runner;
  /** A person may add an account of it now. */
  readonly offered: boolean;
  /** The ProviderView id to pick in Add account (`codex` for `openai`). Set only when it is offered. */
  readonly addAs?: string;
  /** Its models, embedding models left out. */
  readonly models: number;
  /** How many accounts that use it the person who asks can see, counted as listProviders counts them. */
  readonly accounts: number;
  /** The price of its model with the lowest input price (then the lowest output price). Unset when it has no model. */
  readonly cheapest?: { readonly input: number; readonly output: number };
}

/** One model of one catalog provider. Embedding models are left out. */
export interface CatalogModelView {
  readonly id: string;
  /** The catalog's canonical id, such as `meta/muse-wonder-1.0`, when it gives one. */
  readonly canonical?: string;
  /** The catalog name, or the id when it has none. */
  readonly name: string;
  readonly reasoning: boolean;
  /** The context window and the most output tokens, when the catalog gives them. */
  readonly context?: number;
  readonly maxOutput?: number;
  /** What it takes in, such as `["text", "image"]`. */
  readonly inputs: readonly string[];
  /** null when the catalog has no price (the saved copy keeps only priced models, so it is rare). */
  readonly price: CatalogPrice | null;
  /** How many other catalog providers list the same model: the same canonical id, or the same id when one of the two has no canonical id. */
  readonly otherProviders: number;
}

export interface CatalogProviderDetail {
  readonly provider: CatalogProviderView;
  /** Sorted by name, then id. */
  readonly models: readonly CatalogModelView[];
}

/** One provider that lists a model, for the compare page. */
export interface CatalogOffer {
  readonly provider: string;
  /** The model's id at this provider. It can differ from the asked id when the canonical id matched. */
  readonly modelId: string;
  readonly providerName: string;
  readonly runner: Runner;
  readonly offered: boolean;
  readonly addAs?: string;
  readonly accounts: number;
  readonly price: CatalogPrice | null;
  readonly context?: number;
  readonly maxOutput?: number;
  /** The lowest input price of all offers (then the lowest output price). Ties are all cheapest. */
  readonly cheapest: boolean;
}

/** One price_history row: the price a provider asked from this time on. */
export interface CatalogPricePoint {
  readonly provider: string;
  /** The model's id at this provider. */
  readonly modelId: string;
  readonly at: string;
  readonly input: number;
  readonly output: number;
}

/**
 * One model across the catalog. The asked id is a model id or a canonical id. Models match by their
 * canonical id (so kenari's `muse-wonder-1-0` meets opencode's `muse-wonder-1.0`), or by the exact
 * id when one of the two has no canonical id.
 */
export interface CatalogModelCompare {
  /** The id that was asked for. */
  readonly modelId: string;
  /** The canonical id the offers share, when they have one. */
  readonly canonical?: string;
  readonly name: string;
  /** Sorted by input price, then output price, then provider id. */
  readonly offers: readonly CatalogOffer[];
  /** The last 90 days, oldest first. */
  readonly history: readonly CatalogPricePoint[];
}

/** What a person sends to add an account. The token and the key are shape-checked, never echoed. */
export type AddAccountBody =
  | { readonly runner: "codex"; readonly name: string }
  | { readonly runner: "claude"; readonly name: string; readonly token?: string }
  | { readonly runner: "pi"; readonly name: string; readonly provider: string; readonly key: string };

/**
 * A "use my computer" claude sign-in: the person runs `squad connect` on their own computer, where the
 * real CLI opens their browser. The helper sends the token once, with the pair code as its only proof.
 */
export interface ConnectStart {
  readonly connectId: string;
  /** Single use, valid until `expiresAt`, bound to the person and the name. The server keeps only its hash. */
  readonly pairCode: string;
  readonly expiresAt: string;
  /** The command to run with no install: `npx` of the release tarball. */
  readonly command: string;
  /** The same command for a computer that has squad installed. */
  readonly shortCommand: string;
}

export interface ConnectStatus {
  readonly connectId: string;
  readonly state: LoginState;
  /** For `failed`: why, such as `exists` (an account with this name came first). */
  readonly reason?: string;
  /** For `done`: the new account, `claude/<name>`. */
  readonly account?: string;
}

export type ErrorCode = "unauthenticated" | "forbidden" | "not-found" | "bad-request" | "conflict" | "disabled" | "too-many" | "internal";

export interface ApiError {
  readonly error: ErrorCode;
  readonly message: string;
}

// ---- account care ----

export interface AccountModels {
  /** Model ids the account serves, as a pass names them. */
  readonly models: readonly string[];
  /** SQUAD_PROBE_MODEL_<RUNNER>, used when no model is picked. */
  readonly defaultModel?: string;
}

export interface TestResult {
  readonly ok: boolean;
  readonly model: string;
  readonly failureKind?: string;
  readonly failureCode?: string;
  readonly ms: number;
  readonly left5h?: number;
  readonly leftWeek?: number;
}

export interface RemoveResult {
  readonly account: string;
  /** Where to revoke the login or key at the provider. Text only. */
  readonly revoke: string;
}

/** A claude token (`secret`), or a pi key with the provider it is for. */
export interface ReplaceSecretBody {
  readonly secret: string;
  readonly provider?: string;
}

/** The arguments the CLI's `/limit-reset` takes (its argument hint). */
export const LIMIT_RESET_WHICH = ["5-hour", "weekly", "full", "fable"] as const;
export type LimitResetWhich = (typeof LIMIT_RESET_WHICH)[number];

export interface LimitResetResult {
  /** `unknown`: the CLI said nothing squad knows; a reset may or may not have been used. */
  readonly outcome: "done" | "not-available" | "needs-login" | "unknown";
  /** squad's own words for the outcome; never the screen. */
  readonly message: string;
}

/** The routes. A path param is `:name`. */
/**
 * The backend's sign-in routes. They sit outside ROUTES: they answer with redirects and cookies, not
 * through `call`. Each POST wants the same csrf proof as an /api write.
 */
export const AUTH_PATHS = {
  login: "/auth/login",
  logout: "/auth/logout",
  /** Ends squad's session and answers LogoutEverywhere: where to send the browser next. */
  logoutEverywhere: "/auth/logout/everywhere",
  /** The hub's backend vouches for a person with a signed ticket (`?ticket=`); only when squad has an embed key. */
  embed: "/auth/embed",
} as const;

/** The app's signed-out page. Sign out and Sign out everywhere both end here. */
export const SIGNED_OUT_PATH = "/signed-out";
/** On the signed-out page: the provider had no end-session link, so only squad's session ended. */
export const SIGNED_OUT_SQUAD_ONLY = "provider=none";
/** On the signed-out page: the provider's own sign-out opened in a new tab. */
export const SIGNED_OUT_PROVIDER_TAB = "provider=tab";

export interface LogoutEverywhere {
  /** The provider's end-session URL, or the signed-out page when the provider has none. */
  readonly to: string;
  /** True when `to` ends the provider's session too. */
  readonly provider: boolean;
}

export const ROUTES = {
  me: { method: "GET", path: "/api/me" },
  listAccounts: { method: "GET", path: "/api/accounts" },
  getAccount: { method: "GET", path: "/api/accounts/:runner/:name" },
  setFloor: { method: "PUT", path: "/api/accounts/:runner/:name/floor" },
  setCaps: { method: "PUT", path: "/api/accounts/:runner/:name/caps" },
  setBalance: { method: "PUT", path: "/api/accounts/:runner/:name/balance" },
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
  startConnect: { method: "POST", path: "/api/connect" },
  connectStatus: { method: "GET", path: "/api/connect/:connectId" },
  connectToken: { method: "POST", path: "/api/connect/:pairCode/token" },
  // ---- account care ----
  accountModels: { method: "GET", path: "/api/accounts/:runner/:name/models" },
  testAccount: { method: "POST", path: "/api/accounts/:runner/:name/test" },
  removeAccount: { method: "DELETE", path: "/api/accounts/:runner/:name" },
  resetHealth: { method: "POST", path: "/api/accounts/:runner/:name/reset" },
  replaceSecret: { method: "PUT", path: "/api/accounts/:runner/:name/secret" },
  limitReset: { method: "POST", path: "/api/accounts/claude/:name/limit-reset" },
  catalogProviders: { method: "GET", path: "/api/catalog/providers" },
  catalogProvider: { method: "GET", path: "/api/catalog/providers/:provider" },
  catalogModel: { method: "GET", path: "/api/catalog/models/:modelId" },
} as const satisfies Record<string, { readonly method: "GET" | "POST" | "PUT" | "DELETE"; readonly path: `/api/${string}` }>;

export type RouteName = keyof typeof ROUTES;

/**
 * Routes that take no session and no CSRF proof: `squad connect` runs outside any browser, and its pair
 * code is the proof. The server never sets CORS headers on them, and never logs their path.
 */
/** An email squad shows as an account user: one "@", no space, at most 254 characters. */
export const isAccountUserEmail = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(v);

export const NO_SESSION_ROUTES = ["connectToken"] as const satisfies readonly RouteName[];

type AccountParams = { readonly runner: Runner; readonly name: string };

/** What each route takes and gives. `void` = nothing. */
export interface Api {
  me: { params: void; query: void; body: void; res: Me };
  /** `all=1` also lists removed accounts. */
  listAccounts: { params: void; query: { readonly all?: "1" }; body: void; res: readonly AccountView[] };
  getAccount: { params: AccountParams; query: void; body: void; res: AccountView };
  setFloor: { params: AccountParams; query: void; body: SetFloorBody; res: AccountView };
  /** Owner or admin, the same as floors. A key account only; any other kind is a 400. */
  setCaps: { params: AccountParams; query: void; body: SetCapsBody; res: AccountView };
  /** Owner or admin, the same as caps. A key account only; any other kind is a 400. */
  setBalance: { params: AccountParams; query: void; body: SetBalanceBody; res: AccountView };
  setEnabled: { params: AccountParams; query: void; body: { readonly enabled: boolean }; res: AccountView };
  /** The owner only. `agree: false` stops sharing: squad then refuses every pass on the account. */
  consent: { params: AccountParams; query: void; body: { readonly agree: boolean }; res: AccountView };
  /** The owner only. codex login: a device login (the seat must match). claude token: a setup-token sign-in that replaces the token. */
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
  /** Starts a "use my computer" claude sign-in for a NEW account the person will own, or (`replace`) a new token for their own token account. */
  startConnect: { params: void; query: void; body: { readonly runner: "claude"; readonly name: string; readonly replace?: true }; res: ConnectStart };
  /** The owner only; anyone else gets 404. */
  connectStatus: { params: { readonly connectId: string }; query: void; body: void; res: ConnectStatus };
  /**
   * The helper sends the token once. No session: the pair code in the path is the proof. A wrong,
   * used or expired code is a 404 with no detail. The token is checked by shape, never echoed.
   * `email`: the account user, when the helper's claude wrote one (isAccountUserEmail); never required.
   */
  connectToken: { params: { readonly pairCode: string }; query: void; body: { readonly token: string; readonly email?: string }; res: { readonly account: string } };
  // ---- account care ----
  /** The models a test may use: what the account serves, and the probe default. Owner or admin. */
  accountModels: { params: AccountParams; query: void; body: void; res: AccountModels };
  /** One tiny real pass, the same as `squad probe`. Owner or admin; one per account per minute (429). */
  testAccount: { params: AccountParams; query: void; body: { readonly model?: string }; res: TestResult };
  /** Owner or admin. `confirm` must be the account id. A running pass is a 409. The history stays. */
  removeAccount: { params: AccountParams; query: void; body: { readonly confirm: string }; res: RemoveResult };
  /** Owner or admin. Clears cooling and suspect. A dead account with a permanent code is a 409: log in again. */
  resetHealth: { params: AccountParams; query: void; body: void; res: AccountView };
  /** The owner only: a new claude token or a new pi key. Checked by shape, never echoed. */
  replaceSecret: { params: AccountParams; query: void; body: ReplaceSecretBody; res: AccountView };
  /** The owner only: the real claude CLI's `/limit-reset <which>` on the account. It spends a reset. */
  limitReset: { params: { readonly name: string }; query: void; body: { readonly which: LimitResetWhich }; res: LimitResetResult };
  /** Every provider of the saved catalog, sorted by name. Empty when squad has no saved copy. */
  catalogProviders: { params: void; query: void; body: void; res: readonly CatalogProviderView[] };
  catalogProvider: { params: { readonly provider: string }; query: void; body: void; res: CatalogProviderDetail };
  /** `modelId`: a model id or a canonical id, 1 to 200 visible characters; it may hold dots, colons and slashes (pathOf encodes them). */
  catalogModel: { params: { readonly modelId: string }; query: void; body: void; res: CatalogModelCompare };
}

// ---- provider mode: `squad serve` ----
//
// `squad serve` is a separate local listener (a unix socket or 127.0.0.1) for machine callers. It
// serves exactly SERVE_ROUTES, and `squad web` serves none of them. Two of its paths are also web
// paths with other shapes (GET /api/accounts, GET /api/passes/:passId), so the routes live in their
// own table. Every call carries `Authorization: Bearer <project token>`. A refusal is a status of 300
// or more with the JSON `{ "error": "<reason>" }`.

/** The runners a pass may name. */
export type PassRunner = "claude" | "codex" | "pi";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type FailureKind = "quota" | "rate-limit" | "auth" | "provider" | "idle" | "timeout" | "no-account" | "busy";

export interface Failure {
  readonly kind: FailureKind;
  /** The exact provider code or HTTP status, or "" when there is none. `lost`: squad serve restarted and the container was gone. */
  readonly code: string;
  readonly message: string;
}

/** The same five counts as PassTokens. */
export type Usage = PassTokens;

/** Who the commits of the pass are by: GIT_AUTHOR_* and GIT_COMMITTER_* in the container. */
export interface Identity {
  readonly name: string;
  readonly email: string;
}

/** A folder that holds `SKILL.md`. `name` is also the folder name the CLI sees. */
export interface SkillRef {
  readonly name: string;
  readonly dir: string;
}

/** A host path the caller wants inside the container. */
export interface ExtraMount {
  readonly host: string;
  readonly container: string;
  readonly ro: boolean;
}

/**
 * The setup fields a pass and a conversation take. Every host path (cwd, gitDir, skill.dir, each
 * mount host) must exist and sit inside one of the token's roots after symlinks are resolved.
 */
export interface ServeSetup {
  readonly model: string;
  readonly cwd: string;
  /** The main repo's .git; default `<cwd>/.git`. A linked worktree must pass it. */
  readonly gitDir?: string;
  readonly caller: { readonly flow: string; readonly action: string };
  readonly task?: { readonly kind: string; readonly id: string };
  readonly env?: Readonly<Record<string, string>>;
  readonly system?: string;
  readonly skill?: SkillRef;
  readonly effort?: Effort;
  readonly mounts?: readonly ExtraMount[];
  /** squad's own image when unset. Any other image must be in the token's image list. */
  readonly image?: string;
  readonly container?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly identity: Identity;
}

/** POST /api/passes: squad's PassRequest without `onOutput` and `pool`, plus the identity. The account must be one of the token's. */
export interface ServePassBody extends ServeSetup {
  readonly runner: PassRunner;
  /** `pi/alice` or `alice`. Unset: squad picks one of the token's accounts of the runner, as it picks from a pool. */
  readonly account?: string;
  readonly prompt: string;
  /** A pi session id. A conversation's id is not one: use its turns route. */
  readonly session?: string;
  readonly idleMs?: number;
  readonly deadlineMs?: number;
}

/** POST /api/conversations: squad's OpenRequest plus the identity. */
export interface ServeOpenBody extends ServeSetup {
  readonly runner: PassRunner;
  /** `pi/alice` or `alice`. */
  readonly account: string;
}

/** POST /api/conversations/:id/turns. */
export interface ServeTurnBody {
  readonly message: string;
  readonly idleMs?: number;
  readonly deadlineMs?: number;
  readonly identity: Identity;
}

export interface PassResult {
  readonly passId: string;
  readonly account: string | null;
  readonly text: string;
  readonly texts: readonly string[];
  readonly turns: number;
  /** The model the stream reported, else null. */
  readonly model: string | null;
  readonly usage: Usage;
  readonly failure?: Failure;
  readonly logPath: string | null;
}

export interface Conversation {
  readonly id: string;
  readonly runner: string;
  /** `<runner>/<name>`. */
  readonly account: string;
  readonly model: string;
  readonly cwd: string;
  readonly createdAt: string;
}

export interface TurnResult {
  readonly passId: string;
  readonly account: string;
  readonly text: string;
  readonly texts: readonly string[];
  readonly turns: number;
  readonly model: string | null;
  readonly usage: Usage;
  readonly failure?: Failure;
  /** Set when this turn ended the conversation, so the caller can open again on another account. */
  readonly closed?: "first-turn-refused";
}

/** One account as `squad serve` shows it: no owner or account-user email. */
export type ServeAccountView = Omit<AccountView, "ownerEmail" | "loginEmail" | "consentBy">;

/** GET /api/passes/:passId on `squad serve`. */
export type PassStatus =
  | { readonly running: true; readonly passId: string; readonly account: string | null; readonly startedAt: string }
  | { readonly running: false; readonly result: PassResult | TurnResult };

/** The first line of a stream: the pass row is written. Poll GET /api/passes/:passId with this id after a dropped connection. */
export interface StartedLine {
  readonly type: "started";
  readonly passId: string;
}
/** A piece of the CLI's stdout as it came, secrets masked. */
export interface OutputLine {
  readonly type: "output";
  readonly chunk: string;
}
/** The last line. After "started", every failure arrives here as `result.failure`, never as a status. */
export interface ResultLine<R> {
  readonly type: "result";
  readonly result: R;
}
export type PassLine = StartedLine | OutputLine | ResultLine<PassResult>;
export type TurnLine = StartedLine | OutputLine | ResultLine<TurnResult>;
/** The line types a client knows. A client skips any other type, so a new one breaks nobody. */
export const LINE_TYPES = ["started", "output", "result"] as const;
export const NDJSON = "application/x-ndjson";

export const SERVE_ROUTES = {
  serveVersion: { method: "GET", path: "/api/version" },
  serveAccounts: { method: "GET", path: "/api/accounts" },
  startPass: { method: "POST", path: "/api/passes" },
  passStatus: { method: "GET", path: "/api/passes/:passId" },
  openConversation: { method: "POST", path: "/api/conversations" },
  sendTurn: { method: "POST", path: "/api/conversations/:id/turns" },
  closeConversation: { method: "DELETE", path: "/api/conversations/:id" },
} as const satisfies Record<string, { readonly method: "GET" | "POST" | "PUT" | "DELETE"; readonly path: `/api/${string}` }>;

export type ServeRouteName = keyof typeof SERVE_ROUTES;
/** The routes that answer with an ndjson stream (`callStream`); `res` is their line type. */
export const STREAM_ROUTES = ["startPass", "sendTurn"] as const satisfies readonly ServeRouteName[];
export type StreamRouteName = (typeof STREAM_ROUTES)[number];

/** GET /api/version on `squad serve`. */
export interface ServeVersion {
  /** The running squad's package version, e.g. `0.1.0-rc.13`. */
  readonly version: string;
}

export interface ServeApi {
  serveVersion: { params: void; query: void; body: void; res: ServeVersion };
  serveAccounts: { params: void; query: void; body: void; res: readonly ServeAccountView[] };
  startPass: { params: void; query: void; body: ServePassBody; res: PassLine };
  /** Only a pass made with the same token; any other id is a 404. */
  passStatus: { params: { readonly passId: string }; query: void; body: void; res: PassStatus };
  openConversation: { params: void; query: void; body: ServeOpenBody; res: Conversation };
  /** Only a conversation the same token opened; any other id is a 404. */
  sendTurn: { params: { readonly id: string }; query: void; body: ServeTurnBody; res: TurnLine };
  /** 204, no body. */
  closeConversation: { params: { readonly id: string }; query: void; body: void; res: void };
}

/** Every route of both listeners. The names never clash, so one `call` serves both. */
export interface AllApi extends Api, ServeApi {}
export type AnyRouteName = RouteName | ServeRouteName;
export const ALL_ROUTES = { ...ROUTES, ...SERVE_ROUTES } as const;

// Every route has a type entry, and every type entry a route.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const routesMatchApi: Same<RouteName, keyof Api> = true;
void routesMatchApi;
const serveRoutesMatchApi: Same<ServeRouteName, keyof ServeApi> = true;
void serveRoutesMatchApi;
// A name in both tables would make `call` reach the wrong listener's route.
const noSharedName: Same<Extract<RouteName, ServeRouteName>, never> = true;
void noSharedName;

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
