import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";
import { makeFakeDocker } from "../../test/fake-docker.ts";
import { buildArgv } from "../images.ts";
import { addAccount, getAccount, putHealth, setState } from "../accounts/store.ts";
import { emptyHealth } from "../accounts/health.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { openStore } from "../store/db.ts";
import { fakeIdToken } from "../../test/fake-jwt.ts";
import { main, type Io } from "./squad.ts";

interface Rig { root: string; io: Io; out: string[]; err: string[]; run: (...argv: string[]) => Promise<number> }

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { SQUAD_HOME: join(root, "home") }, cwd: root, now: () => new Date("2026-10-24T12:00:00.000Z") };
  return { root, io, out, err, run: async (...argv) => main(argv, io) };
}

/** Opens the rig's db to seed rows. */
function seed(r: Rig, fn: (s: ReturnType<typeof openStore>) => void): void {
  const home = layoutOf(join(r.root, "home"), r.io.env);
  ensureHome(home);
  const s = openStore({ dbPath: home.db, spoolDir: home.spool });
  fn(s);
  s.close();
}

const NOW = new Date("2026-10-24T12:00:00.000Z");

test("an unknown verb, or none, prints usage on stderr and exits 2", async () => {
  const r = rig();
  assert.equal(await r.run("frobnicate"), 2);
  assert.match(r.err.join(""), /usage: squad/);
  assert.equal(r.out.join(""), "");
  r.err.length = 0;
  assert.equal(await r.run(), 2);
  assert.match(r.err.join(""), /usage: squad/);
});

test("list: one row per account with kind, state, health, left and last used; no path", async () => {
  const r = rig();
  seed(r, (s) => {
    addAccount(s.db, { runner: "pi", name: "k1", kind: "key", ownerEmail: "a@b.co" }, NOW);
    addAccount(s.db, { runner: "pi", name: "k2", kind: "key" }, NOW);
    addAccount(s.db, { runner: "pi", name: "k3", kind: "key" }, NOW);
    addAccount(s.db, { runner: "claude", name: "t1", kind: "token" }, NOW);
    putHealth(s.db, { ...emptyHealth("pi/k1"), left5h: 80, leftWeek: 55, lastUsedAt: "2026-10-24T11:00:00.000Z" });
    putHealth(s.db, { ...emptyHealth("pi/k2"), coolUntil: "2026-10-24T12:05:00.000Z", coolKind: "rate-limit" });
    setState(s.db, "pi/k3", "dead", "401:AuthError", NOW);
  });
  assert.equal(await r.run("list"), 0);
  const [tableText, roomText] = r.out.join("").trimEnd().split("\n\n");
  assert.equal(roomText, "room: claude 4/4\nroom: pi 4/8");
  const rows = tableText!.split("\n").map((l) => l.trim().split(/\s{2,}/));
  assert.deepEqual(rows[0], ["ACCOUNT", "KIND", "OWNER", "STATE", "HEALTH", "5H", "WEEK", "LAST USED"]);
  assert.deepEqual(rows.slice(1), [
    ["claude/t1", "token", "-", "active", "ok", "-", "-", "-"],
    ["pi/k1", "key", "a@b.co", "active", "ok", "80%", "55%", "2026-10-24T11:00:00.000Z"],
    ["pi/k2", "key", "-", "active", "cooling", "-", "-", "-"],
    ["pi/k3", "key", "-", "dead", "dead", "-", "-", "-"],
  ]);
  assert.ok(!r.out.join("").includes(r.root), "no host path");
});

test("list on an empty home prints only the header", async () => {
  const r = rig();
  assert.equal(await r.run("list"), 0);
  assert.equal(r.out.join("").trimEnd().split("\n").length, 1);
});

