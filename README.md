<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.png">
    <img src="docs/brand/logo-light.png" alt="squad" width="160" height="160">
  </picture>
</p>

# squad

squad runs AI coding agents (claude, codex and pi) in Docker, one pass at a time, on accounts bound
to folders. It keeps one writer per login, picks an account from a pool for each pass, and records
the token use of every pass.

It is a TypeScript library that other tools import to run passes, and a `squad` CLI to log in, check
accounts and read token use. `squad web` serves a small web view behind OIDC sign-in.

## Why

An agent CLI keeps its login in a folder: `CODEX_HOME` for codex, the claude config dir for claude,
the pi agent dir for pi. A login refreshes its own token. If two processes refresh the same login,
the provider sees a refresh token used twice and revokes every token of that login.

squad makes that impossible by design:

- Each account is one folder, and a pass mounts exactly one of them.
- A login account runs one pass at a time. The lock lives inside the container, so it holds for as
  long as the container lives, even when the process that started it dies.
- A login is never copied. Moving it to another project is `squad import`, which moves it under
  its lock.

## What a pass does

1. The pool drops accounts that are dead, disabled, cooling down, busy, or under their floor (the
   share of each usage window kept for the owner). It sorts the rest by room left.
2. squad starts `docker run --init` on a pinned image for the first account. The container takes
   the account lock without waiting. If the lock is held, it exits 75 and squad tries the next one.
3. squad reads the CLI's structured output: the final text, the token use, the room left in the
   5-hour and weekly windows, and on failure one failure kind.
4. squad writes the pass row and updates the account's health. A failure kind comes from an exact
   provider error code, never from a guess over free text.

Failure kinds: `quota`, `rate-limit`, `auth`, `provider`, `idle`, `timeout`, `no-account` and
`busy`. A permanent auth code (`token_revoked`, `refresh_token_invalidated`, `refresh_token_reused`,
`invalid_grant`) marks an account dead until a new login.

## Account kinds

| Kind | What it is | Passes at once |
|---|---|---|
| `login` | an OAuth login that refreshes itself (codex device login, claude `/login`, pi `/login` with an OAuth provider) | one, under the lock |
| `key` | an API key that never changes (also a pi `/login` that stored only keys) | many, each on a throwaway copy |
| `token` | a static token that never refreshes (claude `setup-token`) | many |

## Requirements

- Node.js 22.18 or newer (squad uses `node:sqlite` and runs TypeScript with type stripping).
- Docker, and `flock` on the host (util-linux).

## Quick start

```bash
npm install
npm test

# Build the runner image you need.
node packages/squad/src/cli/squad.ts image build pi

# Make an account from a pi auth file you created with pi's /login, then try one pass.
node packages/squad/src/cli/squad.ts add-key pi/dev --from /path/to/auth.json
node packages/squad/src/cli/squad.ts probe pi/dev --model <provider/model>
node packages/squad/src/cli/squad.ts list
```

The squad home holds accounts, locks and the database. It is `.squad/` in the main checkout of the
current git repo, or the folder in `SQUAD_HOME`. It is mode 0700 and must never be committed.

## CLI

| Verb | What it does |
|---|---|
| `list` | accounts, owner, health and room left |
| `usage [--by account\|task\|flow\|day\|model] [--since 7d]` | token use, grouped |
| `add-key <runner>/<name> --from <file>` | make a key account from a file |
| `add-token claude/<name> --from <file>` | make a claude token account from a file |
| `login <runner>/<name>` | log in to a new account in a container, then move it into place |
| `owner <account> [<email>]` | set who owns an account |
| `floor <account> <5h%> <week%>` | the share of each window kept for the owner |
| `usage-read [<account>]` | read codex usage now |
| `probe <account> --model <id>` | one tiny real pass on one account |
| `image build <runner>` | build a pinned runner image |
| `import <home> [<account>...]` | bring accounts from another project's home |
| `remove <account> --yes` | remove an account: its folder goes, its pass history stays |
| `shell <account>` | a bash session in a container on one account |
| `log <passId>` | the end of a pass log |
| `gc [--dry-run]` | remove orphan containers, lost passes, old files and old sessions |
| `web [--api-only]` | the web view and its API |
| `serve [--socket <path> \| --port <n>]` | provider mode: passes and conversations for machine callers (see below) |
| `token add <project> --accounts <id,...> --roots <path,...> [--images <ref,...>]` | make a project token for `serve`; only the token goes to stdout. An account may be `'*'` or `'<runner>/*'` (see `serve`) |
| `token list` / `token revoke <project>` | the live tokens (never the token itself) / end one at once |
| `connect --url <origin> --pair <code>` | on your own computer: sign in to claude in your browser and send the token to squad web |

