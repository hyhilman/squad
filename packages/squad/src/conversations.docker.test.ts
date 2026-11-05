// Real Docker, the real claude and codex CLIs in squad's images. Skipped unless SQUAD_DOCKER_CHECK=1;
// the images must be built (`squad image build claude`, `squad image build codex`). The model API is
// a fake inside the container (test/fake-model): a test never mounts a real login, so each account is
// an empty folder and the CLI talks to the fake with a fake key.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { addAccount } from "./accounts/store.ts";
import { close, open, send } from "./conversations.ts";
import { containerUser } from "./docker-user.ts";
import { ensureHome, layoutOf } from "./home.ts";
import { uuidOfUlid } from "./ids.ts";
import { makeLog } from "./log.ts";
import type { RunDeps } from "./run.ts";
import { openStore } from "./store/db.ts";

const SKIP = process.env.SQUAD_DOCKER_CHECK !== "1";
const FAKE = new URL("../test/fake-model/", import.meta.url).pathname;
const root = SKIP ? "" : mkdtempSync(join(tmpdir(), "squad-conv-docker-"));

function rig() {
  const base = mkdtempSync(join(root, "r-"));
  const home = layoutOf(join(base, "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  for (const runner of ["claude", "codex"] as const) {
    addAccount(store.db, { runner, name: "t1", kind: "login" }, new Date());
    mkdirSync(join(home.accounts, runner, "t1"), { recursive: true });
  }
  // A linked worktree, as doppelganger runs passes: the cwd is the worktree, the objects are in main/.git.
  const main = join(base, "main");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]).status, 0, args.join(" "));
  mkdirSync(main);
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const cwd = join(main, ".worktrees", "x");
  git("worktree", "add", "-q", cwd);
  const log = join(base, "log");
  mkdirSync(log);
  // The CLI may run as another uid on a rootful daemon.
  chmodSync(log, 0o777);
  writeFileSync(join(log, "requests.log"), "");
  chmodSync(join(log, "requests.log"), 0o666);
  const deps: RunDeps = { home, store, docker: "docker", project: "proj", identity: { name: "Bot", email: "bot@example.com" }, user: containerUser("docker"), log: makeLog(() => {}) };
  const setup = {
    cwd,
    gitDir: join(main, ".git"),
    caller: { flow: "chat", action: "chat" },
    mounts: [{ host: FAKE, container: "/fake", ro: true }, { host: log, container: "/log", ro: false }],
    env: { PATH: "/fake:/usr/local/bin:/usr/bin:/bin", ANTHROPIC_BASE_URL: "http://127.0.0.1:18999", ANTHROPIC_API_KEY: "fake-key-for-test", FAKE_KEY: "fake-key-for-test", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  };
  const requests = (): string[] => readFileSync(join(log, "requests.log"), "utf8").trim().split("\n").filter((l) => l !== "");
  return { home, store, deps, setup, cwd, requests };
}

const jsonlUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(".jsonl"));

describe("claude and codex conversations in real Docker", { skip: SKIP }, () => {
  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("claude: open, send, send: the second turn carries the history; no transcript in the login folder; close removes it", async () => {
    const r = rig();
    const c = open({ runner: "claude", account: "claude/t1", model: "claude-sonnet-4-5", system: "Be brief.", ...r.setup }, r.deps);
    const a = await send(c, "first", {}, r.deps);
    assert.equal(a.failure, undefined, JSON.stringify(a.failure));
    const b = await send(c, "second", {}, r.deps);
    assert.equal(b.failure, undefined, JSON.stringify(b.failure));
    // One user message, then user, assistant, user.
    assert.deepEqual(r.requests(), ["anthropic 1", "anthropic 3"]);
    assert.equal(b.text, "saw 3");
    // claude reports a resumed session's running cost. The fake bills 100 input tokens and 1 output token
    // per message; at claude-sonnet-4-5's $3 and $15 per million, turn two alone is 900 + 45 micro-dollars.
    const costs = (r.store.db.prepare("SELECT cli_cost_usd FROM passes ORDER BY rowid").all() as { cli_cost_usd: number }[]).map((p) => p.cli_cost_usd);
    assert.ok(Math.abs(costs[1]! - 0.000945) < 1e-9, `turn two cost ${costs[1]}`);
    const dir = join(r.home.sessions, "claude", "t1", c.id);
    assert.deepEqual(jsonlUnder(dir), [join(r.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${uuidOfUlid(c.id)}.jsonl`)]);
    assert.deepEqual(jsonlUnder(join(r.home.accounts, "claude", "t1")), []);
    close(c, r.deps);
    assert.ok(!existsSync(dir));
  });

  test("claude: a transcript moved under another cwd's folder is refused, and no container starts", async () => {
    const r = rig();
    const c = open({ runner: "claude", account: "claude/t1", model: "claude-sonnet-4-5", ...r.setup }, r.deps);
    assert.equal((await send(c, "first", {}, r.deps)).failure, undefined);
    const dir = join(r.home.sessions, "claude", "t1", c.id);
    renameSync(join(dir, r.cwd.replace(/[^a-zA-Z0-9]/g, "-")), join(dir, "-elsewhere"));
    await assert.rejects(send(c, "second", {}, r.deps), /must run in the cwd the conversation started in/);
    assert.deepEqual(r.requests(), ["anthropic 1"]);
  });

  test("codex: open, send, send: the thread resumes with its history, the turn counts only its own tokens, no rollout in the login folder", async () => {
    const r = rig();
    const c = open({ runner: "codex", account: "codex/t1", model: "gpt-5", ...r.setup }, r.deps);
    const a = await send(c, "first", {}, r.deps);
    assert.equal(a.failure, undefined, JSON.stringify(a.failure));
    const b = await send(c, "second", {}, r.deps);
    assert.equal(b.failure, undefined, JSON.stringify(b.failure));
    const [one, two] = r.requests().map((l) => Number(l.split(" ")[1]));
    assert.equal(r.requests().length, 2);
    assert.equal(two, one! + 2, "the second request holds the first turn and its reply, then the new message");
    // The fake bills 100 input tokens per item. codex reports the thread's total; the pass row keeps the turn's.
    assert.equal(a.usage.input, one! * 100);
    assert.equal(b.usage.input, two! * 100);
    const dir = join(r.home.sessions, "codex", "t1", c.id);
    assert.equal(jsonlUnder(dir).length, 1);
    assert.deepEqual(jsonlUnder(join(r.home.accounts, "codex", "t1")), []);
    close(c, r.deps);
    assert.ok(!existsSync(dir));
  });
});
