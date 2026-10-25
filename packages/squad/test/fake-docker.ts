// A fake `docker` for tests: a small sh script. It records every call (one NUL-separated argv file
// per call), and acts on the first line of a `modes` file. A `run` call uses up the first line while
// more than one is left, so a test can script "busy, then ok". `stop` and `kill` calls do not.
//
// `ps` prints the file `ps` (tab-separated rows a test wrote with `setPs`), or fails as a daemon that
// is down would (`setPsFail`); `rm <name>` drops that name's row, as the real daemon would. `logs`
// prints the stream a test chose with `setLogs`; `wait` prints 0. None of them touches the modes.
//
// Modes: ok, slow (ok after half a second), claude-ok (the opus capture), codex-ok, codex-model-not-found (exit 1), codex-file (a turn with no agent_message; writes the -o file),
// codex-reused (an inline shape-test stream: a permanent auth failure), auth, free-tier, busy (exit 75), hang (no output until a stop or kill call), crash,
// nokey (pi stderr, exit 1, no stream), tmpcwd (ok, with a /tmp path as session cwd),
// login-codex / login-pi (a login run: write the file given to `setLoginAuth` as auth.json into the mounted /codex or /pi folder; the host path comes from the --mount arg),
// login-files (copy the files given to `setLoginFiles` into the mounted /codex, /pi or /claude folder; exit 0).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CAPTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "captures");
const CAPTURES = join(CAPTURES_ROOT, "pi");

const SCRIPT = `#!/bin/sh
d="$(dirname "$0")"
mkdir -p "$d/calls"
call="$d/calls/$(date +%s%N)-$$"
printf '%s\\0' "$@" > "$call.argv"
case "$1" in
  stop|kill) : > "$d/stopped"; exit 0 ;;
  ps)
    if [ -f "$d/ps-fail" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    [ -f "$d/ps" ] && cat "$d/ps"; exit 0 ;;
  logs) [ -f "$d/logs.jsonl" ] && cat "$d/logs.jsonl"; exit 0 ;;
  wait) if [ -f "$d/wait" ]; then cat "$d/wait"; else echo 0; fi; exit 0 ;;
  rm)
    for last in "$@"; do :; done
    if [ -f "$d/ps" ]; then awk -F '\\t' -v n="$last" '$1 != n' "$d/ps" > "$d/ps.tmp" && mv "$d/ps.tmp" "$d/ps"; fi
    exit 0 ;;
esac
# stdin of a run is kept too, so a test can see the prompt arrived there and not in the argv.
cat > "$call.stdin"
mode="$(head -n 1 "$d/modes")"
if [ "$(wc -l < "$d/modes")" -gt 1 ]; then
  tail -n +2 "$d/modes" > "$d/modes.tmp" && mv "$d/modes.tmp" "$d/modes"
fi
case "$mode" in
  ok) cat "$d/ok.jsonl" ;;
  slow) sleep 0.5; cat "$d/ok.jsonl" ;;
  claude-ok) cat "$d/claude-ok.jsonl" ;;
  codex-ok) cat "$d/codex-ok.jsonl" ;;
  codex-model-not-found) cat "$d/codex-model-not-found.jsonl"; exit 1 ;;
  codex-file)
    for a in "$@"; do case "$a" in *target=/squad/out*) o="\${a#type=bind,source=}"; o="\${o%%,*}"; printf 'from the file' > "$o/last-message.txt" ;; esac; done
    cat "$d/codex-file.jsonl" ;;
  codex-reused) cat "$d/codex-reused.jsonl"; exit 1 ;;
  auth) cat "$d/auth.jsonl" ;;
  free-tier) cat "$d/free-tier.jsonl" ;;
  nokey) echo "No API key found for opencode." >&2; exit 1 ;;
  tmpcwd) sed 's#"cwd":"/work"#"cwd":"/tmp/squad-probe-abc123"#' "$d/ok.jsonl" ;;
  login-codex|login-pi)
    t=/codex; [ "$mode" = login-pi ] && t=/pi
    for a in "$@"; do case "$a" in *target=$t) o="\${a#type=bind,source=}"; o="\${o%%,*}"; cp "$d/login-auth.json" "$o/auth.json" ;; esac; done ;;
  login-files)
    for a in "$@"; do case "$a" in *target=/codex|*target=/pi|*target=/claude) o="\${a#type=bind,source=}"; o="\${o%%,*}"; cp -a "$d/login-files/." "$o/" ;; esac; done ;;
  busy) exit 75 ;;
  crash) head -n 4 "$d/ok.jsonl"; echo "docker: something broke" >&2; exit 3 ;;
  hang) while [ ! -f "$d/stopped" ]; do sleep 0.05; done; exit 143 ;;
esac
exit 0
`;

