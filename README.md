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
| `shell <account>` | a bash session in a container on one account |
| `log <passId>` | the end of a pass log |
| `gc [--dry-run]` | remove orphan containers, lost passes, old files and old sessions |
| `web [--api-only]` | the web view and its API |

`SQUAD_DRY_RUN=1` prints every Docker command and plan and runs nothing.

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

## Web view

`squad web` serves the API and the built web app from one origin. Sign-in is OIDC (the code flow
with PKCE) against your identity provider. The session is an encrypted, httpOnly cookie that holds
only the email, name and groups. A person sees only the accounts they own. No token ever reaches
the browser.

It needs `SQUAD_WEB_URL`, `SQUAD_OIDC_ISSUER` and `SQUAD_OIDC_CLIENT_ID`. A client secret, if
any, goes in `squad.secret.toml` (mode 600) in the squad home.

### Add an account from the web

The "Add account" box offers the providers of the price catalog (`SQUAD_PRICES_URL`, a models.dev
style `api.json`):

- Seats: `codex` (device login) and `claude` (a `claude setup-token` token).
- Built into pi: the providers that take one API key (opencode, opencode-go, zai, ...). squad writes
  only `auth.json`.
- Other providers from the catalog that have an `api` address and the `@ai-sdk/openai-compatible`
  package (engy, sumopod, ...). squad writes `auth.json` and a `models.json` built from the catalog.

Each provider card shows the catalog's logo. squad fetches `<catalog origin>/logos/<id>.svg` once, keeps it in `state/logos/`, and serves it at `/logos/<id>.svg` (an SVG with a sandbox CSP); a missing logo is a 404.

Adding `claude` with no token runs `claude setup-token` on the server: the page shows the claude.com sign-in link, you paste the code it gives, and squad writes the token account. Pasting a token still works.

`SQUAD_WEB_PROVIDERS` is `all` by default; a comma list of ids restricts what is offered, and the
server refuses the rest. The table that says which runner serves a provider is `PROVIDER_RUNNER` in
`packages/squad/src/providers.ts`. While the web loop runs, a new catalog copy also rewrites the
`models.json` of pi key accounts for the custom providers they hold (never `auth.json`).

**A pasted key crosses the network.** The page sends the key or token once, over HTTPS, to the
server. It is checked for shape only, written to the account folder (mode 600) and never logged or
returned. A TLS-terminating proxy in between (a Cloudflare tunnel, for example) can see it. Use this
only when you trust that hop; otherwise use `add-key` or `add-token` on the host.

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

The server must list the app's origin: `SQUAD_WEB_API_ORIGINS=https://app.example.com`. The session
cookie is `SameSite=Lax`, so the app must be on the same site as squad (`app.example.com` and
`squad.example.com`). A different site will not work.
