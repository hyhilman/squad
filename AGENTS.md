# AGENTS.md

Conventions for working in this repo. What squad is and why: the design doc, kept out of git in `docs/private/design.md` (it names private infrastructure). These rules follow
doppelganger's AGENTS.md; where squad differs, it says so here.

squad runs AI coding agents (claude, codex, pi; dsh later) in Docker, one pass at a time, on accounts
bound to folders. It keeps one writer per token, picks accounts from a pool, and records token use.

## Layout

```
packages/contract/  @squad/contract: the HTTP API between backend and web app. Routes, shapes, the
                    typed `call`, and `findForbidden`. No dependencies, no Node types in its code.
packages/squad/     squad: the backend. The library other tools import, the
                    `squad` CLI, and `squad web` (the API server that also serves the built web app).
apps/web/           @squad/web: the web app. Astro builds one page; the whole app is one React
                    island on the client (Chakra UI, React Router, TanStack Query, recharts).
docs/               the design doc.
```

- `packages/contract` imports nothing outside itself. Both other packages import it.
- `apps/web` reaches the backend only through `@squad/contract`'s `call`. It never builds a URL or a
  request body by hand.
- `packages/squad` never imports `apps/web`. It serves `apps/web/dist/` as files.
- A change to the API is a change to `packages/contract/src/api.ts` first. A route exists when it is
  in `ROUTES` and in `Api`; the backend serves exactly those routes. The type check fails on both
  sides when a shape changes, which is the point.

## Commands

- `npm install` at the root installs every workspace. In a worktree, run `npm install`, never
  `npm ci` (as in doppelganger: `npm ci` through a linked `node_modules` empties the other install).
- `npm test` at the root runs every workspace's tests, each with its type check first. It must pass
  before every commit that lands on a base branch.
- `node --test <file>` runs one backend or contract test file.
- `npm run dev -w @squad/web` runs the web app, with `/api`, `/auth` and `/logos` proxied to a local
  `squad web --api-only`.
- Backend and contract have no build step for development or tests: Node strips the types at run
  time. Prefer Node's built-in modules (`node:test`, `node:sqlite`, `node:crypto`) over a new
  dependency.
- Two builds, both only for shipping; no test depends on them. `npm run build -w @squad/web` builds
  the web app. `npm run build -w squad` (also `prepack`) emits `packages/squad/dist/` with the
  contract vendored inside, the images, the codex config guard and the built web app.
  `packages/squad/scripts/check-pack.sh` installs the tarball into a fresh folder and checks it.
- Releases come from CI (`.github/workflows/ci.yml`), never by hand: Run workflow on `dev` makes a
  dev build, a push to `rc` a release candidate, a push to `main` the stable release
  (CONTRIBUTING.md: Releases). Pull requests target `dev`. `npm run release -- bump
  patch|minor|major` raises the base in `packages/squad/package.json` after a stable release.