`SQUAD_DRY_RUN=1` prints every Docker command and plan and runs nothing.

## Consent

squad runs a pass only on an account its owner shares. An account with no consent is never picked
by the pool, and a pass or conversation that names it fails at once with failure kind `no-account`
and code `no-consent` (no container starts, the health does not change).

- The owner gives consent by adding or logging in to their own account in the web app (every way:
  codex device login, the claude sign-ins, a pasted token, `squad connect`, a pi key), and by a web
  re-login or a new token or key.
- **Stop sharing** on the account page (the owner only) takes it back; **Share again** gives it again.
- `add-key`, `add-token` and `login` on the host with `--owner` do **not** give consent: an admin may
  run them for someone else. That person shares the account from the web app. Without `--owner`, the
  person at the host adds their own account, and it is shared (`consent_by` is `cli`). An `import`
  keeps the source account's consent; a doppelganger key import with `--owner` is not shared.
- Every account that existed before consent was checked was marked shared by the migration
  (`consent_by` is `migration`), so nothing in use stopped working.

## Library

```ts
import { runPass, roomOf, listAccounts, usageBy } from "squad";

const result = await runPass(
  {
    runner: "pi",
    model: "provider/model",
    pool: "pi",
    prompt: "Reply with the single word: ok",
    cwd: process.cwd(),
    caller: { flow: "my-tool", action: "check" },
  },
  deps,
);
```

`deps` holds the squad home, the open store, the project name, the commit author and the host user
id. `result` holds the pass id, the account, the final text, every assistant text, the token use
and, on failure, `{ kind, code, message }`.

A request can also carry fields that every runner takes in the same form. squad turns each one into
that CLI's own flags:

- `system`: extra system prompt. codex has no flag, so it goes at the top of the prompt.
- `skill: { name, dir }`: a folder with `SKILL.md`. It is mounted read-only. For codex the text of
  `SKILL.md` (without its front matter) goes before the message.
- `effort`: `low`, `medium`, `high`, `xhigh` or `max`.
- `mounts: [{ host, container, ro }]`: extra read-only or read-write mounts. Never the squad home
  and never a path squad owns. Set `env.PATH` if the tools are in a mount.
- `image`: your own image built `FROM` a squad image. It must keep the `squad.entry=1` label and the
  `squad-entry` entrypoint, because the account lock lives there.
- `container` (a fixed name; `docker rm -f` of it runs first) and `labels` (`squad.*` keys are
  reserved).
- `onOutput(chunk)`: each stdout chunk as it arrives.

A bad value is a thrown error before any account or container is touched. `openHome(dir?, env?)`
returns `{ home, store }` for the `deps`.

### Conversations and providers

A conversation is many turns on one account (pi only for now; codex and claude refuse). The
history stays in a folder under the squad home. The caller picks the account.

```ts
import { open, send, close, listAccountsWithServes } from "squad";

const conv = open({ runner: "pi", account: "pi/alice", model: "provider/model", cwd, caller }, deps);
const turn = await send(conv, "first message", { onOutput }, deps);
await send(conv, "follow-up", {}, deps);
close(conv, deps);
```

- `open` writes a row and starts no container. It takes the same standard fields as a pass and fixes
  them for every turn. It refuses an unknown, dead or disabled account.
- `send` is one pass on that account, always. If another pass holds the account's lock, it answers
  at once with failure kind `busy`; ask again later. Each turn has a pass row with the conversation
  id.
- If the first turn is refused (`quota`, `rate-limit` or `auth`) with zero tokens, the tie is dropped:
  `turn.closed` is `"first-turn-refused"` and the caller can `open` again on another account.
- `close` deletes the history and is safe to call twice. `squad gc` closes a conversation that
  was idle for `SQUAD_CONVERSATION_IDLE_D` days, never one with a running turn.
- `listAccountsWithServes({ home, store }, runner?)` lists each account with its health, `busy`, room
  left in both windows with their reset times, and `serves`: the providers (and, when pi's
  `models.json` lists them, the model ids) it can run. It never returns a key or token.

## Provider mode

`squad serve` lets another program on the same host (such as doppelganger) run passes and
conversations over HTTP. A pass over HTTP is code execution on the host: it mounts host paths and
picks an image. So `serve` is its own listener, never the web app's port: a unix socket with mode
0600 (default `<home>/serve.sock`, or `--socket <path>`), or `--port <n>` on 127.0.0.1 only. `squad
web` serves none of these routes. It needs no OIDC settings. One `serve` runs per home; a second
one refuses to start.

