import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { makeFakeDocker } from "../test/fake-docker.ts";
import { addAccount } from "./accounts/store.ts";
import { dockerPsArgv } from "./docker.ts";
import { executeGc, gatherGcState, gcSettings, parsePs, planGc, type GcSettings, type GcState } from "./gc.ts";
import { ensureHome, layoutOf } from "./home.ts";
import { makeLog } from "./log.ts";
import { pinSession } from "./sessions.ts";
import { openStore } from "./store/db.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const H = 3_600_000;
const D = 24 * H;
const S: GcSettings = { graceS: 7, keepPassesD: 400, keepLogsD: 30, sessionTtlD: 7, deadlineMs: 2 * H };
const home = layoutOf("/h/.squad", {});

const state = (more: Partial<GcState> = {}): GcState => ({ home, containers: [], passes: [], staging: [], logs: [], sessions: [], ...more });
const c = (name: string, passId: string, st: string, createdAt: Date | null = ago(10 * 60_000), purpose = "") => ({ name, passId, state: st, createdAt, purpose });
const p = (id: string, startedAgo: number, ended = true) => ({ id, startedAt: ago(startedAgo).toISOString(), endedAt: ended ? ago(startedAgo - 1000).toISOString() : null });

test("parsePs reads the four tab-separated fields; an empty label stays empty; a bad date is null", () => {
  const rows = parsePs("squad-a\tP1\trunning\t2026-10-24 09:00:00 +0000 UTC\nplain\t\texited\t2026-10-24 09:00:00 +0200 CEST\nodd\tP2\trunning\tnot a date\n\n");
  assert.deepEqual(rows.map((r) => [r.name, r.passId, r.state]), [["squad-a", "P1", "running"], ["plain", "", "exited"], ["odd", "P2", "running"]]);
  assert.equal(rows[0]!.createdAt!.toISOString(), "2026-10-24T09:00:00.000Z");
  assert.equal(rows[1]!.createdAt!.toISOString(), "2026-10-24T07:00:00.000Z");
  assert.equal(rows[2]!.createdAt, null);
});

test("the ps argv filters on the squad.pass label and asks for the five fields", () => {
  const a = dockerPsArgv();
  assert.deepEqual(a.slice(0, 4), ["ps", "-a", "--filter", "label=squad.pass"]);
  assert.equal(a[4], "--format");
  assert.equal(a[5], '{{.Names}}\\t{{.Label "squad.pass"}}\\t{{.State}}\\t{{.CreatedAt}}\\t{{.Label "squad.purpose"}}');
});

test("a running container whose pass already ended is an orphan: stop with the grace time, then rm -f", () => {
  const acts = planGc(state({ containers: [c("squad-a", "A", "running")], passes: [p("A", H)] }), NOW, S);
  assert.deepEqual(acts, [{ kind: "stop-container", name: "squad-a", graceS: 7 }, { kind: "remove-container", name: "squad-a", force: true }]);
});

test("a running container with no pass row is an orphan only when older than the deadline", () => {
  assert.deepEqual(planGc(state({ containers: [c("squad-a", "A", "running", ago(2 * H + 1000))] }), NOW, S).map((a) => a.kind), ["stop-container", "remove-container"]);
  assert.deepEqual(planGc(state({ containers: [c("squad-a", "A", "running", ago(2 * H - 1000))] }), NOW, S), []);
  assert.deepEqual(planGc(state({ containers: [c("squad-a", "A", "running", null)] }), NOW, S), [], "an unknown age is left alone");
});

test("a running container of an open pass is left alone", () => {
  assert.deepEqual(planGc(state({ containers: [c("squad-a", "A", "running", ago(5 * H))], passes: [p("A", 5 * H, false)] }), NOW, S), []);
});

test("an exited container is removed without force; a paused or odd state is left", () => {
  const acts = planGc(state({ containers: [c("x1", "A", "exited"), c("x2", "B", "created"), c("x3", "C", "dead"), c("x4", "D", "paused")], passes: [p("A", H), p("B", H), p("C", H), p("D", H)] }), NOW, S);
  assert.deepEqual(acts, [
    { kind: "remove-container", name: "x1", force: false },
    { kind: "remove-container", name: "x2", force: false },
    { kind: "remove-container", name: "x3", force: false },
  ]);
});

