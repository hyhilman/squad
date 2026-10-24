import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { layoutOf } from "./home.ts";
import { migrate } from "./store/db.ts";
import { checkSessionId, deleteSession, getSession, listSessions, pinSession, sessionDir, touchSession } from "./sessions.ts";

const db = (): DatabaseSync => {
  const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "sess-")), "x.db"));
  migrate(d);
  return d;
};

test("a session id is a short lower-case name; anything else throws", () => {
  for (const ok of ["a", "s1", "fix-12.a_b", "0abc", "a".repeat(64)]) assert.equal(checkSessionId(ok), ok);
  for (const bad of ["", "A", "-a", ".a", "_a", "a/b", "..", "a b", "a".repeat(65), "é"]) assert.throws(() => checkSessionId(bad), /session id/, bad);
});

test("the session folder is sessions/<runner>/<account name>/<id>", () => {
  const home = layoutOf("/h/.squad", {});
  assert.equal(sessionDir(home, "pi", "pi/alice", "s1"), "/h/.squad/sessions/pi/alice/s1");
});

test("pin, touch, list and delete a session row", () => {
  const d = db();
  const t0 = new Date("2026-10-24T00:00:00.000Z");
  const t1 = new Date("2026-10-25T00:00:00.000Z");
  assert.equal(getSession(d, "pi", "s1"), undefined);
  pinSession(d, "pi", "s1", "pi/k1", t0);
  assert.deepEqual(getSession(d, "pi", "s1"), { id: "s1", runner: "pi", account: "pi/k1", createdAt: t0.toISOString(), lastUsedAt: t0.toISOString() });
  touchSession(d, "pi", "s1", t1);
  assert.equal(getSession(d, "pi", "s1")!.lastUsedAt, t1.toISOString());
  assert.equal(getSession(d, "pi", "s1")!.createdAt, t0.toISOString());
  assert.equal(getSession(d, "claude", "s1"), undefined, "the key is (runner, id)");
  assert.equal(listSessions(d).length, 1);
  deleteSession(d, "pi", "s1");
  assert.deepEqual(listSessions(d), []);
});
