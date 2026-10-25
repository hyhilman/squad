import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";
import { IMAGES } from "../images.ts";
import { makeLog } from "../log.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { openStore } from "../store/db.ts";
import { SQUAD_USAGE_READ_S_ENV, envNum } from "../settings.ts";
import { emptyHealth, type HealthRow } from "./health.ts";
import { addAccount, getHealth, roomSince, type AccountRow } from "./store.ts";
import { dueReads, parseCodexUsage, readBudget, readCodexUsage, refreshUsage, USAGE_URL } from "./usage-read.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const FIXTURE = JSON.parse(readFileSync(new URL("../../test/fixtures/captures/codex/usage.json", import.meta.url), "utf8"));
const FAKE_TOKEN = "eyJfakeheader0123456789.eyJfakepayload0123456789.fakesignature0123";
const FAKE_ACCOUNT = "00000000-0000-4000-8000-0000000000cc";

function accountDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-read-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: FAKE_TOKEN, refresh_token: "rt_fakefakefake", account_id: FAKE_ACCOUNT } }, null, 2), { mode: 0o600 });
  // An old mtime, so any rewrite shows.
  utimesSync(join(dir, "auth.json"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  return dir;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("parseCodexUsage on the capture: windows by length, left = 100 - used, resets in ISO, plan, limit", () => {
  const r = parseCodexUsage(FIXTURE);
  assert.deepEqual(r, {
    room: { left5h: 35, leftWeek: 88, resets5h: new Date(1792845721 * 1000).toISOString(), resetsWeek: new Date(1793414520 * 1000).toISOString() },
    plan: "team",
    limitReached: false,
  });
});

test("parseCodexUsage picks windows by limit_window_seconds, not by position, and clamps", () => {
  const swapped = { plan_type: null, rate_limit: { limit_reached: true, primary_window: { used_percent: 130, limit_window_seconds: 604800, reset_at: 1000 }, secondary_window: { used_percent: -4, limit_window_seconds: 18000, reset_at: 2000 } } };
  const r = parseCodexUsage(swapped);
  assert.equal(r.room.leftWeek, 0);
  assert.equal(r.room.left5h, 100);
  assert.equal(r.room.resets5h, new Date(2000_000).toISOString());
  assert.equal(r.plan, null);
  assert.equal(r.limitReached, true);
});

test("parseCodexUsage refuses an answer with no known window", () => {
  assert.throws(() => parseCodexUsage({ rate_limit: null }), /window/);
  assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 99, reset_at: 1 } } }), /window/);
});

test("readCodexUsage: ok sends the codex headers and the bearer, once, to the usage URL", async () => {
  const dir = accountDir();
  const seen: { url: string; headers: Record<string, string>; hasSignal: boolean }[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), hasSignal: init?.signal != null });
    return json(FIXTURE);
  };
  const r = await readCodexUsage(dir, f);
  assert.ok("ok" in r && r.ok.room.left5h === 35);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(USAGE_URL, seen[0]!.url);
  assert.equal(seen[0]!.headers["authorization"], `Bearer ${FAKE_TOKEN}`);
  assert.equal(seen[0]!.headers["chatgpt-account-id"], FAKE_ACCOUNT);
  assert.equal(seen[0]!.headers["originator"], "codex_cli_rs");
  assert.equal(seen[0]!.headers["user-agent"], `codex_cli_rs/${IMAGES.codex.version}`);
  assert.ok(seen[0]!.hasSignal, "a timeout signal is set");
});

test("readCodexUsage: 401 and 403 are suspect; other answers and network errors are errors with a short reason", async () => {
  const dir = accountDir();
  assert.deepEqual(await readCodexUsage(dir, async () => json({}, 401)), { suspect: true });
  assert.deepEqual(await readCodexUsage(dir, async () => json({}, 403)), { suspect: true });
  assert.deepEqual(await readCodexUsage(dir, async () => json({}, 500)), { error: "http 500" });
  assert.deepEqual(await readCodexUsage(dir, async () => new Response("<html>", { status: 200 })), { error: "bad answer" });
  assert.deepEqual(await readCodexUsage(dir, async () => json({ rate_limit: null })), { error: "bad answer" });
  const net = await readCodexUsage(dir, async () => { throw new Error(`connect failed Bearer ${FAKE_TOKEN}`); });
  assert.deepEqual(net, { error: "network error" });
  const timeout = await readCodexUsage(dir, async () => { throw new DOMException("t", "TimeoutError"); });
  assert.deepEqual(timeout, { error: "timeout" });
});