Each caller gets a project token:

```sh
token=$(squad token add dg --accounts pi/one,pi/two --roots /srv/dg/worktrees)
```

The token is shown once; squad keeps only its sha256. Every call sends `Authorization: Bearer
<token>`. A wrong, unknown or revoked token is a 401 with no detail. The token limits:

- the accounts a pass may name. A pass that names no account (only `runner` and `model`) lets squad
  pick one of the token's accounts of that runner, as it picks from a pool. A token with none of that
  runner is the same 403. A conversation still names its account;
- an account may also be a pattern (a wildcard), so a new account needs no new token. `'*'` is every
  account of the home, and `'<runner>/*'` (such as `'codex/*'`) every account of that runner. Both
  count the accounts added later, and never a removed one: squad reads the accounts again on every
  request. Patterns and plain ids mix: `--accounts 'codex/*,pi/one'`. Quote them, so the shell does
  not expand the `*`. `token list` shows the patterns as given;
- the host paths: `cwd`, `gitDir`, `skill.dir` and every mount host must exist and be inside one of
  the roots after symlinks are resolved, and must not touch the squad home;
- the image: squad's own, or one given with `--images`;
- the `container` name: it must start with the project name and a dash (`<project>-...`), because
  squad runs `docker rm -f` on it before the pass.

Out of scope is a 403 that names the field only.

Run `squad serve` as the project's user: passes run with serve's uid and gid, and a `cwd` owned by
another uid is refused.

| Route | What it does |
|---|---|
| `GET /api/version` | `{version}`: the running squad's package version |
| `GET /api/accounts` | the token's accounts (no emails) |
| `POST /api/passes` | one pass; the answer is ndjson: `started`, `output`..., `result` |
| `GET /api/passes/:passId` | `{running: true, ...}` or `{running: false, result}`; only the token's own passes |
| `POST /api/conversations` | open a conversation; it belongs to the token |
| `POST /api/conversations/:id/turns` | one turn, ndjson as a pass |
| `DELETE /api/conversations/:id` | close it (204) |

