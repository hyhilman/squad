import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pick } from "../pool/pick.ts";
import { openStore, type Store } from "../store/db.ts";
import { emptyHealth } from "./health.ts";
import { addAccount, candidates, getAccount, getHealth, liveAccount, listAccounts, markRemoved, putHealth, resetHealth, reviveByLogin, setConsent, setOwnerBalance, setOwnerCaps, setOwnerFloors, setSharing, setState } from "./store.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const mk = (): Store => {
  const d = mkdtempSync(join(tmpdir(), "acc-"));
  return openStore({ dbPath: join(d, "squad.db"), spoolDir: join(d, "spool") });
};
const never = (): boolean => false;

test("addAccount makes id runner/name, active, with no floors", () => {
  const s = mk();
  const a = addAccount(s.db, { runner: "pi", name: "k1", kind: "key", ownerEmail: "o@example.com" }, NOW);
  assert.equal(a.id, "pi/k1");
  assert.equal(a.state, "active");
  assert.equal(a.ownerEmail, "o@example.com");
  assert.equal(a.floor5h, null);
  assert.deepEqual(getAccount(s.db, "pi/k1"), a);
  assert.equal(getAccount(s.db, "pi/none"), undefined);
});

test("a duplicate, an unsafe name or a bad kind is refused", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "k1", kind: "key" }, NOW);
  assert.throws(() => addAccount(s.db, { runner: "pi", name: "k1", kind: "key" }, NOW));
  assert.throws(() => addAccount(s.db, { runner: "pi", name: "../x", kind: "key" }, NOW), /name/);
  assert.throws(() => addAccount(s.db, { runner: "pi", name: "t", kind: "token" }, NOW), /token/);
  assert.throws(() => addAccount(s.db, { runner: "claude", name: "k", kind: "key" }, NOW), /key/);
  assert.equal(getAccount(s.db, "claude/k"), undefined);
});

test("listAccounts filters by runner", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "b", kind: "key" }, NOW);
  addAccount(s.db, { runner: "pi", name: "a", kind: "key" }, NOW);
  addAccount(s.db, { runner: "codex", name: "c", kind: "login" }, NOW);
  assert.deepEqual(listAccounts(s.db).map((a) => a.id), ["codex/c", "pi/a", "pi/b"]);
  assert.deepEqual(listAccounts(s.db, "pi").map((a) => a.id), ["pi/a", "pi/b"]);
});

test("candidates join health, use the default floor and ask the busy callback", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "a", kind: "key" }, NOW);
  addAccount(s.db, { runner: "pi", name: "b", kind: "key" }, NOW);
  s.db.prepare("UPDATE accounts SET floor_5h = 25 WHERE id = 'pi/b'").run();
  putHealth(s.db, { ...emptyHealth("pi/a"), left5h: 70, leftWeek: 60, readAt: NOW.toISOString(), lastUsedAt: "2026-10-24T11:00:00.000Z" });
  const c = candidates(s.db, "pi", NOW, (id) => id === "pi/b", {});
  const a = c.find((x) => x.account === "pi/a")!;
  const b = c.find((x) => x.account === "pi/b")!;
  assert.equal(a.floor5h, 10, "SQUAD_FLOOR_DEFAULT");
  assert.equal(a.floorWeek, 10);
  assert.equal(b.floor5h, 25);
  assert.equal(a.left5h, 70);
  assert.equal(a.lastUsedAt, "2026-10-24T11:00:00.000Z");
  assert.equal(a.busy, false);
  assert.equal(b.busy, true);
  assert.equal(a.health, "ok");
});

test("the default floor comes from SQUAD_FLOOR_DEFAULT", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "a", kind: "key" }, NOW);
  assert.equal(candidates(s.db, "pi", NOW, never, { SQUAD_FLOOR_DEFAULT: "33" })[0]!.floor5h, 33);
});

test("candidates map state, suspicion and cool-down to the pick health", () => {
  const s = mk();
  for (const n of ["dead", "off", "sus", "cool", "past"]) addAccount(s.db, { runner: "pi", name: n, kind: "key" }, NOW);
  setState(s.db, "pi/dead", "dead", "token_revoked", NOW);
  setState(s.db, "pi/off", "disabled");
  putHealth(s.db, { ...emptyHealth("pi/sus"), suspectSince: NOW.toISOString(), authFails: 1 });
  putHealth(s.db, { ...emptyHealth("pi/cool"), coolUntil: "2026-10-24T12:05:00.000Z", coolKind: "rate-limit" });
  putHealth(s.db, { ...emptyHealth("pi/past"), coolUntil: "2026-10-24T11:00:00.000Z", coolKind: "rate-limit" });
  const h = Object.fromEntries(candidates(s.db, "pi", NOW, never, {}).map((c) => [c.account, c.health]));
  assert.deepEqual(h, { "pi/dead": "dead", "pi/off": "disabled", "pi/sus": "suspect", "pi/cool": "cooling", "pi/past": "ok" });
  assert.deepEqual(pick(candidates(s.db, "pi", NOW, never, {}), NOW.getTime()).order, ["pi/past"]);
});

