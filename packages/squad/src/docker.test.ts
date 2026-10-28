import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";
import { dockerKillArgv, dockerRunArgv, dockerStopArgv, stopGraceS, type PassPlan } from "./docker.ts";

const HOME = "/h/.squad";
const plan = (more: Partial<PassPlan> = {}): PassPlan => ({
  runner: "pi",
  image: "squad-pi:1.1.0",
  name: "squad-p1",
  passId: "p1",
  caller: { project: "proj", flow: "fix" },
  user: { uid: 1000, gid: 1000 },
  cwd: "/w/tree",
  gitDir: "/w/main/.git",
  mounts: [],
  overlays: [],
  session: null,
  account: { name: "alice", kind: "login", dir: `${HOME}/accounts/pi/alice` },
  lockFile: `${HOME}/locks/pi-alice.lock`,
  identity: { name: "Bot", email: "bot@example.com" },
  ghDir: null,
  home: HOME,
  env: {},
  args: ["-p", "hi"],
  ...more,
});
const pairs = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));
// Each --mount value shown as source:target[:ro], so a rule reads the same as a -v rule would.
const mountsOf = (argv: string[]): string[] =>
  pairs(argv, "--mount").map((m) => {
    const f = m.split(",");
    assert.equal(f[0], "type=bind");
    return `${f[1]!.replace("source=", "")}:${f[2]!.replace("target=", "")}${f[3] === "readonly" ? ":ro" : ""}`;
  });
const envOf = (argv: string[]): string[] => pairs(argv, "-e");

test("starts with run --rm -i --init --name and labels", () => {
  const a = dockerRunArgv(plan());
  assert.deepEqual(a.slice(0, 6), ["run", "--rm", "-i", "--init", "--name", "squad-p1"]);
  assert.deepEqual(pairs(a, "--label"), ["squad.pass=p1", "squad.caller=proj/fix", "squad.account=pi/alice", "squad.purpose=pass"]);
  assert.ok(a.includes("--network"));
  assert.equal(a[a.indexOf("--network") + 1], "host");
});

test("--user only when a uid is given", () => {
  assert.deepEqual(pairs(dockerRunArgv(plan()), "--user"), ["1000:1000"]);
  assert.deepEqual(pairs(dockerRunArgv(plan({ user: null })), "--user"), []);
});

test("IS_SANDBOX=1 only for claude with no --user, and a caller cannot set it", () => {
  const claude = { runner: "claude" as const, account: { name: "alice", kind: "login" as const, dir: `${HOME}/accounts/claude/alice` }, lockFile: `${HOME}/locks/claude-alice.lock` };
  assert.ok(envOf(dockerRunArgv(plan({ ...claude, user: null }))).includes("IS_SANDBOX=1"));
  assert.ok(!envOf(dockerRunArgv(plan(claude))).some((e) => e.startsWith("IS_SANDBOX=")));
  assert.ok(!envOf(dockerRunArgv(plan({ user: null }))).some((e) => e.startsWith("IS_SANDBOX=")));
  assert.throws(() => dockerRunArgv(plan({ ...claude, user: null, env: { IS_SANDBOX: "0" } })), /IS_SANDBOX is set by squad/);
});

test("cwd, git dir and extra mounts sit at the same path", () => {
  const a = dockerRunArgv(plan({ mounts: [{ host: "/data/a", ro: true }, { host: "/data/b", ro: false }, { host: "/s/skill", container: "/skills/x", ro: true }] }));
  const m = mountsOf(a);
  assert.ok(m.includes("/w/tree:/w/tree"));
  assert.equal(a[a.indexOf("-w") + 1], "/w/tree");
  assert.ok(m.includes("/w/main/.git:/w/main/.git"));
  assert.ok(m.includes("/data/a:/data/a:ro"));
  assert.ok(m.includes("/data/b:/data/b"));
  assert.ok(m.includes("/s/skill:/skills/x:ro"));
});

test("a git dir under cwd is not mounted twice", () => {
  const m = mountsOf(dockerRunArgv(plan({ gitDir: "/w/tree/.git" })));
  assert.equal(m.filter((x) => x.includes("/.git")).length, 0);
});

test("a login mounts the account folder, the lock and sets SQUAD_LOCK", () => {
  for (const [runner, path] of [["pi", "/pi"], ["codex", "/codex"], ["claude", "/claude"]] as const) {
    const a = dockerRunArgv(plan({ runner, account: { name: "alice", kind: "login", dir: `${HOME}/accounts/${runner}/alice` } }));
    const m = mountsOf(a);
    assert.ok(m.includes(`${HOME}/accounts/${runner}/alice:${path}`));
    assert.ok(m.includes(`${HOME}/locks/pi-alice.lock:/squad/lock:ro`));
    assert.ok(envOf(a).includes("SQUAD_LOCK=1"));
  }
});

