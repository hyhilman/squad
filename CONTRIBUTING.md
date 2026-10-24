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