const TOK = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const usedPass = (s: Store, id: string, account: string, hoursAgo: number, cli: number): void => {
  const at = new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  s.startPass({ id, startedAt: at, project: "x", flow: "f", action: "a", runner: "pi", model: "m", account });
  s.endPass({ id, endedAt: at, outcome: "ok", tokens: TOK, cliCostUsd: cli });
};

test("setOwnerCaps stores the dollar caps; null clears one", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "k", kind: "key" }, NOW);
  assert.deepEqual([getAccount(s.db, "pi/k")!.cap5h, getAccount(s.db, "pi/k")!.capWeek, getAccount(s.db, "pi/k")!.cap30d], [null, null, null]);
  setOwnerCaps(s.db, "pi/k", 1.5, null, 40);
  const a = getAccount(s.db, "pi/k")!;
  assert.deepEqual([a.cap5h, a.capWeek, a.cap30d], [1.5, null, 40]);
  assert.throws(() => setOwnerCaps(s.db, "pi/none", 1, 1, 1), /unknown account/);
});

test("no cap: the pick is the same as before caps, whatever the key used", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "a", kind: "key" }, NOW);
  addAccount(s.db, { runner: "pi", name: "b", kind: "key" }, NOW);
  usedPass(s, "P1", "pi/a", 1, 500);
  const c = candidates(s.db, "pi", NOW, never, {});
  assert.deepEqual(c.map((x) => x.capReached), [false, false]);
  assert.deepEqual(pick(c, NOW.getTime()).order, ["pi/a", "pi/b"]);
});

test("a cap reached in its window refuses the key; under the cap, or used outside the window, it is picked", () => {
  const s = mk();
  for (const n of ["h5", "week", "d30", "under", "old"]) addAccount(s.db, { runner: "pi", name: n, kind: "key" }, NOW);
  usedPass(s, "P1", "pi/h5", 1, 2);
  setOwnerCaps(s.db, "pi/h5", 2, null, null);
  usedPass(s, "P2", "pi/week", 48, 10);
  setOwnerCaps(s.db, "pi/week", 100, 9.5, null);
  usedPass(s, "P3", "pi/d30", 24 * 20, 30);
  setOwnerCaps(s.db, "pi/d30", null, null, 30);
  usedPass(s, "P4", "pi/under", 1, 1.99);
  setOwnerCaps(s.db, "pi/under", 2, 2, 2);
  usedPass(s, "P5", "pi/old", 6, 50);
  setOwnerCaps(s.db, "pi/old", 1, null, null);
  const r = pick(candidates(s.db, "pi", NOW, never, {}), NOW.getTime());
  assert.deepEqual(r.order, ["pi/old", "pi/under"]);
  assert.deepEqual(r.skipped, { "pi/d30": "under-floor", "pi/h5": "under-floor", "pi/week": "under-floor" });
});

test("SQUAD_NO_KEY_CAPS=1 makes the pool ignore caps; only exactly 1", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "a", kind: "key" }, NOW);
  usedPass(s, "P1", "pi/a", 1, 5);
  setOwnerCaps(s.db, "pi/a", 1, null, null);
  assert.deepEqual(pick(candidates(s.db, "pi", NOW, never, { SQUAD_NO_KEY_CAPS: "1" }), NOW.getTime()).order, ["pi/a"]);
  assert.deepEqual(pick(candidates(s.db, "pi", NOW, never, { SQUAD_NO_KEY_CAPS: "true" }), NOW.getTime()).order, []);
});

test("setOwnerBalance stores the entered balance with its time; null clears both", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "k", kind: "key" }, NOW);
  assert.deepEqual([getAccount(s.db, "pi/k")!.balanceUsd, getAccount(s.db, "pi/k")!.balanceAt], [null, null]);
  setOwnerBalance(s.db, "pi/k", 20, NOW);
  assert.deepEqual([getAccount(s.db, "pi/k")!.balanceUsd, getAccount(s.db, "pi/k")!.balanceAt], [20, NOW.toISOString()]);
  setOwnerBalance(s.db, "pi/k", 0, NOW);
  assert.equal(getAccount(s.db, "pi/k")!.balanceUsd, 0);
  setOwnerBalance(s.db, "pi/k", null, NOW);
  assert.deepEqual([getAccount(s.db, "pi/k")!.balanceUsd, getAccount(s.db, "pi/k")!.balanceAt], [null, null]);
  assert.throws(() => setOwnerBalance(s.db, "pi/none", 1, NOW), /unknown account/);
});

