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