The pass row is written before the `started` line. After `started`, a failure comes only as
`result.failure`. A dropped connection does not stop the pass: poll `GET /api/passes/:passId`. The
SDK has `callStream` and, in `@squad/contract/node`, `nodeSocketFetch` (see [SDK](#sdk)).

On SIGTERM or SIGINT, `serve` stops taking requests, lets running passes finish for
`SQUAD_SERVE_DRAIN_S` seconds, stops what is left with `docker stop` (the `SQUAD_STOP_GRACE_S`
grace), removes the socket and exits 0. `SQUAD_NO_SERVE=1` makes it refuse to start.

After a restart, `serve` checks each pass it left running by its container name. A container that
still runs is watched to its end. Only when `docker ps` answers and the container is not there does
the pass end as lost: `failure {kind: "provider", code: "lost"}`. When docker gives no answer, the
pass stays running, because a wrong "lost" could start a second agent in the same folder.

## Web view

`squad web` serves the API and the built web app from one origin. Sign-in is OIDC (the code flow
with PKCE) against your identity provider. The session is an encrypted, httpOnly cookie that holds
only the email, the name and, for an admin, the admin group. A person sees only the accounts they own. No token ever reaches
the browser.

It needs `SQUAD_WEB_URL`, `SQUAD_OIDC_ISSUER` and `SQUAD_OIDC_CLIENT_ID`. A client secret, if
any, goes in `squad.secret.toml` (mode 600) in the squad home. That file takes three keys:
`oidc_client_secret`, `session_key` (made on the first start) and `embed_key` (below).

### Show squad inside another app (embed ticket)

An app on the same site can show squad in an iframe (`SQUAD_WEB_FRAME_ANCESTORS`) and sign the
person in without a click. Set `embed_key` in `squad.secret.toml` to 64 hex characters (32 random
bytes), and give the same key to that app's backend. Unset or empty = the feature is off, and
`/auth/embed` is a plain 404.

The app's backend signs a ticket for the person it has already signed in, and the frame opens
`/auth/embed?ticket=<ticket>&to=<path>`. squad then sets its own normal session cookie and redirects
to `to`. A ticket is `B.S`: `B` is the base64url (RFC 4648 section 5, no padding) of a JSON object, and
`S` is the base64url of HMAC-SHA256 over the text `B`. The object has exactly these fields: `v` (1),
`aud` (the origin of `SQUAD_WEB_URL`: scheme, host and port if any, lower case, no trailing
slash), `email`, `name`, `groups` (strings), `iat` and `exp` (epoch seconds, `exp - iat` from 1 to
60) and `jti` (16 random bytes in base64url, used once).

squad refuses a ticket that is expired, already used, or made at most 5 seconds after the server
started or earlier (a restart forgets the used ids, so an older ticket must not run again), and one
whose `iat` is more than 5 seconds ahead of squad's clock, and one whose person is not in
`SQUAD_OIDC_GROUP`. For about 6 seconds after each start, every ticket is refused. A refusal sets
no cookie and redirects the same way, so the frame shows the signed-out card with its Sign in button. The request must come from the same
site (`Sec-Fetch-Site` is `same-origin` or `same-site`); this stops another site from signing a
visitor in with the attacker's own ticket.

Signed out, the app never signs in by itself: it shows a Sign in button. The account menu has
"Sign out" (squad's session only) and "Sign out everywhere", which also ends the identity
provider's session through its `end_session_endpoint` (OIDC RP-initiated logout). squad keeps no ID
token, so it sends only `client_id`, and no post-logout address: nothing has to be registered at the
provider. The provider's sign-out opens in a new tab, and squad's tab shows its signed-out page. A
provider with no `end_session_endpoint` gets the plain sign out, and the page says so.

The logo and icons sit at `/brand/`. To use your own, set `SQUAD_WEB_BRAND_DIR` to a folder with
any of `logo-light.png`, `logo-dark.png`, `favicon.ico` and `apple-touch-icon.png` (PNG or ICO, at
most 2 MB each). A name that is missing there keeps the built-in file; one logo alone stands in for
both themes.

### Add an account from the web

The "Add account" box offers the providers of the price catalog (`SQUAD_PRICES_URL`, a models.dev
style `api.json`):

- Seats: `codex` (device login) and `claude` (a `claude setup-token` token).
- Built into pi: the providers that take one API key (opencode, opencode-go, zai, ...). squad writes
  only `auth.json`.
- Other providers from the catalog that have an `api` address and the `@ai-sdk/openai-compatible`
  package (engy, sumopod, ...). squad writes `auth.json` and a `models.json` built from the catalog.

Each provider card shows the catalog's logo. squad fetches `<catalog origin>/logos/<id>.svg` once, keeps it in `state/logos/`, and serves it at `/logos/<id>.svg` (an SVG with a sandbox CSP); a missing logo is a 404.

`SQUAD_WEB_PROVIDERS` is `all` by default; a comma list of ids restricts what is offered, and the
server refuses the rest. The table that says which runner serves a provider is `PROVIDER_RUNNER` in
`packages/squad/src/providers.ts`. While the web loop runs, a new catalog copy also rewrites the
`models.json` of pi key accounts for the custom providers they hold (never `auth.json`).

**A pasted key crosses the network.** The page sends the key or token once, over HTTPS, to the
server. It is checked for shape only, written to the account folder (mode 600) and never logged or
returned. A TLS-terminating proxy in between (a Cloudflare tunnel, for example) can see it. Use this
only when you trust that hop; otherwise use `add-key` or `add-token` on the host.

### Claude sign-in options

A claude account holds a long-lived `claude setup-token` token. The "Add account" box offers three
ways to get one:

- **Sign in with Claude** (server sign-in with a code). squad runs `claude setup-token` in a
  container on the server. The page shows the claude.com sign-in link; you sign in and paste back the
  code that page shows. squad types it into the CLI and writes the token account.
- **Use my computer (no typing).** The page gives you one command to run in a terminal on your own
  computer (it needs Node.js 22.18 or newer and Claude Code):
  `npx -y https://github.com/hyhilman/squad/releases/download/v<version>/squad-<version>.tgz connect --url <squad web address> --pair <code>`,
  or `squad connect --url ... --pair ...` when squad is installed there. It runs your own
  `claude setup-token`, so your browser opens and the sign-in finishes on your computer. The helper
  reads the token from the CLI's output and sends it once, over HTTPS, to squad; it never prints or
  saves it. The pair code works once, for 10 minutes, and only for the person who asked for it.
  As with a pasted token, a TLS-terminating proxy in between can see the token. Linux and macOS
  only for now.
- **I already have a token.** Paste the output of `claude setup-token`.

### Account actions

The account page (and the ⋯ menu of each row in Accounts) offers:

- **Stop sharing / Share again** (the owner): see Consent.
- **Test** (the owner or an admin): one tiny real pass, the same as `squad probe`, with a model the
  account serves or `SQUAD_PROBE_MODEL_<RUNNER>`. One per account per minute. It spends a few tokens.
- **Reset health** (the owner or an admin): clears cooling, suspect and the last code. A login that
  was revoked (`token_revoked`, `refresh_token_invalidated`, `refresh_token_reused`, `invalid_grant`)
  needs a new login instead.
- **Log in again** (the owner): a codex device login (the same seat only), a new claude token (any of
  the three sign-in ways), or **Replace key** for a pi key. A good end clears the health. A claude
  login made with `squad login` (a config folder, not a token) logs in again on the host.
- **Use limit reset** (the owner, claude): runs the real claude CLI's `/limit-reset` on the account
  and reports what the CLI said. It spends one of your limit resets. When the reset goes through, the
  account's cool-down ends. `SQUAD_NO_LIMIT_RESET=1` turns it off.
- **Remove** (the owner or an admin, typed confirm): deletes the account folder under the account
  lock (while a pass holds a login, it is refused: try again later). The pass history stays and shows the account as removed. The
  name may be used again later. squad then says where to revoke the login or key at the provider.

### Two costs per pass

Each pass row keeps two costs:

- `cli_cost_usd`: what the CLI said (pi: the sum of `message_end` `usage.cost.total`; claude: the
  result's `total_cost_usd`; codex has none, so it is empty).
- `catalog_cost_usd`: the tokens times the catalog price in force when the pass started (from the
  `price_history` table, which gets a row when a model's price is new or changed). Pi uses
  `<provider>/<model>`, codex `openai/<model>`, claude `anthropic/<model>`. It is set for every kind
  of account, seats too, and empty when the catalog has no price.

The older `cost_usd` and `price_src` columns stay. `cost_usd` equals `catalog_cost_usd` for a `key`
account and is empty for a seat. The Usage page compares the two sums by provider/model.

### Key use and caps

A key account (an API key, today only on pi) has no 5-hour or week window from its provider. So
squad shows what the key used in its own passes over the last 5 hours, 7 days and 30 days. A pass
counts its CLI cost, or its catalog cost when the CLI said 0 or nothing. For a plan such as
opencode-go, pi works the cost out from its own price table, so the number is an estimate, not
money spent. squad never asks the provider for a balance. It cannot see use outside squad, and the
provider's month may follow a billing cycle squad does not know.

The owner (or an admin) may set a cap in dollars per window under Caps & balance; there is none by default.
When a window's used sum reaches its cap, the pool stops picking the key, the same way as an account
under its floor. A cap stops only new passes: up to `SQUAD_KEY_PARALLEL` passes may already run on
the key, so the use can go a little past the cap. `SQUAD_NO_KEY_CAPS=1` makes the pool ignore caps.

The owner may also type the balance the provider's console shows, under the same item. squad keeps
it with the time it was entered and shows an estimate: that balance minus what squad's own passes
used since then. The estimate cannot see use outside squad (another tool on the same key, a refund,
a top-up), so it drifts; type the console's number again to reset it. It is display only: the pool
never reads it.

`squad import <home>` also reads a doppelganger project (a folder with `creds/pi/<name>/` or
`.doppelganger/creds/pi/<name>/` and no squad database). It copies the pi key accounts
(`auth.json` and `models.json`) and never moves them; a folder with a login entry is refused.
`--owner <email>` sets their owner.

## Layout

```
packages/contract/  the HTTP API between the backend and the web app
packages/squad/     the library, the CLI and the web server
apps/web/           the web app (Astro, React and Chakra UI)
images/             the runner images and their entrypoint
```

## Packaging

`npm pack -w squad` builds `dist/` and makes a tarball that another project can install. The
contract, the images and the web app are inside it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## SDK

Another app on the same site can call the squad API with the typed SDK. Each release holds a
second tarball, `squad-contract-<version>.tgz` (`npm run pack:sdk -- <dir>` makes it). It is the
package `@squad/contract`.

```ts
import { call } from "@squad/contract";
await call(fetch, "https://squad.example.com", "listAccounts", {}, { credentials: "include" });
```

For `squad serve`, a Node program uses the socket fetch and a bearer token:

```ts
import { call, callStream } from "@squad/contract";
import { nodeSocketFetch } from "@squad/contract/node";
const f = nodeSocketFetch("/srv/dg/.squad/serve.sock");
const headers = { authorization: `Bearer ${token}` };
for await (const line of callStream(f, "http://squad", "startPass", { body }, { headers })) {
  if (line.type === "result") console.log(line.result.text);
}
```

The server must list the app's origin: `SQUAD_WEB_API_ORIGINS=https://app.example.com`. The session
cookie is `SameSite=Lax`, so the app must be on the same site as squad (`app.example.com` and
`squad.example.com`). A different site will not work.