test("the pool does not read the balance: a key whose estimate is below 0 is still picked", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "a", kind: "key" }, NOW);
  setOwnerBalance(s.db, "pi/a", 1, new Date(NOW.getTime() - 2 * 3_600_000));
  usedPass(s, "P1", "pi/a", 1, 5);
  assert.deepEqual(pick(candidates(s.db, "pi", NOW, never, {}), NOW.getTime()).order, ["pi/a"]);
});

test("dead goes back to active only through reviveByLogin", () => {
  const s = mk();
  addAccount(s.db, { runner: "codex", name: "c", kind: "login" }, NOW);
  setState(s.db, "codex/c", "dead", "token_revoked", NOW);
  const dead = getAccount(s.db, "codex/c")!;
  assert.equal(dead.state, "dead");
  assert.equal(dead.deadCode, "token_revoked");
  assert.equal(dead.deadAt, NOW.toISOString());
  assert.throws(() => setState(s.db, "codex/c", "active"), /reviveByLogin/);
  assert.equal(getAccount(s.db, "codex/c")!.state, "dead");
  putHealth(s.db, { ...emptyHealth("codex/c"), authFails: 2, suspectSince: NOW.toISOString() });
  reviveByLogin(s.db, "codex/c");
  const live = getAccount(s.db, "codex/c")!;
  assert.equal(live.state, "active");
  assert.equal(live.deadCode, null);
  assert.equal(live.deadAt, null);
  assert.equal(getHealth(s.db, "codex/c").authFails, 0);
  assert.equal(getHealth(s.db, "codex/c").suspectSince, null);
});

test("reviveByLogin refuses an account that is not dead; setState refuses an unknown one", () => {
  const s = mk();
  addAccount(s.db, { runner: "codex", name: "c", kind: "login" }, NOW);
  assert.throws(() => reviveByLogin(s.db, "codex/c"), /not dead/);
  assert.throws(() => setState(s.db, "codex/none", "disabled"), /unknown/);
});

test("setOwnerFloors sets both floors or clears each back to the default (null)", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "f", kind: "key" }, NOW);
  setOwnerFloors(s.db, "pi/f", 20, null);
  assert.deepEqual([getAccount(s.db, "pi/f")!.floor5h, getAccount(s.db, "pi/f")!.floorWeek], [20, null]);
  setOwnerFloors(s.db, "pi/f", null, null);
  assert.deepEqual([getAccount(s.db, "pi/f")!.floor5h, getAccount(s.db, "pi/f")!.floorWeek], [null, null]);
  assert.throws(() => setOwnerFloors(s.db, "pi/none", 1, 1), /unknown account/);
});

test("setConsent stamps the time once and keeps the first stamp", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "c", kind: "key", consent: false }, NOW);
  assert.equal(getAccount(s.db, "pi/c")!.consentAt, null);
  setConsent(s.db, "pi/c", NOW);
  setConsent(s.db, "pi/c", new Date(NOW.getTime() + 1000));
  assert.equal(getAccount(s.db, "pi/c")!.consentAt, NOW.toISOString());
  assert.throws(() => setConsent(s.db, "pi/none", NOW), /unknown account/);
});

// ---- account care ----

test("a new account is shared unless the caller says no; the web gives the owner's email, the host says cli", () => {
  const s = mk();
  const host = addAccount(s.db, { runner: "pi", name: "h", kind: "key" }, NOW);
  assert.deepEqual([host.consentAt, host.consentBy], [NOW.toISOString(), "cli"]);
  const web = addAccount(s.db, { runner: "pi", name: "w", kind: "key", ownerEmail: "o@x.test", consent: { by: "o@x.test" } }, NOW);
  assert.equal(web.consentBy, "o@x.test");
  const forOther = addAccount(s.db, { runner: "pi", name: "o", kind: "key", ownerEmail: "o@x.test", consent: false }, NOW);
  assert.deepEqual([forOther.consentAt, forOther.consentBy], [null, null]);
});

test("setSharing stops and starts sharing at that moment; the pool skips an account that is not shared", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "a", kind: "key" }, NOW);
  addAccount(s.db, { runner: "pi", name: "b", kind: "key" }, NOW);
  setSharing(s.db, "pi/a", null, NOW);
  assert.deepEqual([getAccount(s.db, "pi/a")!.consentAt, getAccount(s.db, "pi/a")!.consentBy], [null, null]);
  const c = candidates(s.db, "pi", NOW, never, {});
  assert.equal(c.find((x) => x.account === "pi/a")!.sharing, false);
  assert.equal(c.find((x) => x.account === "pi/b")!.sharing, true);
  const r = pick(c, NOW.getTime());
  assert.deepEqual(r.order, ["pi/b"]);
  assert.equal(r.skipped["pi/a"], "no-consent");
  const later = new Date(NOW.getTime() + 60_000);
  setSharing(s.db, "pi/a", "o@x.test", later);
  assert.deepEqual([getAccount(s.db, "pi/a")!.consentAt, getAccount(s.db, "pi/a")!.consentBy], [later.toISOString(), "o@x.test"]);
  assert.throws(() => setSharing(s.db, "pi/none", null, NOW), /unknown account/);
});