test("readCodexUsage: a missing or tokenless auth file is an error and no request is made", async () => {
  let calls = 0;
  const f = async (): Promise<Response> => { calls++; return json(FIXTURE); };
  const empty = mkdtempSync(join(tmpdir(), "usage-read-"));
  assert.deepEqual(await readCodexUsage(empty, f), { error: "no login" });
  writeFileSync(join(empty, "auth.json"), "{not json");
  assert.deepEqual(await readCodexUsage(empty, f), { error: "no login" });
  writeFileSync(join(empty, "auth.json"), JSON.stringify({ tokens: {} }));
  assert.deepEqual(await readCodexUsage(empty, f), { error: "no login" });
  assert.equal(calls, 0);
});

test("the auth file is byte-identical, mtime unchanged and no file is added, after ok, 401 and error", async () => {
  const dir = accountDir();
  const path = join(dir, "auth.json");
  const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs, names: readdirSync(dir) };
  for (const f of [async () => json(FIXTURE), async () => json({}, 401), async () => json({}, 500), async () => { throw new Error("x"); }]) {
    await readCodexUsage(dir, f);
    assert.ok(readFileSync(path).equals(before.bytes));
    assert.equal(statSync(path).mtimeMs, before.mtime);
    assert.deepEqual(readdirSync(dir), before.names);
  }
});

test("no result carries the token or any auth content; findForbidden is clean", async () => {
  const dir = accountDir();
  const results = [
    await readCodexUsage(dir, async () => json(FIXTURE)),
    await readCodexUsage(dir, async () => json({}, 401)),
    await readCodexUsage(dir, async () => json({}, 502)),
    await readCodexUsage(dir, async () => { throw new Error(`boom ${FAKE_TOKEN} ${FAKE_ACCOUNT}`); }),
  ];
  for (const r of results) {
    const text = JSON.stringify(r);
    assert.ok(!text.includes("eyJfake") && !text.includes(FAKE_ACCOUNT) && !text.includes("rt_fake"), text);
    assert.equal(findForbidden(r), undefined);
  }
});

function seedHome() {
  const root = mkdtempSync(join(tmpdir(), "usage-home-"));
  const home = layoutOf(join(root, "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  addAccount(store.db, { runner: "codex", name: "a", kind: "login" }, NOW);
  const dir = join(home.accounts, "codex", "a");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: FAKE_TOKEN, account_id: FAKE_ACCOUNT } }));
  return { home, store, dir };
}