test("a login plan without a lock file throws", () => {
  assert.throws(() => dockerRunArgv(plan({ lockFile: null })), /lock/);
});

test("a key account has no lock mount and no SQUAD_LOCK", () => {
  const a = dockerRunArgv(plan({ runner: "codex", account: { name: "k", kind: "key", dir: `${HOME}/accounts/codex/k` }, lockFile: null }));
  assert.ok(mountsOf(a).includes(`${HOME}/accounts/codex/k:/codex`));
  assert.ok(!mountsOf(a).some((x) => x.includes("/squad/lock")));
  assert.ok(!envOf(a).some((x) => x.startsWith("SQUAD_LOCK")));
});

test("a token account mounts only the token file, read-only", () => {
  const a = dockerRunArgv(plan({ runner: "claude", account: { name: "t", kind: "token", dir: `${HOME}/accounts/claude/t` }, lockFile: null }));
  const m = mountsOf(a);
  assert.ok(m.includes(`${HOME}/accounts/claude/t/token:/squad/token:ro`));
  assert.ok(!m.some((x) => x.endsWith(":/claude")));
  assert.ok(envOf(a).includes("SQUAD_TOKEN_FILE=/squad/token"));
  assert.ok(!m.some((x) => x.includes("/squad/lock")));
});

test("a token account is refused for other runners", () => {
  for (const runner of ["pi", "codex"] as const)
    assert.throws(() => dockerRunArgv(plan({ runner, account: { name: "t", kind: "token", dir: "/x" }, lockFile: null })), /token/);
});

test("git identity and gh dir", () => {
  const a = dockerRunArgv(plan({ ghDir: "/g/gh" }));
  const e = envOf(a);
  for (const x of ["GIT_AUTHOR_NAME=Bot", "GIT_AUTHOR_EMAIL=bot@example.com", "GIT_COMMITTER_NAME=Bot", "GIT_COMMITTER_EMAIL=bot@example.com"]) assert.ok(e.includes(x), x);
  assert.ok(mountsOf(a).includes("/g/gh:/gh:ro"));
  assert.ok(!mountsOf(dockerRunArgv(plan())).some((x) => x.endsWith(":/gh:ro")));
});