test("a removed account keeps its row but leaves every list, the pool and the health table; its name can be used again", () => {
  const s = mk();
  addAccount(s.db, { runner: "pi", name: "r", kind: "key", ownerEmail: "o@x.test" }, NOW);
  addAccount(s.db, { runner: "pi", name: "k", kind: "key" }, NOW);
  putHealth(s.db, { ...emptyHealth("pi/r"), coolUntil: "2026-10-24T13:00:00.000Z", coolKind: "rate-limit" });
  s.db.prepare("INSERT INTO sessions (id, runner, account, created_at, last_used_at) VALUES ('s1', 'pi', 'pi/r', ?, ?)").run(NOW.toISOString(), NOW.toISOString());
  markRemoved(s.db, "pi/r");
  const row = getAccount(s.db, "pi/r")!;
  assert.equal(row.state, "removed");
  assert.equal(row.consentAt, null);
  assert.equal(liveAccount(s.db, "pi/r"), undefined);
  assert.equal(liveAccount(s.db, "pi/k")!.id, "pi/k");
  assert.deepEqual(listAccounts(s.db).map((a) => a.id), ["pi/k"]);
  assert.deepEqual(listAccounts(s.db, undefined, { withRemoved: true }).map((a) => a.id), ["pi/k", "pi/r"]);
  assert.deepEqual(candidates(s.db, "pi", NOW, never, {}).map((c) => c.account), ["pi/k"]);
  assert.equal(getHealth(s.db, "pi/r").coolUntil, null, "no stale cooling for a name used again");
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM sessions WHERE account = 'pi/r'").get() as { n: number }).n, 0);
  assert.throws(() => setState(s.db, "pi/r", "active"), /removed/);
  const again = addAccount(s.db, { runner: "pi", name: "r", kind: "key", ownerEmail: "p@x.test" }, NOW);
  assert.equal(again.state, "active");
  assert.equal(again.ownerEmail, "p@x.test");
  // A live row is never replaced.
  assert.throws(() => addAccount(s.db, { runner: "pi", name: "k", kind: "key" }, NOW));
});

test("resetHealth clears cooling and suspect, revives a dead account with a passing code, and refuses a permanent code", () => {
  const s = mk();
  for (const n of ["cool", "sus", "dead2", "revoked"]) addAccount(s.db, { runner: "codex", name: n, kind: "login" }, NOW);
  putHealth(s.db, { ...emptyHealth("codex/cool"), coolUntil: "2026-10-24T13:00:00.000Z", coolKind: "quota", lastFailKind: "quota", lastFailCode: "usage_limit_reached", left5h: 0, readAt: NOW.toISOString() });
  putHealth(s.db, { ...emptyHealth("codex/sus"), suspectSince: NOW.toISOString(), authFails: 1, lastFailCode: "401" });
  setState(s.db, "codex/dead2", "dead", "401", NOW);
  setState(s.db, "codex/revoked", "dead", "token_revoked", NOW);
  assert.equal(resetHealth(s.db, "codex/cool"), "reset");
  const h = getHealth(s.db, "codex/cool");
  assert.deepEqual([h.coolUntil, h.coolKind, h.lastFailCode, h.lastFailKind], [null, null, null, null]);
  assert.equal(h.left5h, 0, "the room read stays: it is a fact, not a state");
  assert.equal(resetHealth(s.db, "codex/sus"), "reset");
  assert.deepEqual([getHealth(s.db, "codex/sus").suspectSince, getHealth(s.db, "codex/sus").authFails], [null, 0]);
  assert.equal(resetHealth(s.db, "codex/dead2"), "reset");
  assert.deepEqual([getAccount(s.db, "codex/dead2")!.state, getAccount(s.db, "codex/dead2")!.deadCode], ["active", null]);
  assert.equal(resetHealth(s.db, "codex/revoked"), "log-in-again");
  assert.equal(getAccount(s.db, "codex/revoked")!.state, "dead");
  assert.throws(() => resetHealth(s.db, "codex/none"), /unknown account/);
});

test("the README's list of codes that Reset health refuses is exactly PERMANENT_AUTH_CODES", async () => {
  const { readFileSync } = await import("node:fs");
  const { PERMANENT_AUTH_CODES } = await import("../classify.ts");
  const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
  const line = readme.slice(readme.indexOf("- **Reset health**"), readme.indexOf("- **Log in again**"));
  const listed = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, [...PERMANENT_AUTH_CODES].sort());
});
