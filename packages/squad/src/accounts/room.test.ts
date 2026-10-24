import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "../home.ts";
import { openStore } from "../store/db.ts";
import { SQUAD_KEY_PARALLEL_ENV, envNum } from "../settings.ts";
import { emptyHealth } from "./health.ts";
import { roomOf } from "./room.ts";
import { addAccount, putHealth, setState } from "./store.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const fresh = new Date(NOW.getTime() - 5000).toISOString();

function rig() {
  const root = mkdtempSync(join(tmpdir(), "room-"));
  const home = layoutOf(join(root, "home"), {});
  ensureHome(home);
  return openStore({ dbPath: home.db, spoolDir: home.spool });
}

test("SQUAD_KEY_PARALLEL is a setting, 4 by default", () => {
  assert.equal(envNum(SQUAD_KEY_PARALLEL_ENV, {}), 4);
});

test("roomOf: a login is 1, a key is 4; busy, cooling, dead and under-floor accounts add to total only when active, and free only when they can start", () => {
  const s = rig();
  for (const n of ["ok", "busy", "cool", "dead", "low"]) addAccount(s.db, { runner: "codex", name: n, kind: "login" }, NOW);
  addAccount(s.db, { runner: "codex", name: "key", kind: "key" }, NOW);
  addAccount(s.db, { runner: "pi", name: "other", kind: "key" }, NOW);
  putHealth(s.db, { ...emptyHealth("codex/cool"), coolUntil: new Date(NOW.getTime() + 60_000).toISOString(), coolKind: "rate-limit" });
  putHealth(s.db, { ...emptyHealth("codex/low"), left5h: 5, leftWeek: 80, readAt: fresh });
  setState(s.db, "codex/dead", "dead", "x", NOW);
  const r = roomOf(s.db, "codex", NOW, (id) => id === "codex/busy", {});
  assert.deepEqual({ free: r.free, total: r.total }, { free: 5, total: 8 });
  const by = Object.fromEntries(r.accounts.map((a) => [a.account, [a.free, a.total]]));
  assert.deepEqual(by, { "codex/ok": [1, 1], "codex/busy": [0, 1], "codex/cool": [0, 1], "codex/low": [0, 1], "codex/key": [4, 4] });
  assert.equal(roomOf(s.db, "codex", NOW, () => false, { SQUAD_KEY_PARALLEL: "2" }).accounts.find((a) => a.account === "codex/key")!.free, 2);
  assert.deepEqual({ free: roomOf(s.db, "pi", NOW, () => false, {}).free }, { free: 4 });
  s.close();
});

test("roomOf on a runner with no account is 0/0", () => {
  const s = rig();
  assert.deepEqual(roomOf(s.db, "claude", NOW, () => false, {}), { free: 0, total: 0, accounts: [] });
  s.close();
});