test("caller env is passed, and squad-internal names are refused", () => {
  assert.ok(envOf(dockerRunArgv(plan({ env: { FOO: "1" } }))).includes("FOO=1"));
  for (const k of ["SQUAD_LOCK", "SQUAD_TOKEN_FILE", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR"])
    assert.throws(() => dockerRunArgv(plan({ env: { [k]: "x" } })), new RegExp(k));
});

test("the image comes right before the CLI args, at the end", () => {
  const a = dockerRunArgv(plan({ args: ["-p", "--", "go"] }));
  assert.deepEqual(a.slice(-4), ["squad-pi:1.1.0", "-p", "--", "go"]);
});

test("safety: no token text in argv, findForbidden passes, only the account dir and lock come from the home", () => {
  const root = mkdtempSync(join(tmpdir(), "squad-docker-"));
  const dir = join(root, ".squad", "accounts", "claude", "t");
  mkdirSync(dir, { recursive: true });
  const fake = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE";
  writeFileSync(join(dir, "token"), fake);
  writeFileSync(join(dir, "auth.json"), fake);
  const home = join(root, ".squad");
  for (const kind of ["token", "login"] as const) {
    const lockFile = kind === "login" ? join(home, "locks", "c.lock") : null;
    const a = dockerRunArgv(plan({ runner: "claude", account: { name: "t", kind, dir }, lockFile, cwd: join(root, "w"), gitDir: join(root, "m", ".git") }));
    assert.ok(!a.some((x) => x.includes(fake)));
    assert.equal(findForbidden(a), undefined);
    const inHome = mountsOf(a).map((v) => v.split(":")[0]!).filter((s) => s.startsWith(home));
    const allowed = kind === "token" ? [join(dir, "token")] : [dir, lockFile];
    assert.deepEqual(inHome.sort(), allowed.sort());
  }
});

test("stop and kill argv; the grace comes from the setting", () => {
  assert.deepEqual(dockerStopArgv("n", 20), ["stop", "-t", "20", "n"]);
  assert.deepEqual(dockerKillArgv("n"), ["kill", "n"]);
  assert.equal(stopGraceS({}), 20);
  assert.equal(stopGraceS({ SQUAD_STOP_GRACE_S: "5" }), 5);
});

test("every bind mount is a --mount; -v is never used", () => {
  const a = dockerRunArgv(plan({ ghDir: "/g/gh", mounts: [{ host: "/data/a", ro: true }] }));
  assert.ok(!a.includes("-v"));
  assert.ok(a.includes("type=bind,source=/w/tree,target=/w/tree"));
  assert.ok(a.includes(`type=bind,source=${HOME}/locks/pi-alice.lock,target=/squad/lock,readonly`));
  assert.ok(a.includes("type=bind,source=/g/gh,target=/gh,readonly"));
  assert.ok(a.includes("type=bind,source=/data/a,target=/data/a,readonly"));
  assert.ok(a.includes(`type=bind,source=${HOME}/accounts/pi/alice,target=/pi`));
});

test("a comma in any mounted path throws", () => {
  assert.throws(() => dockerRunArgv(plan({ cwd: "/w/a,b" })), /comma/);
  assert.throws(() => dockerRunArgv(plan({ gitDir: "/w/a,b/.git" })), /comma/);
  assert.throws(() => dockerRunArgv(plan({ mounts: [{ host: "/d", container: "/x,y", ro: true }] })), /comma/);
  assert.throws(() => dockerRunArgv(plan({ ghDir: "/g,h" })), /comma/);
  assert.throws(() => dockerRunArgv(plan({ lockFile: "/l,k" })), /comma/);
  assert.throws(() => dockerRunArgv(plan({ account: { name: "a", kind: "login", dir: "/a,b" } })), /comma/);
});

test("extra mounts cannot land on squad's own container paths", () => {
  for (const c of ["/squad", "/squad/lock", "/squad/token", "/pi", "/pi/auth.json", "/codex", "/claude/x", "/gh", "/gh/hosts.yml", "/squad/skills/../lock", "/squad/outx"])
    assert.throws(() => dockerRunArgv(plan({ mounts: [{ host: "/d", container: c, ro: true }] })), /reserved/, c);
  for (const c of ["/squad/skills/squad/skills/x", "/squad/out", "/squad/sessions", "/skills/x", "/ghost"])
    assert.doesNotThrow(() => dockerRunArgv(plan({ mounts: [{ host: "/d", container: c, ro: true }] })), c);
});

test("extra mounts, cwd and git dir cannot touch the squad home", () => {
  for (const host of [HOME, `${HOME}/accounts`, `${HOME}/accounts/pi/bob`, "/h", "/"])
    assert.throws(() => dockerRunArgv(plan({ mounts: [{ host, container: "/m", ro: true }] })), /home/, host);
  assert.throws(() => dockerRunArgv(plan({ cwd: `${HOME}/x` })), /home/);
  assert.throws(() => dockerRunArgv(plan({ cwd: "/h" })), /home/);
  assert.throws(() => dockerRunArgv(plan({ gitDir: `${HOME}/.git` })), /home/);
  assert.doesNotThrow(() => dockerRunArgv(plan({ mounts: [{ host: "/h/.squadx", ro: true }] })));
  assert.doesNotThrow(() => dockerRunArgv(plan({ home: null, mounts: [{ host: "/h/.squad", ro: true }] })));
});

test("a session dir is mounted read-write at /squad/sessions: its own id folder, never the root", () => {
  const dir = `${HOME}/sessions/pi/alice/s1`;
  const a = dockerRunArgv(plan({ session: { dir } }));
  assert.ok(a.includes(`type=bind,source=${dir},target=/squad/sessions`), "no readonly flag");
  assert.equal(mountsOf(a).filter((m) => m.endsWith(":/squad/sessions")).length, 1);
  assert.ok(!mountsOf(a).some((m) => m.startsWith(`${HOME}/sessions:`)), "never the sessions root");
  assert.ok(!mountsOf(dockerRunArgv(plan())).some((m) => m.includes("/squad/sessions")), "no session, no mount");
});

test("a session dir that is not <home>/sessions/<runner>/<account>/<id> is refused", () => {
  for (const dir of [`${HOME}/sessions`, `${HOME}/sessions/pi`, `${HOME}/sessions/pi/alice`, `${HOME}/sessions/pi/alice/s1/x`, `${HOME}/accounts/pi/alice`, `${HOME}/sessions/../accounts/pi/alice`, `${HOME}/locks/pi/alice/s1`, "/elsewhere/s1"])
    assert.throws(() => dockerRunArgv(plan({ session: { dir } })), /session/, dir);
  assert.throws(() => dockerRunArgv(plan({ home: null, session: { dir: "/x/sessions/pi/a/s1" } })), /session/);
});

test("plan.mounts still cannot reach a session folder, and cannot use the session target twice", () => {
  const dir = `${HOME}/sessions/pi/alice/s1`;
  assert.throws(() => dockerRunArgv(plan({ mounts: [{ host: dir, container: "/m", ro: true }] })), /home/);
  assert.throws(() => dockerRunArgv(plan({ session: { dir }, mounts: [{ host: "/d", container: "/squad/sessions", ro: true }] })), /session/);
});

// ---- overlays ----

test("a codex overlay is a read-only mount over /codex/config.toml, after the account mount", () => {
  const a = dockerRunArgv(plan({ runner: "codex", overlays: [{ host: "/pkg/assets/codex-config.toml", container: "/codex/config.toml" }] }));
  const m = mountsOf(a);
  const acct = m.indexOf(`${HOME}/accounts/pi/alice:/codex`);
  const over = m.indexOf("/pkg/assets/codex-config.toml:/codex/config.toml:ro");
  assert.ok(acct >= 0 && over > acct, "a later mount on a sub-path wins in docker");
});

test("an overlay: only /codex/config.toml, and never from inside the home", () => {
  const o = (host: string, container: string) => plan({ runner: "codex", overlays: [{ host, container }] });
  assert.throws(() => dockerRunArgv(o("/x/a.toml", "/codex/auth.json")), /overlay/);
  assert.throws(() => dockerRunArgv(o("/x/a.toml", "/codex/config.toml/../auth.json")), /overlay/);
  assert.throws(() => dockerRunArgv(o(`${HOME}/accounts/codex/a/config.toml`, "/codex/config.toml")), /home/);
});

test("labels: squad.purpose is pass by default, and login and shell when asked; squad.pass and squad.account stay", () => {
  const labels = (more: Partial<PassPlan> = {}): string[] => pairs(dockerRunArgv(plan(more)), "--label");
  assert.ok(labels().includes("squad.purpose=pass"));
  assert.ok(labels({ purpose: "pass" }).includes("squad.purpose=pass"));
  for (const purpose of ["login", "shell"] as const) {
    const l = labels({ purpose });
    assert.ok(l.includes(`squad.purpose=${purpose}`));
    assert.ok(l.includes("squad.pass=p1"));
    assert.ok(l.includes("squad.account=pi/alice"));
  }
});

test("an overlay may be the home's own guard copy and nothing else in the home", () => {
  const ok = dockerRunArgv(plan({ runner: "codex", overlays: [{ host: `${HOME}/state/assets/codex-config.toml`, container: "/codex/config.toml" }] }));
  assert.ok(mountsOf(ok).includes(`${HOME}/state/assets/codex-config.toml:/codex/config.toml:ro`));
  assert.throws(() => dockerRunArgv(plan({ runner: "codex", overlays: [{ host: `${HOME}/state/assets/other.toml`, container: "/codex/config.toml" }] })), /home/);
  assert.throws(() => dockerRunArgv(plan({ runner: "codex", overlays: [{ host: `${HOME}/state/assets/../../accounts/codex/a/config.toml`, container: "/codex/config.toml" }] })), /home/);
});

test("caller mounts: --mount, closed targets, absolute paths, never the home; labels never under squad.", () => {
  const a = dockerRunArgv(plan({ callerMounts: [{ host: "/opt/t", container: "/tools", ro: true }], labels: { "x.y": "1" } }));
  assert.ok(mountsOf(a).includes("/opt/t:/tools:ro"));
  assert.ok(pairs(a, "--label").includes("x.y=1"));
  for (const container of ["/pi/x", "/squad/out", "/squad/skills", "/skills/a", "/", "rel"]) assert.throws(() => dockerRunArgv(plan({ callerMounts: [{ host: "/opt/t", container, ro: true }] })), /reserved|absolute/, container);
  assert.throws(() => dockerRunArgv(plan({ callerMounts: [{ host: `${HOME}/locks`, container: "/t", ro: true }] })), /home/);
  assert.throws(() => dockerRunArgv(plan({ labels: { "squad.pass": "x" } })), /squad\./);
});

test("a scratch claude config (the limit reset) mounts at /claude for a claude token account only, never from the home", () => {
  const tok = { runner: "claude" as const, account: { name: "t", kind: "token" as const, dir: `${HOME}/accounts/claude/t` }, lockFile: null };
  const argv = dockerRunArgv(plan({ ...tok, claudeConfig: "/tmp/squad-cfg-1" }));
  assert.ok(mountsOf(argv).includes("/tmp/squad-cfg-1:/claude"));
  assert.ok(mountsOf(argv).includes(`${HOME}/accounts/claude/t/token:/squad/token:ro`));
  assert.throws(() => dockerRunArgv(plan({ claudeConfig: "/tmp/squad-cfg-1" })), /claude token/);
  assert.throws(() => dockerRunArgv(plan({ runner: "claude", account: { name: "l", kind: "login", dir: `${HOME}/accounts/claude/l` }, claudeConfig: "/tmp/x" })), /claude token/);
  assert.throws(() => dockerRunArgv(plan({ ...tok, claudeConfig: `${HOME}/accounts/claude/other` })), /home/);
});