test("usage: a plain aligned table, by account by default, with the window from --since", async () => {
  const r = rig();
  seed(r, (s) => {
    s.startPass({ id: "p1", startedAt: "2026-10-23T10:00:00.000Z", project: "p", flow: "fix", action: "a", runner: "pi", model: "m1", account: "pi/k1" });
    s.endPass({ id: "p1", endedAt: "2026-10-23T10:01:00.000Z", outcome: "ok", tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 0 }, costUsd: 0.1234 });
    s.startPass({ id: "p0", startedAt: "2026-10-01T10:00:00.000Z", project: "p", flow: "old", action: "a", runner: "pi", model: "m1", account: "pi/old" });
    s.endPass({ id: "p0", endedAt: "2026-10-01T10:01:00.000Z", outcome: "ok", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  });
  assert.equal(await r.run("usage"), 0);
  const rows = r.out.join("").trimEnd().split("\n").map((l) => l.trim().split(/\s{2,}/));
  assert.deepEqual(rows[0], ["ACCOUNT", "PASSES", "OK", "FAIL", "INPUT", "OUTPUT", "CACHE-R", "CACHE-W", "REASON", "COST"]);
  assert.deepEqual(rows[1], ["pi/k1", "1", "1", "0", "100", "20", "5", "0", "0", "$0.1234"]);
  assert.equal(rows.length, 2);
  r.out.length = 0;
  assert.equal(await r.run("usage", "--by", "flow", "--since", "30d"), 0);
  const flows = r.out.join("").trimEnd().split("\n").map((l) => l.trim().split(/\s{2,}/));
  assert.deepEqual([flows[0]![0], flows[1]![0], flows[2]![0]], ["FLOW", "fix", "old"]);
});

test("usage: a bad --by or --since is a usage error", async () => {
  const r = rig();
  assert.equal(await r.run("usage", "--by", "colour"), 2);
  assert.equal(await r.run("usage", "--since", "soon"), 2);
  assert.equal(await r.run("usage", "--bogus"), 2);
  assert.equal(r.out.join(""), "");
});

test("list and usage output passes findForbidden", async () => {
  const r = rig();
  seed(r, (s) => {
    addAccount(s.db, { runner: "pi", name: "k1", kind: "key" }, NOW);
    s.startPass({ id: "p1", startedAt: "2026-10-23T10:00:00.000Z", project: "p", flow: "fix", action: "a", runner: "pi", model: "m1", account: "pi/k1" });
    s.endPass({ id: "p1", endedAt: "2026-10-23T10:01:00.000Z", outcome: "ok", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  });
  await r.run("list");
  await r.run("usage");
  const lines = r.out.join("").split("\n");
  assert.ok(lines.length > 3);
  assert.equal(findForbidden(lines), undefined);
  // Each word too, since findForbidden judges values one by one.
  assert.equal(findForbidden(lines.flatMap((l) => l.split(/\s+/))), undefined);
});

const KEY_BODY = '{"opencode-go":{"type":"api","key":"sk-SECRETSECRETSECRET1234"}}';

test("add-key copies the file in with the right modes, registers the account, and never prints the content", async () => {
  const r = rig();
  const src = join(r.root, "key.json");
  writeFileSync(src, KEY_BODY);
  assert.equal(await r.run("add-key", "pi/k1", "--from", src), 0);
  const home = layoutOf(join(r.root, "home"), r.io.env);
  const dest = join(home.accounts, "pi", "k1", "auth.json");
  assert.equal(readFileSync(dest, "utf8"), KEY_BODY);
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  assert.equal(statSync(join(home.accounts, "pi", "k1")).mode & 0o777, 0o700);
  const s = openStore({ dbPath: home.db, spoolDir: home.spool });
  assert.equal(getAccount(s.db, "pi/k1")?.kind, "key");
  s.close();
  const all = r.out.join("") + r.err.join("");
  assert.ok(!all.includes("SECRET"));
  assert.ok(!all.includes(dest));
  assert.match(all, /pi\/k1/);
});

test("add-key: failures never print the content either, and leave no half account", async () => {
  const r = rig();
  const src = join(r.root, "key.json");
  writeFileSync(src, KEY_BODY);
  assert.equal(await r.run("add-key", "pi/k1", "--from", src), 0);
  r.out.length = 0;
  r.err.length = 0;
  assert.equal(await r.run("add-key", "pi/k1", "--from", src), 1, "duplicate");
  assert.equal(await r.run("add-key", "pi/.x", "--from", src), 1, "unsafe name");
  assert.equal(await r.run("add-key", "pi/k2", "--from", join(r.root, "missing.json")), 1, "missing file");
  assert.equal(await r.run("add-key", "nope", "--from", src), 2, "bad id");
  assert.equal(await r.run("add-key", "pi/k3"), 2, "no --from");
  const all = r.out.join("") + r.err.join("");
  assert.ok(!all.includes("SECRET"));
  const home = layoutOf(join(r.root, "home"), r.io.env);
  assert.deepEqual(readdirSync(join(home.accounts, "pi")), ["k1"]);
  assert.ok(!existsSync(join(home.accounts, "pi", "k2")));
});

test("floor sets both floors on an account", async () => {
  const r = rig();
  seed(r, (s) => addAccount(s.db, { runner: "pi", name: "k1", kind: "key" }, NOW));
  assert.equal(await r.run("floor", "pi/k1", "20", "5"), 0);
  const home = layoutOf(join(r.root, "home"), r.io.env);
  const s = openStore({ dbPath: home.db, spoolDir: home.spool });
  const a = getAccount(s.db, "pi/k1")!;
  s.close();
  assert.deepEqual([a.floor5h, a.floorWeek], [20, 5]);
});

test("floor: an unknown account, or a percent outside 0..100, is refused", async () => {
  const r = rig();
  seed(r, (s) => addAccount(s.db, { runner: "pi", name: "k1", kind: "key" }, NOW));
  assert.equal(await r.run("floor", "pi/none", "20", "5"), 1);
  assert.equal(await r.run("floor", "pi/k1", "120", "5"), 2);
  assert.equal(await r.run("floor", "pi/k1", "x", "5"), 2);
  assert.equal(await r.run("floor", "pi/k1", "20"), 2);
});

test("a fresh home is made on the first call", async () => {
  const r = rig();
  assert.equal(existsSync(join(r.root, "home")), false);
  await r.run("list");
  assert.equal(existsSync(join(r.root, "home", "state", "squad.db")), true);
});

test("usage text lists image build and probe", async () => {
  const r = rig();
  await r.run();
  assert.match(r.err.join(""), /image build <runner>/);
  assert.match(r.err.join(""), /probe <runner>\/<name>/);
});

test("image build: a dry run prints the argv and runs nothing", async () => {
  const r = rig();
  const fake = makeFakeDocker(join(r.root, "bin"));
  const io: Io = { ...r.io, env: { ...r.io.env, SQUAD_DRY_RUN: "1", SQUAD_DOCKER: fake.path } };
  assert.equal(await main(["image", "build", "pi"], io), 0);
  assert.equal(r.out.join(""), `${fake.path} ${buildArgv("pi").join(" ")}\n`);
  assert.deepEqual(fake.calls(), []);
});

test("image build: runs docker with buildArgv and exits with its code", async () => {
  const r = rig();
  const fake = makeFakeDocker(join(r.root, "bin"));
  fake.setModes("ok", "busy");
  const io: Io = { ...r.io, env: { ...r.io.env, SQUAD_DOCKER: fake.path } };
  assert.equal(await main(["image", "build", "pi"], io), 0);
  assert.deepEqual(fake.calls(), [buildArgv("pi")]);
  assert.equal(await main(["image", "build", "pi"], io), 75, "docker's code");
});

test("image build: an unknown runner or a bad shape is a usage error", async () => {
  const r = rig();
  assert.equal(await r.run("image", "build", "nope"), 2);
  assert.equal(await r.run("image", "build"), 2);
  assert.equal(await r.run("image", "frob", "pi"), 2);
});

/** A rig with a key account pi/x and a fake docker. */
function probeRig(mode: string): Rig & { fake: ReturnType<typeof makeFakeDocker> } {
  const r = rig();
  const fake = makeFakeDocker(join(r.root, "bin"));
  fake.setModes(mode);
  seed(r, (s) => addAccount(s.db, { runner: "pi", name: "x", kind: "key" }, NOW));
  const home = layoutOf(join(r.root, "home"), r.io.env);
  mkdirSync(join(home.accounts, "pi", "x"), { recursive: true });
  writeFileSync(join(home.accounts, "pi", "x", "auth.json"), '{"fake":"not-a-real-key"}');
  const env = { ...r.io.env, SQUAD_DOCKER: fake.path };
  const io: Io = { ...r.io, env };
  return { ...r, io, fake, run: async (...argv) => main(argv, io) };
}

test("probe: ok prints one line with the tokens and exits 0", async () => {
  const r = probeRig("ok");
  assert.equal(await r.run("probe", "pi/x", "--model", "opencode-go/m"), 0);
  assert.equal(r.out.join(""), "pi/x ok opencode-go/hy4-preview in=1493 out=71 5h=- week=-\n");
  const argv = r.fake.callsOf("run")[0]!;
  assert.ok(argv.includes("Reply with the single word: ok"));
});

test("probe: a failure prints kind and code and exits 1", async () => {
  const r = probeRig("auth");
  assert.equal(await r.run("probe", "pi/x", "--model", "m"), 1);
  assert.equal(r.out.join(""), "pi/x fail auth 401:AuthError\n  reason: Invalid API key.\n");
});

test("probe: a failure with no stream prints the stderr reason", async () => {
  const r = probeRig("nokey");
  assert.equal(await r.run("probe", "pi/x", "--model", "m"), 1);
  assert.equal(r.out.join(""), "pi/x fail provider exit:1\n  reason: No API key found for opencode.\n");
});

test("probe: the reason is cut to 200 chars", async () => {
  const r = probeRig("nokey");
  r.fake.setModes("nokey");
  writeFileSync(join(r.root, "bin", "docker"), readFileSync(join(r.root, "bin", "docker"), "utf8").replace("No API key found for opencode.", "x".repeat(300)));
  assert.equal(await r.run("probe", "pi/x", "--model", "m"), 1);
  assert.equal(r.out.join(""), `pi/x fail provider exit:1\n  reason: ${"x".repeat(200)}\n`);
});

test("probe: the usage export holds no /tmp path", async () => {
  const r = probeRig("tmpcwd");
  assert.equal(await r.run("probe", "pi/x", "--model", "m"), 0);
  const dir = layoutOf(join(r.root, "home"), r.io.env).usageExport;
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.doesNotMatch(readFileSync(join(dir, files[0]!), "utf8"), /\/tmp\//);
});

test("probe: no model for pi, a missing account, or a bad id exits 2", async () => {
  const r = probeRig("ok");
  assert.equal(await r.run("probe", "pi/x"), 2);
  assert.equal(await r.run("probe", "pi/none", "--model", "m"), 2);
  assert.equal(await r.run("probe", "nope", "--model", "m"), 2);
  assert.deepEqual(r.fake.calls(), []);
});

const TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

test("add-token: makes a token account, strips the trailing newline, modes 0600 and 0700, prints no content", async () => {
  const r = rig();
  const from = join(r.root, "tok.txt");
  writeFileSync(from, `${TOKEN}\n`);
  assert.equal(await r.run("add-token", "claude/t1", "--from", from), 0);
  const home = layoutOf(join(r.root, "home"), r.io.env);
  const dir = join(home.accounts, "claude", "t1");
  assert.equal(readFileSync(join(dir, "token"), "utf8"), TOKEN);
  assert.equal(statSync(join(dir, "token")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(r.out.join(""), "added token account claude/t1\n");
  assert.ok(!r.out.join("").includes("sk-ant") && !r.err.join("").includes("sk-ant"));
  await r.run("list");
  assert.match(r.out.join(""), /claude\/t1\s+token/);
});

test("add-token: a non-claude runner, a duplicate, a missing file or a bad shape fails without a trace", async () => {
  const r = rig();
  const from = join(r.root, "tok.txt");
  writeFileSync(from, TOKEN);
  assert.equal(await r.run("add-token", "pi/t1", "--from", from), 1);
  assert.equal(existsSync(join(r.root, "home", "accounts", "pi", "t1")), false);
  assert.equal(await r.run("add-token", "claude/t1", "--from", from), 0);
  assert.equal(await r.run("add-token", "claude/t1", "--from", from), 1);
  assert.equal(await r.run("add-token", "claude/t2", "--from", join(r.root, "none")), 1);
  assert.equal(getAccount(openStoreOf(r).db, "claude/t2"), undefined);
  assert.equal(await r.run("add-token", "claude/t3"), 2);
  assert.ok(!r.err.join("").includes("sk-ant"));
});

function openStoreOf(r: Rig) {
  const home = layoutOf(join(r.root, "home"), r.io.env);
  return openStore({ dbPath: home.db, spoolDir: home.spool });
}

test("probe on a claude token account: prints the model the stream reports, tokens and room", async () => {
  const r = rig();
  const fake = makeFakeDocker(join(r.root, "bin"));
  fake.setModes("claude-ok");
  const from = join(r.root, "tok.txt");
  writeFileSync(from, `${TOKEN}\n`);
  const io: Io = { ...r.io, env: { ...r.io.env, SQUAD_DOCKER: fake.path } };
  assert.equal(await main(["add-token", "claude/x", "--from", from], io), 0);
  assert.equal(await main(["probe", "claude/x", "--model", "claude-sonnet-5-5"], io), 0);
  assert.equal(r.out.join("").split("\n").filter((l) => l.startsWith("claude/x ok")).join(""), "claude/x ok claude-opus-5-5 in=2 out=4 5h=92% week=70%");
  const run = fake.callsOf("run")[0]!;
  assert.ok(run.includes("claude-sonnet-5-5"), "the requested model is what runs");
  assert.deepEqual(fake.stdins(), ["Reply with the single word: ok"]);
  assert.ok(!run.join("\n").includes("sk-ant"));
  r.out.length = 0;
  assert.equal(await main(["list"], io), 0);
  const row = r.out.join("").trim().split("\n").map((l) => l.trim().split(/\s{2,}/)).find((c) => c[0] === "claude/x")!;
  assert.deepEqual([row[5], row[6]], ["92%", "70%"]);
});

test("probe on claude without --model is a usage error", async () => {
  const r = rig();
  seed(r, (s) => addAccount(s.db, { runner: "claude", name: "x", kind: "token" }, NOW));
  assert.equal(await r.run("probe", "claude/x"), 2);
});

// --- gc ---

function gcRig() {
  const r = rig();
  const fake = makeFakeDocker(join(r.root, "bin"));
  const home = layoutOf(join(r.root, "home"), r.io.env);
  const io: Io = { ...r.io, env: { ...r.io.env, SQUAD_DOCKER: fake.path } };
  const stg = join(home.staging, "pi-k1-abc");
  mkdirSync(stg, { recursive: true });
  const old = new Date(NOW.getTime() - 3 * 3_600_000);
  utimesSync(stg, old, old);
  seed(r, (s) => {
    s.startPass({ id: "LOST", startedAt: old.toISOString(), project: "p", flow: "f", action: "a", runner: "pi", model: "m" });
  });
  fake.setPs(["squad-gone", "LOST2", "exited", "2026-10-24 09:00:00 +0000 UTC"]);
  const passRow = () => {
    const s = openStore({ dbPath: home.db, spoolDir: home.spool });
    const row = { ...(s.db.prepare("SELECT outcome FROM passes WHERE id = 'LOST'").get() as { outcome: string | null }) };
    s.close();
    return row.outcome;
  };
  return { r, fake, io, stg, passRow };
}

test("gc --dry-run prints each action and changes nothing", async () => {
  const g = gcRig();
  assert.equal(await main(["gc", "--dry-run"], g.io), 0);
  assert.equal(g.r.out.join(""), "would remove container squad-gone\nwould end pass LOST as lost\nwould remove staging/pi-k1-abc\n");
  assert.ok(existsSync(g.stg));
  assert.equal(g.passRow(), null);
  assert.deepEqual(g.fake.calls().map((a) => a[0]), ["ps"], "only the read-only ps ran");
});

test("SQUAD_DRY_RUN=1 is a dry run too", async () => {
  const g = gcRig();
  assert.equal(await main(["gc"], { ...g.io, env: { ...g.io.env, SQUAD_DRY_RUN: "1" } }), 0);
  assert.match(g.r.out.join(""), /^would /);
  assert.ok(existsSync(g.stg));
});

test("gc does the work, then a second run has nothing to do", async () => {
  const g = gcRig();
  assert.equal(await main(["gc"], g.io), 0);
  assert.equal(g.r.out.join(""), "removed container squad-gone\nended pass LOST as lost\nremoved staging/pi-k1-abc\n");
  assert.ok(!existsSync(g.stg));
  assert.equal(g.passRow(), "lost");
  g.r.out.length = 0;
  assert.equal(await main(["gc"], g.io), 0);
  assert.equal(g.r.out.join(""), "nothing to clean\n");
});

test("SQUAD_NO_GC=1: gc says so and touches nothing, not even docker", async () => {
  const g = gcRig();
  assert.equal(await main(["gc"], { ...g.io, env: { ...g.io.env, SQUAD_NO_GC: "1" } }), 0);
  assert.equal(g.r.out.join(""), "gc is off (SQUAD_NO_GC=1); nothing done\n");
  assert.deepEqual(g.fake.calls(), []);
  assert.ok(existsSync(g.stg));
  assert.equal(g.passRow(), null);
});

test("gc takes no argument but --dry-run", async () => {
  const g = gcRig();
  assert.equal(await main(["gc", "now"], g.io), 2);
  assert.equal(await main(["gc", "--force"], g.io), 2);
  assert.deepEqual(g.fake.calls(), []);
});

/** A rig with a codex key account codex/x. */
function codexProbeRig(mode: string): Rig & { fake: ReturnType<typeof makeFakeDocker> } {
  const r = rig();
  const fake = makeFakeDocker(join(r.root, "bin"));
  fake.setModes(mode);
  seed(r, (s) => addAccount(s.db, { runner: "codex", name: "x", kind: "key" }, NOW));
  const home = layoutOf(join(r.root, "home"), r.io.env);
  mkdirSync(join(home.accounts, "codex", "x"), { recursive: true });
  writeFileSync(join(home.accounts, "codex", "x", "auth.json"), '{"fake":"not-a-real-key"}');
  const io: Io = { ...r.io, env: { ...r.io.env, SQUAD_DOCKER: fake.path } };
  return { ...r, io, fake, run: async (...argv) => main(argv, io) };
}

test("probe codex: ok prints the model asked for and the tokens", async () => {
  const r = codexProbeRig("codex-ok");
  assert.equal(await r.run("probe", "codex/x", "--model", "gpt-6.1-sol"), 0);
  assert.equal(r.out.join(""), "codex/x ok gpt-6.1-sol in=14081 out=5 5h=- week=-\n");
});

test("probe codex: model not found prints kind, code and the reason", async () => {
  const r = codexProbeRig("codex-model-not-found");
  assert.equal(await r.run("probe", "codex/x", "--model", "no-such-model"), 1);
  const out = r.out.join("");
  assert.match(out, /^codex\/x fail provider model_not_found\n/);
  assert.match(out, /reason: The 'no-such-model' model is not supported/);
});

test("probe codex: no --model is a usage error", async () => {
  const r = codexProbeRig("codex-ok");
  assert.equal(await r.run("probe", "codex/x"), 2);
});

// --- usage-read
const USAGE_FIXTURE = readFileSync(new URL("../../test/fixtures/captures/codex/usage.json", import.meta.url), "utf8");
const FAKE_TOKEN = "eyJfakeheader0123456789.eyJfakepayload0123456789.fakesignature0123";

function usageRig(names: string[], answers: Record<string, () => Response | Promise<Response>>): Rig & { urls: string[] } {
  const r = rig();
  seed(r, (s) => {
    for (const n of names) addAccount(s.db, { runner: "codex", name: n, kind: "login" }, NOW);
  });
  const home = layoutOf(join(r.root, "home"), r.io.env);
  for (const n of names) {
    mkdirSync(join(home.accounts, "codex", n), { recursive: true });
    // The account id tells the fake which answer to give.
    writeFileSync(join(home.accounts, "codex", n, "auth.json"), JSON.stringify({ tokens: { access_token: FAKE_TOKEN, account_id: n } }));
  }
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    const id = (init?.headers as Record<string, string>)["chatgpt-account-id"]!;
    return answers[id]!();
  }) as typeof globalThis.fetch;
  const io: Io = { ...r.io, fetch };
  return { ...r, io, urls, run: async (...argv) => main(argv, io) };
}

test("usage-read <account>: prints 5h, week and plan; the room lands in the database", async () => {
  const r = usageRig(["a"], { a: () => new Response(USAGE_FIXTURE) });
  assert.equal(await r.run("usage-read", "codex/a"), 0);
  assert.equal(r.out.join(""), "codex/a 5h=35% week=88% plan=team\n");
  assert.deepEqual(r.urls, ["https://chatgpt.com/backend-api/wham/usage"]);
  assert.equal(await r.run("list"), 0);
  assert.match(r.out.join(""), /codex\/a\s+login\s+-\s+active\s+ok\s+35%\s+88%/);
  assert.ok(!(r.out.join("") + r.err.join("")).includes("eyJfake"));
});

test("usage-read: 401 prints suspect (401) and marks the account; an error prints its short reason; exit 1", async () => {
  const r = usageRig(["a", "b"], { a: () => new Response("{}", { status: 401 }), b: () => new Response("{}", { status: 503 }) });
  assert.equal(await r.run("usage-read", "codex/a"), 1);
  assert.equal(await r.run("usage-read", "codex/b"), 1);
  assert.equal(r.out.join(""), "codex/a suspect (401)\ncodex/b error http 503\n");
  r.out.length = 0;
  assert.equal(await r.run("list"), 0);
  assert.match(r.out.join(""), /codex\/a\s+login\s+-\s+active\s+suspect/);
});

test("usage-read with no argument reads the accounts that are due, once each; a second run finds none due", async () => {
  const r = usageRig(["a", "b"], { a: () => new Response(USAGE_FIXTURE), b: () => new Response(USAGE_FIXTURE) });
  assert.equal(await r.run("usage-read"), 0);
  assert.equal(r.out.join(""), "codex/a 5h=35% week=88% plan=team\ncodex/b 5h=35% week=88% plan=team\n");
  r.out.length = 0;
  assert.equal(await r.run("usage-read"), 0);
  assert.equal(r.out.join(""), "nothing due\n");
  assert.equal(r.urls.length, 2);
});

test("usage-read: SQUAD_NO_USAGE_READ=1 reads nothing; a non-codex-login or unknown account is refused", async () => {
  const r = usageRig(["a"], { a: () => new Response(USAGE_FIXTURE) });
  const off: Io = { ...r.io, env: { ...r.io.env, SQUAD_NO_USAGE_READ: "1" } };
  assert.equal(await main(["usage-read", "codex/a"], off), 0);
  assert.equal(r.urls.length, 0);
  assert.match(r.out.join(""), /off/);
  assert.equal(await r.run("usage-read", "codex/nope"), 2);
  seed(r, (s) => addAccount(s.db, { runner: "pi", name: "k", kind: "key" }, NOW));
  assert.equal(await r.run("usage-read", "pi/k"), 1);
  assert.equal(r.urls.length, 0);
});

/** Event rows of an account, read from the rig's db. */
function eventsOf(r: Rig, account: string): { kind: string; code: string | null }[] {
  const home = layoutOf(join(r.root, "home"), r.io.env);
  const s = openStore({ dbPath: home.db, spoolDir: home.spool });
  try {
    return s.db.prepare("SELECT kind, code FROM events WHERE account = ? AND kind = 'owner-set'").all(account).map((x) => ({ kind: x.kind as string, code: x.code as string | null }));
  } finally {
    s.close();
  }
}

function ownerOf(r: Rig, id: string): string | null | undefined {
  const home = layoutOf(join(r.root, "home"), r.io.env);
  const s = openStore({ dbPath: home.db, spoolDir: home.spool });
  try {
    return getAccount(s.db, id)?.ownerEmail;
  } finally {
    s.close();
  }
}

function seedCodexLogin(r: Rig, name: string, email: string): void {
  seed(r, (s) => addAccount(s.db, { runner: "codex", name, kind: "login" }, NOW));
  const dir = join(layoutOf(join(r.root, "home"), r.io.env).accounts, "codex", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: fakeIdToken({ email }), access_token: "fake-a", refresh_token: "fake-r" } }));
}

test("owner: with an email on a key account sets it lowercased and logs a manual event", async () => {
  const r = rig();
  seed(r, (s) => addAccount(s.db, { runner: "pi", name: "k1", kind: "key" }, NOW));
  assert.equal(await r.run("owner", "pi/k1", "Bob@Example.TEST"), 0);
  assert.equal(ownerOf(r, "pi/k1"), "bob@example.test");
  assert.deepEqual(eventsOf(r, "pi/k1"), [{ kind: "owner-set", code: "manual" }]);
});

test("owner: a bad email or an unknown account is exit 2", async () => {
  const r = rig();
  seed(r, (s) => addAccount(s.db, { runner: "pi", name: "k1", kind: "key" }, NOW));
  assert.equal(await r.run("owner", "pi/k1", "not-an-email"), 2);
  assert.equal(await r.run("owner", "pi/k1", "a@b"), 2);
  assert.equal(await r.run("owner", "pi/nope", "a@b.co"), 2);
  assert.equal(await r.run("owner", "pi/nope"), 2);
  assert.equal(ownerOf(r, "pi/k1"), null);
});

test("owner: without an email, a codex login takes it from its ID token", async () => {
  const r = rig();
  seedCodexLogin(r, "c1", "Alice@Example.test");
  assert.equal(await r.run("owner", "codex/c1"), 0);
  assert.equal(r.out.join(""), "codex/c1 owner alice@example.test\n");
  assert.equal(ownerOf(r, "codex/c1"), "alice@example.test");
  assert.deepEqual(eventsOf(r, "codex/c1"), [{ kind: "owner-set", code: "login" }]);
  assert.ok(!(r.out.join("") + r.err.join("")).includes("fake-a"));
});

test("owner: without an email, a key or token account is exit 2 and says to give the email", async () => {
  const r = rig();
  seed(r, (s) => addAccount(s.db, { runner: "claude", name: "t1", kind: "token" }, NOW));
  assert.equal(await r.run("owner", "claude/t1"), 2);
  assert.match(r.err.join(""), /give the email: no identity in the files of a token account/);
});

test("owner: a codex login refuses an email that differs from its ID token", async () => {
  const r = rig();
  seedCodexLogin(r, "c1", "alice@example.test");
  assert.equal(await r.run("owner", "codex/c1", "mallory@example.test"), 1);
  assert.match(r.err.join(""), /the login belongs to another email/);
  assert.equal(ownerOf(r, "codex/c1"), null);
  assert.equal(await r.run("owner", "codex/c1", "ALICE@example.test"), 0);
  assert.equal(ownerOf(r, "codex/c1"), "alice@example.test");
  assert.deepEqual(eventsOf(r, "codex/c1"), [{ kind: "owner-set", code: "login" }]);
});

test("add-key and add-token take --owner, validated and stored", async () => {
  const r = rig();
  const key = join(r.root, "key.json");
  const tok = join(r.root, "tok");
  writeFileSync(key, KEY_BODY);
  writeFileSync(tok, "tok-value\n");
  assert.equal(await r.run("add-key", "pi/k1", "--from", key, "--owner", "Bob@Example.test"), 0);
  assert.equal(ownerOf(r, "pi/k1"), "bob@example.test");
  assert.equal(await r.run("add-token", "claude/t1", "--from", tok, "--owner", "carol@example.test"), 0);
  assert.equal(ownerOf(r, "claude/t1"), "carol@example.test");
  assert.equal(await r.run("add-key", "pi/k2", "--from", key, "--owner", "bad"), 2);
  assert.equal(await r.run("add-token", "claude/t2", "--from", tok, "--owner", "bad"), 2);
  assert.equal(ownerOf(r, "pi/k2"), undefined, "no account made on a bad owner");
  assert.equal(ownerOf(r, "claude/t2"), undefined);
});

test("the usage text lists owner and the --owner flags", async () => {
  const r = rig();
  await r.run();
  const u = r.err.join("");
  assert.match(u, /\n {2}owner <account> \[<email>\]/);
  assert.match(u, /add-key .*--owner/);
  assert.match(u, /add-token .*--owner/);
});

// ---- account care ----

const consentOf = (r: Rig, id: string): [string | null, string | null] | undefined => {
  let v: [string | null, string | null] | undefined;
  seed(r, (s) => {
    const a = getAccount(s.db, id);
    v = a === undefined ? undefined : [a.consentAt, a.consentBy];
  });
  return v;
};

test("add-key and add-token with --owner do not share the account (an admin may add it for someone else); without --owner the host shares it", async () => {
  const r = rig();
  const key = join(r.root, "key.json");
  const tok = join(r.root, "tok");
  writeFileSync(key, KEY_BODY);
  writeFileSync(tok, "tok-value\n");
  assert.equal(await r.run("add-key", "pi/k1", "--from", key, "--owner", "bob@example.test"), 0);
  assert.equal(await r.run("add-token", "claude/t1", "--from", tok, "--owner", "bob@example.test"), 0);
  assert.equal(await r.run("add-key", "pi/k2", "--from", key), 0);
  assert.deepEqual(consentOf(r, "pi/k1"), [null, null]);
  assert.deepEqual(consentOf(r, "claude/t1"), [null, null]);
  assert.deepEqual(consentOf(r, "pi/k2"), [NOW.toISOString(), "cli"]);
  assert.match(r.out.join(""), /not shared until bob@example\.test agrees in the web app/);
});

test("remove: needs --yes; removes the folder, keeps the row as removed, prints where to revoke; a removed name can be added again", async () => {
  const r = rig();
  const key = join(r.root, "key.json");
  writeFileSync(key, KEY_BODY);
  assert.equal(await r.run("add-key", "pi/k1", "--from", key), 0);
  const home = layoutOf(join(r.root, "home"), r.io.env);
  assert.equal(await r.run("remove", "pi/k1"), 2);
  assert.match(r.err.join(""), /--yes/);
  assert.ok(existsSync(join(home.accounts, "pi", "k1")));
  r.out.length = 0;
  assert.equal(await r.run("remove", "pi/k1", "--yes"), 0);
  assert.equal(existsSync(join(home.accounts, "pi", "k1")), false);
  assert.match(r.out.join(""), /removed pi\/k1/);
  assert.match(r.out.join(""), /API keys page/);
  let state: string | undefined;
  seed(r, (s) => { state = getAccount(s.db, "pi/k1")?.state; });
  assert.equal(state, "removed");
  assert.equal(await r.run("remove", "pi/k1", "--yes"), 1, "already removed");
  assert.equal(await r.run("remove", "pi/none", "--yes"), 2);
  assert.equal(await r.run("add-key", "pi/k1", "--from", key), 0, "the name is free again");
  r.out.length = 0;
  assert.equal(await r.run("list"), 0);
  assert.match(r.out.join(""), /pi\/k1/);
});

test("the usage text lists remove", async () => {
  const r = rig();
  await r.run();
  assert.match(r.err.join(""), /\n {2}remove <account> --yes/);
});