- `npm run pack:sdk -- <dest dir>` packs `@squad/contract` as `squad-contract-<version>.tgz` (the SDK
  for other apps; the version is squad's). `packages/contract/scripts/check-pack.sh` installs it in a
  fresh folder, imports it and type-checks it with no DOM and no Node types.
- `packages/squad/scripts/dg-image.sh` builds `squad-local/doppelganger-supervisor:rc`: doppelganger's
  released image with this checkout's squad inside. doppelganger runs it with `DG_IMAGE`. Rebuild it
  after each change; it holds a copy.
- The web app's pure helpers (`apps/web/src/app/lib/`) have `node --test` tests; its `npm test` runs
  them after `astro check`.
- `SQUAD_DOCKER_CHECK=1 node --test <file>` runs the tests that start real containers. `npm test`
  skips them. `squad image build <runner>` builds a runner image; `squad probe <account> --model <id>`
  runs one tiny real pass.

## Dependencies

- Pin every version exactly. Pick a release at least two weeks old.
- The backend has no runtime dependency. `@squad/contract` is a devDependency: the build vendors it
  into `dist/vendor/contract`, because it is not published. Ask before adding any dependency.
- The web app's dependencies stay in `apps/web`. Telemetry is off: the scripts set
  `ASTRO_TELEMETRY_DISABLED=1`.

## Secrets and accounts

These rules guard real logins. Breaking one can revoke a person's whole token family.

- A refreshing login (codex device login, claude `/login`, pi `/login`) has exactly one writer. Never
  copy its folder: not in code, not in a test, not by hand. Moving it between projects is
  `squad import`, which moves it under the source's lock.
- Never mount a real login in a development pass, and never run `squad import` against a real
  project before the migration step that calls for it. Use a login made fresh for squad, or a
  throwaway home.
- A pass mounts exactly one account folder. Nothing else of the home goes into a container: no other
  account, no lock but its own (read-only), no database.
- The home (`.squad/`, or `SQUAD_HOME`) is git-ignored and mode 0700. `squad.secret.toml` is mode 600
  and never committed.
- No API answer, log line, error message or test output carries a token, a refresh token or an auth
  file. The backend runs `findForbidden` on every response and refuses to send one that fails.
- The web app never holds a token. Sign-in is the backend's OIDC flow (code flow with PKCE); the
  session is an httpOnly, same-origin cookie.
- A fixture taken from a real capture is scrubbed first: access, refresh and ID tokens, account ids
  and emails are replaced with fixed fakes. A test fails on a fixture that still looks like one
  (`findForbidden`).

## Settings

- Every setting is an `EnvSpec` row in the file that owns it, with a one-line `why`. The `why` is
  its only documentation.
- Kill switches are `SQUAD_NO_<FEATURE>=1` and fail toward the safest result.
- The safe-run surface: `SQUAD_DRY_RUN=1` builds every argv and plan and runs nothing;
  `SQUAD_DB=/tmp/x.db` uses a throwaway database.
- A flag is on only for exactly `1`.

## Runtime rules

- Logs: one logfmt line shape on stderr. The code that writes a line sets its level.
- Database: one SQLite file per project home, `node:sqlite`, WAL, append-only migrations. Never edit
  a shipped migration. On `SQLITE_BUSY`, do not retry and do not raise the timeout: the row goes to
  the spool, and the next open folds it in.
- Never wait for an account. A busy account is a refusal; with none left the answer is `no-account`
  at once.
- The account lock lives inside the container (fd 9, `flock -n -E 75`, then `exec` the CLI, under
  `docker run --init`). Exit 75 means busy. Never take an account lock in the host process that
  starts the container: it frees when that process dies, while the container keeps running.
  The one exception is a step with no container on the account: `squad login` moving the new login
  into place, `squad import` moving a login out, and `squad remove` (and the web Remove) deleting
  the folder (`src/lock.ts`). There the host holds the lock only for that step itself, and a
  running pass makes it fail at once.
- Stop before kill: `docker stop` with the grace time, so a token refresh in flight can finish.
- A failure kind comes from structured output or an exact provider error code. Never guess it from
  free text with a regex or a keyword list.

## Tests

- A fixture that stands in for an external capture (a CLI stream, an auth file, an API reply) is
  taken from the real thing, then scrubbed. A made-up input is not a capture.
- Every test database and home lives in its own `mkdtempSync(tmpdir())` folder. `npm test` points
  `SQUAD_HOME` into a per-process temp root (`packages/squad/test/tmp-root.ts`), so no test opens a
  real home.
- A test never reads a real home, a real account folder or a real settings file.
- When a doc states a count or a list, add the test that pins it.

## Comments and writing

- Plain, simple English: short sentences, active voice. Explain a hard term once in parentheses.
- Comment only the why: a non-obvious reason, a safety rule, a workaround and its cause. Do not
  repeat what the code says, and do not write history.

## Scope

- Do one thing per change. A problem found outside the task becomes an issue, not a fix in the same
  change.
- Agent passes (doppelganger's flows) work in their own git worktrees under `.worktrees/`, never in
  the main checkout.
