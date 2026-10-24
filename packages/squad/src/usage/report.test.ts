import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore, type Store, type Tokens } from "../store/db.ts";
import { listPassesPage, usageBy, usageSeries } from "./report.ts";

const mk = (): Store => {
  const d = mkdtempSync(join(tmpdir(), "report-"));
  return openStore({ dbPath: join(d, "squad.db"), spoolDir: join(d, "spool") });
};

interface P { id: string; at: string; flow?: string; account?: string; model?: string; task?: [string, string]; outcome?: string; tokens?: Partial<Tokens>; cost?: number; cli?: number; catalog?: number }

function add(s: Store, p: P): void {
  s.startPass({ id: p.id, startedAt: p.at, project: "proj", flow: p.flow ?? "fix", action: "a", runner: "pi", model: p.model ?? "m1", ...(p.account === undefined ? {} : { account: p.account }), ...(p.task === undefined ? {} : { taskKind: p.task[0], taskId: p.task[1] }) });
  s.endPass({ id: p.id, endedAt: p.at, outcome: p.outcome ?? "ok", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...p.tokens }, ...(p.cost === undefined ? {} : { costUsd: p.cost }), ...(p.cli === undefined ? {} : { cliCostUsd: p.cli }), ...(p.catalog === undefined ? {} : { catalogCostUsd: p.catalog }) });
}

const SINCE = new Date("2026-10-20T00:00:00.000Z");

function fill(s: Store): void {
  add(s, { id: "1", at: "2026-10-21T10:00:00.000Z", account: "pi/a", task: ["issue", "7"], tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 }, cost: 0.5, cli: 0.4, catalog: 0.5 });
  add(s, { id: "2", at: "2026-10-21T11:00:00.000Z", account: "pi/a", task: ["issue", "7"], outcome: "fail", tokens: { input: 1 }, cost: 0.25, cli: 0.1, catalog: 0.25 });
  add(s, { id: "3", at: "2026-10-22T09:00:00.000Z", account: "pi/b", flow: "review", model: "m2", tokens: { output: 9 } });
  add(s, { id: "4", at: "2026-10-22T09:30:00.000Z", account: "pi/b", outcome: "busy" });
  add(s, { id: "5", at: "2026-10-01T09:00:00.000Z", account: "pi/a", tokens: { input: 999 } });
}

test("by account: counts, sums, and money; old passes and busy rows stay out", () => {
  const s = mk();
  fill(s);
  assert.deepEqual(usageBy(s.db, "account", SINCE), [
    { key: "pi/a", passes: 2, ok: 1, fail: 1, input: 11, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1, costUsd: 0.75, cliCostUsd: 0.5, catalogCostUsd: 0.75 },
    { key: "pi/b", passes: 1, ok: 1, fail: 0, input: 0, output: 9, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, cliCostUsd: null, catalogCostUsd: null },
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

test("usageSeries: day and hour buckets with per-account sums; busy rows, old rows and other accounts stay out", () => {
  const s = mk();
  fill(s);
  add(s, { id: "6", at: "2026-10-21T10:30:00.000Z", account: "pi/b", tokens: { input: 4 }, cost: 1 });
  add(s, { id: "7", at: "2026-10-22T09:15:00.000Z" }); // no account
  assert.deepEqual(usageSeries(s.db, "day", SINCE), [
    { bucket: "2026-10-21", account: "pi/a", passes: 2, input: 11, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1, costUsd: 0.75, cliCostUsd: 0.5, catalogCostUsd: 0.75 },
    { bucket: "2026-10-21", account: "pi/b", passes: 1, input: 4, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 1, cliCostUsd: null, catalogCostUsd: null },
    { bucket: "2026-10-22", account: "-", passes: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, cliCostUsd: null, catalogCostUsd: null },
    { bucket: "2026-10-22", account: "pi/b", passes: 1, input: 0, output: 9, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, cliCostUsd: null, catalogCostUsd: null },
  ]);
  const hours = usageSeries(s.db, "hour", SINCE, ["pi/a"]);
  assert.deepEqual(hours.map((r) => [r.bucket, r.account, r.input]), [["2026-10-21T10:00:00Z", "pi/a", 10], ["2026-10-21T11:00:00Z", "pi/a", 1]]);
  assert.deepEqual(usageSeries(s.db, "day", SINCE, []), []);
});

test("listPassesPage: newest first by id, filters, a before cursor, and the limit", () => {
  const s = mk();
  fill(s);
  const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);
  assert.deepEqual(ids(listPassesPage(s.db, { limit: 50 })), ["5", "3", "2", "1"], "the busy row 4 is left out");
  assert.deepEqual(ids(listPassesPage(s.db, { limit: 2 })), ["5", "3"]);
  assert.deepEqual(ids(listPassesPage(s.db, { limit: 2, before: "3" })), ["2", "1"]);
  assert.deepEqual(ids(listPassesPage(s.db, { limit: 50, since: SINCE })), ["3", "2", "1"]);
  assert.deepEqual(ids(listPassesPage(s.db, { limit: 50, accounts: ["pi/b"] })), ["3"]);
  assert.deepEqual(ids(listPassesPage(s.db, { limit: 50, accounts: [] })), []);
  const one = listPassesPage(s.db, { limit: 1, accounts: ["pi/a"], since: SINCE })[0]!;
  assert.deepEqual({ ...one }, {
    id: "2", account: "pi/a", startedAt: "2026-10-21T11:00:00.000Z", endedAt: "2026-10-21T11:00:00.000Z", flow: "fix", action: "a", taskKind: "issue", taskId: "7", runner: "pi", model: "m1",
    outcome: "fail", failKind: null, failCode: null, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.25, cliCostUsd: 0.1, catalogCostUsd: 0.25,
  });
});