export interface FakeDocker {
  readonly path: string;
  /** The modes for the next `run` calls, one per call; the last one repeats. */
  setModes(...modes: string[]): void;
  /** Every call so far, oldest first, as argv without the program name. */
  calls(): string[][];
  /** Only the calls whose first word is `sub`. */
  callsOf(sub: string): string[][];
  /** The stdin text of every `run` call, oldest first. */
  stdins(): string[];
  /** The rows `docker ps` prints: name, pass label, state, created-at. Replaces the earlier rows. */
  /** The auth.json body a `login-codex` or `login-pi` run writes into the mounted account folder. */
  setLoginAuth(body: string): void;
  /** The files (path -> body) a `login-files` run writes into the mounted account folder. */
  setLoginFiles(files: Record<string, string>): void;
  setPs(...rows: [name: string, passId: string, state: string, createdAt: string][]): void;
  /** `ps` fails with exit 1, as when the daemon is down. */
  setPsFail(fail: boolean): void;
  /** What `docker logs` prints: a stream file this fake holds, such as `ok.jsonl`. */
  setLogs(file: string): void;
}

export function makeFakeDocker(dir: string = mkdtempSync(join(tmpdir(), "fake-docker-"))): FakeDocker {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "docker");
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  writeFileSync(join(dir, "ok.jsonl"), readFileSync(join(CAPTURES, "ok.jsonl")));
  writeFileSync(join(dir, "claude-ok.jsonl"), readFileSync(join(CAPTURES_ROOT, "claude", "ok-opus-5-5.jsonl")));
  writeFileSync(join(dir, "codex-ok.jsonl"), readFileSync(join(CAPTURES_ROOT, "codex", "ok-gpt-6-1-sol.jsonl")));
  writeFileSync(join(dir, "codex-model-not-found.jsonl"), readFileSync(join(CAPTURES_ROOT, "codex", "model-not-found.jsonl")));
  // Shape tests: invented streams, not captures.
  const turn = { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } };
  writeFileSync(join(dir, "codex-file.jsonl"), `${JSON.stringify(turn)}\n`);
  const reused = JSON.stringify({ type: "error", status: 401, error: { message: "refresh token was reused", code: "refresh_token_reused" } });
  writeFileSync(join(dir, "codex-reused.jsonl"), `${JSON.stringify({ type: "turn.failed", error: { message: reused } })}\n`);
  writeFileSync(join(dir, "auth.jsonl"), readFileSync(join(CAPTURES, "auth-error.jsonl")));
  writeFileSync(join(dir, "free-tier.jsonl"), readFileSync(join(CAPTURES, "free-tier-error.jsonl")));
  const setModes = (...modes: string[]): void => writeFileSync(join(dir, "modes"), `${modes.join("\n")}\n`);
  setModes("ok");
  const calls = (): string[][] => {
    const cdir = join(dir, "calls");
    let names: string[];
    try {
      names = readdirSync(cdir).sort();
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith(".argv")).map((n) => readFileSync(join(cdir, n), "utf8").split("\0").slice(0, -1));
  };
  const stdins = (): string[] => {
    const cdir = join(dir, "calls");
    try {
      return readdirSync(cdir).sort().filter((n) => n.endsWith(".stdin")).map((n) => readFileSync(join(cdir, n), "utf8"));
    } catch {
      return [];
    }
  };
  const setPs = (...rows: string[][]): void => writeFileSync(join(dir, "ps"), rows.map((r) => `${r.join("\t")}\n`).join(""));
  const setLoginAuth = (body: string): void => writeFileSync(join(dir, "login-auth.json"), body);
  const setLoginFiles = (files: Record<string, string>): void => {
    const root = join(dir, "login-files");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), body);
    }
  };
  const setPsFail = (fail: boolean): void => (fail ? writeFileSync(join(dir, "ps-fail"), "") : rmSync(join(dir, "ps-fail"), { force: true }));
  const setLogs = (file: string): void => writeFileSync(join(dir, "logs.jsonl"), readFileSync(join(dir, file)));
  return { path, setModes, setLoginAuth, setLoginFiles, calls, callsOf: (sub) => calls().filter((c) => c[0] === sub), stdins, setPs, setPsFail, setLogs };
}