test("a container row without the squad.pass label is never touched", () => {
  const rows = [c("plain-1", "", "running", ago(9 * H)), c("plain-2", "", "exited")];
  assert.deepEqual(planGc(state({ containers: rows }), NOW, S), []);
});

test("an open pass with no live container, older than 1 hour, is ended as lost", () => {
  const acts = planGc(state({ passes: [p("OLD", 2 * H, false), p("NEW", 30 * 60_000, false), p("LIVE", 2 * H, false), p("DONE", 2 * H)], containers: [c("squad-live", "LIVE", "running", ago(2 * H))] }), NOW, S);
  assert.deepEqual(acts, [{ kind: "end-pass", id: "OLD" }]);
});

test("when the container list is unknown (docker failed) no container, pass or staging action is planned", () => {
  const acts = planGc(state({ containers: null, passes: [p("OLD", 2 * H, false)], staging: [{ path: join(home.staging, "pi-k1-abc"), mtime: ago(5 * H) }] }), NOW, S);
  assert.deepEqual(acts, []);
});

test("staging folders older than 1 hour are removed, but only when no pass container is running", () => {
  const old = { path: join(home.staging, "pi-k1-abc"), mtime: ago(90 * 60_000) };
  const young = { path: join(home.staging, "pi-k1-def"), mtime: ago(10 * 60_000) };
  assert.deepEqual(planGc(state({ staging: [old, young] }), NOW, S), [{ kind: "remove-path", path: old.path }]);
  const busy = planGc(state({ staging: [old], containers: [c("squad-a", "A", "running")], passes: [p("A", 60_000, false)] }), NOW, S);
  assert.deepEqual(busy, [], "a live pass may still read its copy");
});

test("retention: pass rows past 400 days go, logs past 30 days go; events have no action", () => {
  const oldLog = { path: join(home.passLogs, "2026-09-01", "P.log"), mtime: ago(31 * D) };
  const newLog = { path: join(home.passLogs, "2026-10-10", "Q.log"), mtime: ago(29 * D) };
  const oldUse = { path: join(home.usageExport, "P.jsonl"), mtime: ago(31 * D) };
  const acts = planGc(state({ passes: [p("OLD", 401 * D), p("KEEP", 399 * D)], logs: [oldLog, newLog, oldUse] }), NOW, S);
  assert.deepEqual(acts, [{ kind: "delete-pass", id: "OLD" }, { kind: "remove-path", path: oldLog.path }, { kind: "remove-path", path: oldUse.path }]);
  assert.ok(acts.every((a) => !JSON.stringify(a).includes("event")));
});

test("an open pass past retention is deleted, not also ended", () => {
  const acts = planGc(state({ passes: [p("ANCIENT", 500 * D, false)] }), NOW, S);
  assert.deepEqual(acts, [{ kind: "delete-pass", id: "ANCIENT" }]);
});

test("a session unused past the TTL loses its folder and its row", () => {
  const acts = planGc(state({ sessions: [
    { runner: "pi", id: "old", account: "pi/k1", lastUsedAt: ago(8 * D).toISOString() },
    { runner: "pi", id: "fresh", account: "pi/k1", lastUsedAt: ago(6 * D).toISOString() },
  ] }), NOW, S);
  assert.deepEqual(acts, [{ kind: "remove-path", path: join(home.sessions, "pi", "k1", "old") }, { kind: "delete-session", runner: "pi", id: "old" }]);
});

test("the planner drops any path under accounts/ or locks/, or outside the folders it owns", () => {
  const bad = [join(home.accounts, "pi", "k1", "auth.json"), join(home.locks, "pi", "k1.lock"), join(home.root, "state", "squad.db"), "/etc/passwd"];
  const files = bad.map((path) => ({ path, mtime: ago(900 * D) }));
  assert.deepEqual(planGc(state({ logs: files, staging: files }), NOW, S), []);
  // A session whose account name climbs out of sessions/ is dropped too.
  const acts = planGc(state({ sessions: [{ runner: "pi", id: "x", account: "pi/../../accounts/pi/k1", lastUsedAt: ago(30 * D).toISOString() }] }), NOW, S);
  assert.ok(acts.every((a) => a.kind !== "remove-path"));
});

