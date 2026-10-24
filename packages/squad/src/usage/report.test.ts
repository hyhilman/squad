import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore, type Store, type Tokens } from "../store/db.ts";
import { usageBy } from "./report.ts";

const mk = (): Store => {
  const d = mkdtempSync(join(tmpdir(), "report-"));
  return openStore({ dbPath: join(d, "squad.db"), spoolDir: join(d, "spool") });
};

interface P { id: string; at: string; flow?: string; account?: string; model?: string; task?: [string, string]; outcome?: string; tokens?: Partial<Tokens>; cost?: number }

function add(s: Store, p: P): void {
  s.startPass({ id: p.id, startedAt: p.at, project: "proj", flow: p.flow ?? "fix", action: "a", runner: "pi", model: p.model ?? "m1", ...(p.account === undefined ? {} : { account: p.account }), ...(p.task === undefined ? {} : { taskKind: p.task[0], taskId: p.task[1] }) });
  s.endPass({ id: p.id, endedAt: p.at, outcome: p.outcome ?? "ok", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...p.tokens }, ...(p.cost === undefined ? {} : { costUsd: p.cost }) });
}

const SINCE = new Date("2026-10-20T00:00:00.000Z");

function fill(s: Store): void {
  add(s, { id: "1", at: "2026-10-21T10:00:00.000Z", account: "pi/a", task: ["issue", "7"], tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 }, cost: 0.5 });
  add(s, { id: "2", at: "2026-10-21T11:00:00.000Z", account: "pi/a", task: ["issue", "7"], outcome: "fail", tokens: { input: 1 }, cost: 0.25 });
  add(s, { id: "3", at: "2026-10-22T09:00:00.000Z", account: "pi/b", flow: "review", model: "m2", tokens: { output: 9 } });
  add(s, { id: "4", at: "2026-10-22T09:30:00.000Z", account: "pi/b", outcome: "busy" });
  add(s, { id: "5", at: "2026-10-01T09:00:00.000Z", account: "pi/a", tokens: { input: 999 } });
}

test("by account: counts, sums, and money; old passes and busy rows stay out", () => {
  const s = mk();
  fill(s);
  assert.deepEqual(usageBy(s.db, "account", SINCE), [
    { key: "pi/a", passes: 2, ok: 1, fail: 1, input: 11, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1, costUsd: 0.75 },
    { key: "pi/b", passes: 1, ok: 1, fail: 0, input: 0, output: 9, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null },
  ]);
});

test("by task, flow, day and model", () => {
  const s = mk();
  fill(s);
  assert.deepEqual(usageBy(s.db, "task", SINCE).map((r) => [r.key, r.passes]), [["-", 1], ["issue:7", 2]]);
  assert.deepEqual(usageBy(s.db, "flow", SINCE).map((r) => [r.key, r.passes]), [["fix", 2], ["review", 1]]);
  assert.deepEqual(usageBy(s.db, "day", SINCE).map((r) => [r.key, r.passes]), [["2026-10-21", 2], ["2026-10-22", 1]]);
  assert.deepEqual(usageBy(s.db, "model", SINCE).map((r) => [r.key, r.passes]), [["m1", 2], ["m2", 1]]);
});

test("an empty window gives no rows", () => {
  assert.deepEqual(usageBy(mk().db, "account", SINCE), []);
});

test("accounts limits the rows to passes of those accounts only", () => {
  const s = mk();
  fill(s);
  const mine = usageBy(s.db, "day", SINCE, ["pi/b"]);
  assert.deepEqual(mine.map((r) => [r.key, r.passes]), [["2026-10-22", 1]]);
  assert.deepEqual(usageBy(s.db, "task", SINCE, []), []);
  assert.equal(usageBy(s.db, "account", SINCE, ["pi/a", "pi/b"]).length, 2);
  assert.equal(usageBy(s.db, "account", SINCE).length, 2, "no filter = all");
});
