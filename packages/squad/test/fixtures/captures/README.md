# Captures

Real CLI output, scrubbed. Never edit a capture by hand except to scrub it.

Scrubbed: session ids, message, request and event ids (fixed fakes), and every path (`/work`).

| File | Source |
|---|---|
| `pi/ok.jsonl` | `pi -p --mode json`, a one-word reply (from doppelganger's `host/fixtures/pi-ok.jsonl`) |
| `pi/auth-error.jsonl` | the same, with a bad API key: the provider answered 401 |
| `pi/free-tier-error.jsonl` | the same, a free OpenCode Zen model from outside OpenCode: 403 FreeTierError |
| `claude/ok-opus-5-5.jsonl` | claude 2.1.310, `claude -p --output-format stream-json --verbose`, setup-token, a one-word reply |
| `claude/ok-sonnet-5-5.jsonl` | the same on claude-sonnet-5-5 |
| `codex/ok-gpt-6-1-sol.jsonl` | codex 0.162.1, `codex exec --json ... -m gpt-6.1-sol -`, a ChatGPT device login, a one-word reply |
| `codex/model-not-found.jsonl` | the same with `-m no-such-model`: an `error` event whose message is JSON with status 400 and code `model_not_found`, then `turn.failed`; exit 1 |
| `codex/usage.json` | GET chatgpt.com/backend-api/wham/usage with the codex login's access token (read only, no refresh); user id and account id replaced, email set to `EMAIL` |
| `prices/models-dev-excerpt.json` | GET https://models.dev/api.json on 2026-10-24 (230 providers, 5.9 MB); kept: providers `opencode`, `opencode-go` and `anthropic`, their first four models, plus `opencode-go/beam-free`. Nothing scrubbed: the catalog is public |
| `codex/login-device-auth.txt` | codex 0.162.1, `codex login --device-auth` in a throwaway `CODEX_HOME`, stdout with its ANSI colours, stopped after 15 s before any sign-in (exit 124); the one-time code replaced with `ABCD-EFGHJ`. stderr was empty |
| `claude/login/.credentials.json` | claude 2.1.310, `/login` (Claude subscription) in a throwaway `CLAUDE_CONFIG_DIR`; access and refresh tokens replaced. It holds no email |
| `claude/login/.claude.json` | the same login; trimmed to `numStartups`, `userID` and `oauthAccount` (the feature-flag cache dropped). Ids, email, names, org name and dates replaced. The email is `oauthAccount.emailAddress` |
| `pi/login/auth.json` | pi 1.1.0, `/login` with the `opencode` provider in a throwaway `PI_CODING_AGENT_DIR`: pi stores `{type: "api_key", key}`, no OAuth and no identity; the key replaced |
| `prices/local-models-dev-excerpt.json` | GET http://<lan host>:7311/api.json, the owner's own models.dev instance, on 2026-10-24 (233 providers, 6.0 MB); kept: opencode, opencode-go, engy, sumopod (only in this instance), alibaba-token-plan, kenari, anthropic and openai, the first three models each. Public data, nothing scrubbed |
