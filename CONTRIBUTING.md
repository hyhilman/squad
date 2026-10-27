# Contributing

Thank you for helping. Read [AGENTS.md](AGENTS.md) first: it holds the rules for code, tests and
secrets, for people and for AI agents alike. This page is the short version.

## Set up

```bash
npm install      # never `npm ci` inside a worktree
npm test         # type checks, then every test in every workspace
```

The backend and the contract have no build step. Node strips the types at run time, so
`node --test <file>` runs one test file directly.

## Before you open a pull request

- `npm test` passes.
- Each change does one thing. If you find a problem outside your change, open an issue for it.
- A new behaviour comes with a test. Write the test first and watch it fail.
- Every setting is an `EnvSpec` row with a one-line `why`. A kill switch is `SQUAD_NO_<FEATURE>=1`.
- Pin every dependency to an exact version that is at least two weeks old. The backend has no
  runtime dependency; ask before you add one.

## Tests that use real Docker

`npm test` never starts a container. These do, and you run them by hand:

```bash
SQUAD_DOCKER_CHECK=1 node --test packages/squad/src/lock.docker.test.ts
node packages/squad/src/cli/squad.ts image build pi
```

## Secrets and real logins

These rules protect real accounts. Breaking one can revoke a person's whole login.

- Never copy a login folder: not in code, not in a test, not by hand.
- Never use a real login in development. Make a fresh one for squad, or use a throwaway home
  (`SQUAD_HOME=$(mktemp -d)`).
- Never commit the squad home (`.squad/`) or `squad.secret.toml`.
- A test fixture taken from real CLI output is scrubbed first: tokens, account ids, emails and
  paths are replaced with fixed fakes. `test/fixtures.test.ts` fails on a fixture that still holds
  one.
- No log line, error or API answer may carry a token.

## Writing

Write comments, commit messages and docs in plain, simple English. Use short sentences and the
active voice. When you need a hard term, explain it once in parentheses. Comment only the why: the
code already says what it does.

## Reporting a security problem

Do not open a public issue for a problem that could leak a token or a login. Contact the
maintainer privately through GitHub instead.

## Releases

CI makes three kinds of build, one branch each. Work moves from `dev` to `rc` to `main`, so a pull
request targets `dev`.

| Branch | How it starts | Version | GitHub release |
| --- | --- | --- | --- |
| `dev` | a person: Actions, ci, **Run workflow**, on `dev` | `0.2.0-dev.gabc1234` | pre-release |
| `rc` | every push to `rc` | `0.2.0-rc.1`, then `0.2.0-rc.2` | pre-release |
| `main` | every push to `main` | `0.2.0` | latest release |

A build is made only after `npm test` passed on that same commit, in the same run. Pushes and the
dev button run on the self-hosted `squad-ci` runners. A pull request runs on GitHub's runners, so
code from a fork never runs on our machine. A push to `dev`
only runs the tests. Each release holds two tarballs: `squad-<version>.tgz` and
`squad-contract-<version>.tgz`. Before the tag is pushed, both pass their `check-pack.sh`.

The number before `-dev` or `-rc` is the base: the `version` in `packages/squad/package.json`. A
person raises it; CI never does. It must be exactly one step above the last stable release (the
highest `v` and three numbers tag). Raise it on `dev`, right after a stable release:

    git fetch --tags
    npm run release -- bump patch|minor|major

A dev build is named by its commit: `g` and the short hash (the `g` keeps the version valid when the
hash is all digits). A release candidate number is one more than the highest `-rc` tag of that base.
A push to `main` whose base is already released makes nothing; the run says why.

The release is a tag-only commit: the tested commit plus squad's `package.json` and lock entry at the
exact version. Only the tag is pushed, so no branch moves and CI does not start again. All of the
logic is in `packages/squad/scripts/release.ts`, with its tests. See what a branch would release:

    npm run release -- plan --branch rc
    SQUAD_DRY_RUN=1 npm run release -- publish --branch rc --sha <sha> --expect <version>
