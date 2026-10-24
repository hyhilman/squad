import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pick } from "../pool/pick.ts";
import { openStore, type Store } from "../store/db.ts";
import { emptyHealth } from "./health.ts";
import { addAccount, candidates, getAccount, getHealth, listAccounts, putHealth, reviveByLogin, setConsent, setOwnerFloors, setState } from "./store.ts";

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
  addAccount(s.db, { runner: "pi", name: "c", kind: "key" }, NOW);
  assert.equal(getAccount(s.db, "pi/c")!.consentAt, null);
  setConsent(s.db, "pi/c", NOW);
  setConsent(s.db, "pi/c", new Date(NOW.getTime() + 1000));
  assert.equal(getAccount(s.db, "pi/c")!.consentAt, NOW.toISOString());
  assert.throws(() => setConsent(s.db, "pi/none", NOW), /unknown account/);
});