test("gcSettings reads the keep and TTL settings with their defaults", () => {
  assert.deepEqual(gcSettings({}), { graceS: 20, keepPassesD: 400, keepLogsD: 30, sessionTtlD: 7, deadlineMs: 2 * H });
  assert.deepEqual(gcSettings({ SQUAD_KEEP_PASSES_D: "9", SQUAD_KEEP_LOGS_D: "3", SQUAD_SESSION_TTL_D: "1", SQUAD_STOP_GRACE_S: "5" }), { graceS: 5, keepPassesD: 9, keepLogsD: 3, sessionTtlD: 1, deadlineMs: 2 * H });
});

// --- on a real (throwaway) home with the fake docker ---

function populated() {
  const root = mkdtempSync(join(tmpdir(), "gc-"));
  const h = layoutOf(join(root, "home"), {});
  ensureHome(h);
  const store = openStore({ dbPath: h.db, spoolDir: h.spool });
  const fake = makeFakeDocker(join(root, "bin"));
  const old = (path: string, ageMs: number): void => utimesSync(path, ago(ageMs), ago(ageMs));
  const file = (path: string, body = "x"): string => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    return path;
  };
  // What must survive.
  addAccount(store.db, { runner: "pi", name: "k1", kind: "key" }, NOW);
  const auth = file(join(h.accounts, "pi", "k1", "auth.json"), '{"fake":"x"}');
  const lock = file(join(h.locks, "pi", "k1.lock"), "");
  old(auth, 900 * D);
  old(lock, 900 * D);
  // What must go.
  const stg = join(h.staging, "pi-k1-abc");
  mkdirSync(stg, { recursive: true });
  old(stg, 3 * H);
  const log = file(join(h.passLogs, "2026-08-01", "OLDP.log"));
  old(log, 60 * D);
  const use = file(join(h.usageExport, "OLDP.jsonl"));
  old(use, 60 * D);
  const sdir = join(h.sessions, "pi", "k1", "stale");
  file(join(sdir, "t.jsonl"));
  pinSession(store.db, "pi", "stale", "pi/k1", ago(10 * D));
  pinSession(store.db, "pi", "live", "pi/k1", ago(D));
  file(join(h.sessions, "pi", "k1", "live", "t.jsonl"));
  const start = (id: string, ago_: number) => store.startPass({ id, startedAt: ago(ago_).toISOString(), project: "p", flow: "f", action: "a", runner: "pi", account: "pi/k1", model: "m" });
  start("LOST", 3 * H);
  start("ENDED", 3 * H);
  store.endPass({ id: "ENDED", endedAt: ago(3 * H - 1000).toISOString(), outcome: "ok", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  start("ANCIENT", 500 * D);
  store.event({ at: ago(500 * D).toISOString(), kind: "x", account: "pi/k1" });
  fake.setPs(
    ["squad-orphan", "ENDED", "running", "2026-10-24 09:00:00 +0000 UTC"],
    ["squad-done", "ENDED", "exited", "2026-10-24 09:00:00 +0000 UTC"],
    ["squad-ghost", "NOPE", "running", "2026-10-24 08:00:00 +0000 UTC"],
  );
  return { h, store, fake, auth, lock, stg, log, use, sdir };
}

const deps = (r: ReturnType<typeof populated>) => ({ docker: r.fake.path, store: r.store, home: r.h, now: () => NOW, log: makeLog(() => {}) });

test("gather + plan over a populated home never plans a path under accounts/ or locks/", async () => {
  const r = populated();
  const acts = planGc(await gatherGcState(deps(r)), NOW, S);
  assert.ok(acts.length > 5);
  const paths = acts.flatMap((a) => (a.kind === "remove-path" ? [a.path] : []));
  assert.ok(paths.length >= 4);
  for (const path of paths) {
    for (const guarded of [r.h.accounts, r.h.locks]) assert.ok(path !== guarded && !path.startsWith(guarded + sep), `${path} is under ${guarded}`);
  }
  assert.deepEqual(new Set(paths), new Set([r.stg, r.log, r.use, r.sdir]));
});

test("executeGc does the plan; accounts and locks stay; the second run plans nothing", async () => {
  const r = populated();
  const actions = planGc(await gatherGcState(deps(r)), NOW, S);
  const res = await executeGc(actions, deps(r));
  assert.deepEqual(res.failed, []);
  assert.ok(existsSync(r.auth) && existsSync(r.lock));
  assert.ok(!existsSync(r.stg) && !existsSync(r.log) && !existsSync(r.use) && !existsSync(r.sdir));
  assert.ok(existsSync(join(r.h.sessions, "pi", "k1", "live", "t.jsonl")));
  const left = (r.store.db.prepare("SELECT id, outcome FROM passes ORDER BY id").all() as { id: string; outcome: string | null }[]).map((x) => ({ ...x }));
  assert.deepEqual(left, [{ id: "ENDED", outcome: "ok" }, { id: "LOST", outcome: "lost" }]);
  assert.equal((r.store.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n, 1, "events are kept");
  assert.deepEqual((r.store.db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((x) => x.id), ["live"]);
  assert.ok(!existsSync(join(r.h.passLogs, "2026-08-01")), "the empty day folder goes with its last log");
  // Docker saw: stop then rm -f for the orphans, plain rm for the exited one.
  const subs = r.fake.calls().filter((a) => a[0] === "stop" || a[0] === "rm");
  assert.deepEqual(subs, [["stop", "-t", "7", "squad-orphan"], ["rm", "-f", "squad-orphan"], ["rm", "squad-done"], ["stop", "-t", "7", "squad-ghost"], ["rm", "-f", "squad-ghost"]]);
  assert.deepEqual(planGc(await gatherGcState(deps(r)), NOW, S), []);
});

test("gather folds a spool file first", async () => {
  const r = populated();
  writeFileSync(join(r.h.spool, "999.jsonl"), `${JSON.stringify({ op: "event", row: { at: NOW.toISOString(), kind: "spooled" } })}\n`);
  await gatherGcState(deps(r));
  assert.deepEqual(readdirSync(r.h.spool), []);
  assert.equal((r.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'spooled'").get() as { n: number }).n, 1);
});

test("when docker cannot be run, gather reports containers as unknown and the plan skips them", async () => {
  const r = populated();
  const st = await gatherGcState({ ...deps(r), docker: join(r.h.root, "no-such-docker") });
  assert.equal(st.containers, null);
  const acts = planGc(st, NOW, S);
  assert.ok(acts.every((a) => a.kind !== "end-pass" && a.kind !== "stop-container" && a.kind !== "remove-container"));
  assert.ok(!acts.some((a) => a.kind === "remove-path" && a.path === r.stg));
});

test("parsePs reads the purpose label; a missing one stays empty", () => {
  const rows = parsePs("a\tP1\trunning\t2026-10-24 09:00:00 +0000 UTC\tshell\nb\tP2\trunning\t2026-10-24 09:00:00 +0000 UTC\t\nc\tP3\trunning\t2026-10-24 09:00:00 +0000 UTC\n");
  assert.deepEqual(rows.map((r) => r.purpose), ["shell", "", ""]);
});

test("a running login or shell container is never stopped, of any age, with or without a pass row", () => {
  for (const purpose of ["login", "shell"]) {
    const old = ago(30 * D);
    assert.deepEqual(planGc(state({ containers: [c("squad-x", "X", "running", old, purpose)] }), NOW, S), [], `${purpose}, no row`);
    assert.deepEqual(planGc(state({ containers: [c("squad-x", "X", "running", old, purpose)], passes: [p("X", 29 * D)] }), NOW, S), [], `${purpose}, ended row`);
  }
});

test("an exited login or shell container is still removed", () => {
  assert.deepEqual(planGc(state({ containers: [c("squad-x", "X", "exited", ago(H), "shell")] }), NOW, S), [{ kind: "remove-container", name: "squad-x", force: false }]);
});

test("a running orphan with purpose pass, or with no purpose label, is still stopped", () => {
  for (const purpose of ["pass", ""]) {
    assert.deepEqual(planGc(state({ containers: [c("squad-a", "A", "running", ago(3 * H), purpose)] }), NOW, S).map((a) => a.kind), ["stop-container", "remove-container"], purpose);
  }
});