test("refreshUsage: ok writes the room and read_at; 401 marks suspect and writes one usage-401 event; logs hold no secret", async () => {
  const { home, store } = seedHome();
  const lines: string[] = [];
  const log = makeLog((l) => lines.push(l));
  const a = store.db.prepare("SELECT id FROM accounts").get() as { id: string };
  const acct = { id: a.id, runner: "codex", name: "a", kind: "login" } as AccountRow;
  const ok = await refreshUsage(store, home, acct, async () => json(FIXTURE), NOW, log);
  assert.ok("ok" in ok);
  const h1 = getHealth(store.db, "codex/a");
  assert.equal(h1.left5h, 35);
  assert.equal(h1.leftWeek, 88);
  assert.equal(h1.readAt, NOW.toISOString());
  assert.equal(h1.suspectSince, null);
  assert.deepEqual(roomSince(store.db, "codex/a", new Date(0)), [{ at: NOW.toISOString(), source: "read", left5h: 35, leftWeek: 88 }]);
  const later = new Date(NOW.getTime() + 600_000);
  const bad = await refreshUsage(store, home, acct, async () => json({}, 401), later, log);
  assert.deepEqual(bad, { suspect: true });
  const h2 = getHealth(store.db, "codex/a");
  assert.equal(h2.suspectSince, later.toISOString());
  assert.equal(h2.left5h, 35, "the old room stays");
  assert.equal((store.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'usage-401' AND account = 'codex/a'").get() as { n: number }).n, 1);
  await refreshUsage(store, home, acct, async () => json({}, 401), new Date(later.getTime() + 600_000), log);
  assert.equal((store.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'usage-401'").get() as { n: number }).n, 1, "no second event while still suspect");
  assert.equal(getHealth(store.db, "codex/a").suspectSince, later.toISOString(), "the first suspicion time is kept");
  assert.equal(roomSince(store.db, "codex/a", new Date(0)).length, 1, "a 401 is no reading");
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(!l.includes("eyJfake") && !l.includes(FAKE_ACCOUNT), l);
  store.close();
});

// --- applyRead is in health.ts; its tests sit here with the read they serve.
import { applyRead } from "./health.ts";
const base = (more: Partial<HealthRow> = {}): HealthRow => ({ ...emptyHealth("codex/a"), ...more });
const okRead = { ok: { room: { left5h: 35, leftWeek: 88 }, plan: "team", limitReached: false } };

test("applyRead ok: copies room and read_at, never clears suspicion, cool-down or fails", () => {
  const prev = base({ suspectSince: "2026-10-24T11:00:00.000Z", authFails: 1, coolUntil: "2026-10-24T13:00:00.000Z", coolKind: "quota", left5h: 90 });
  const r = applyRead(prev, okRead, NOW);
  assert.equal(r.health.left5h, 35);
  assert.equal(r.health.leftWeek, 88);
  assert.equal(r.health.readAt, NOW.toISOString());
  assert.equal(r.health.suspectSince, "2026-10-24T11:00:00.000Z");
  assert.equal(r.health.authFails, 1);
  assert.equal(r.health.coolUntil, "2026-10-24T13:00:00.000Z");
  assert.equal(r.event, undefined);
});

test("applyRead suspect: sets suspect_since once and gives event usage-401; error changes nothing", () => {
  const first = applyRead(base(), { suspect: true }, NOW);
  assert.equal(first.health.suspectSince, NOW.toISOString());
  assert.deepEqual(first.event, { kind: "usage-401", code: "401" });
  const again = applyRead(first.health, { suspect: true }, new Date(NOW.getTime() + 1000));
  assert.equal(again.health.suspectSince, NOW.toISOString());
  assert.equal(again.event, undefined);
  const prev = base({ left5h: 50 });
  const e = applyRead(prev, { error: "http 500" }, NOW);
  assert.deepEqual(e.health, prev);
  assert.equal(e.event, undefined);
});

// --- the schedule
const acct = (name: string, more: Partial<AccountRow> = {}): AccountRow => ({ id: `codex/${name}`, runner: "codex", name, kind: "login", ownerEmail: null, state: "active", deadCode: null, deadAt: null, floor5h: null, floorWeek: null, createdAt: "x", consentAt: null, loginEmail: null, consentBy: null, cap5h: null, capWeek: null, cap30d: null, balanceUsd: null, balanceAt: null, ...more });
const hmap = (...rows: HealthRow[]): Map<string, HealthRow> => new Map(rows.map((r) => [r.account, r]));
const ago = (s: number): string => new Date(NOW.getTime() - s * 1000).toISOString();
const INTERVAL = 300_000;

test("the interval is a setting, 300 seconds by default", () => {
  assert.equal(envNum(SQUAD_USAGE_READ_S_ENV, {}), 300);
});

test("dueReads: codex login accounts only; stale or never read; not suspect, dead, key or other runners", () => {
  const accounts = [
    acct("fresh"), acct("stale"), acct("never"), acct("susp"), acct("dead", { state: "dead" }),
    acct("key", { kind: "key" }), { ...acct("p"), id: "pi/p", runner: "pi" as const },
  ];
  const h = hmap(
    { ...emptyHealth("codex/fresh"), readAt: ago(100) },
    { ...emptyHealth("codex/stale"), readAt: ago(400) },
    { ...emptyHealth("codex/susp"), readAt: ago(400), suspectSince: ago(50) },
  );
  const due = dueReads(accounts, h, NOW, INTERVAL, undefined, Infinity);
  assert.deepEqual(due.map((a) => a.id), ["codex/never", "codex/stale"], "never read first, then oldest");
});

test("dueReads: at most ceil(n / minutes-in-interval) per call, oldest first; SQUAD_NO_USAGE_READ=1 gives none", () => {
  const accounts = ["a", "b", "c", "d", "e", "f", "g"].map((n) => acct(n));
  const h = hmap(...accounts.map((a, i) => ({ ...emptyHealth(a.id), readAt: ago(1000 + i * 10) })));
  assert.equal(readBudget(7, INTERVAL), 2);
  assert.equal(readBudget(5, INTERVAL), 1);
  assert.equal(readBudget(1, INTERVAL), 1);
  assert.equal(readBudget(0, INTERVAL), 0);
  const due = dueReads(accounts, h, NOW, INTERVAL);
  assert.deepEqual(due.map((a) => a.id), ["codex/g", "codex/f"], "the two oldest reads");
  assert.deepEqual(dueReads(accounts, h, NOW, INTERVAL, { SQUAD_NO_USAGE_READ: "1" }), []);
});
