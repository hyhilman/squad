import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parsePiStream } from "../streams/pi.ts";
import { openStore, type Store } from "../store/db.ts";
import { keyUsed, keyUsedSince, usedCostOf } from "./key-used.ts";

const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/captures/pi/${name}`, import.meta.url), "utf8");

test("a pi pass counts what pi said it cost when the catalog has no price", () => {
  // The real capture: opencode-go/hy4-preview, which the catalog excerpt does not list.
  const o = parsePiStream(fixture("ok.jsonl"));
  assert.equal(o.cliCostUsd, 0.001425421);
  assert.equal(usedCostOf(o.cliCostUsd ?? null, null), 0.001425421);
});

test("the CLI cost wins over the catalog cost; a CLI cost of 0 falls back to the catalog", () => {
  assert.equal(usedCostOf(0.5, 0.3), 0.5);
  assert.equal(usedCostOf(null, 0.3), 0.3);
  assert.equal(usedCostOf(0, 0.3), 0.3);
  assert.equal(usedCostOf(0, null), 0);
  assert.equal(usedCostOf(null, null), 0);
});

test("a failed pi pass with no tokens counts 0", () => {
  const o = parsePiStream(fixture("auth-error.jsonl"));
  assert.equal(usedCostOf(o.cliCostUsd ?? null, null), 0);
});

// ---- the sums per window ----

const NOW = new Date("2026-10-24T12:00:00.000Z");
const ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const TOK = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), "key-used-"));
  return openStore({ dbPath: join(dir, "squad.db"), spoolDir: join(dir, "spool") });
}

let n = 0;
function pass(s: Store, account: string, hoursAgo: number, cost: { cli?: number; catalog?: number }, ended = true): void {
  const id = `P${++n}`;
  s.startPass({ id, startedAt: ago(hoursAgo), project: "x", flow: "f", action: "a", runner: "pi", model: "m", account });
  if (ended) s.endPass({ id, endedAt: ago(hoursAgo), outcome: "ok", tokens: TOK, ...(cost.cli === undefined ? {} : { cliCostUsd: cost.cli }), ...(cost.catalog === undefined ? {} : { catalogCostUsd: cost.catalog }) });
}

test("keyUsed sums the last 5 hours, 7 days and 30 days of one account", () => {
  const s = store();
  pass(s, "pi/dev", 1, { cli: 0.25 });
  pass(s, "pi/dev", 4.9, { catalog: 0.5 });
  pass(s, "pi/dev", 6, { cli: 1, catalog: 9 });
  pass(s, "pi/dev", 24 * 6.9, { cli: 2 });
  pass(s, "pi/dev", 24 * 8, { cli: 4 });
  pass(s, "pi/dev", 24 * 29.9, { cli: 8 });
  pass(s, "pi/dev", 24 * 31, { cli: 100 });
  assert.deepEqual(keyUsed(s.db, "pi/dev", NOW), { used5h: 0.75, usedWeek: 3.75, used30d: 15.75 });
  s.close();
});

test("keyUsed counts no other account; a pass with no cost or still running counts 0", () => {
  const s = store();
  pass(s, "pi/dev", 1, { cli: 0.5 });
  pass(s, "pi/spare", 1, { cli: 7 });
  pass(s, "pi/dev", 1, {});
  pass(s, "pi/dev", 0.5, {}, false);
  assert.deepEqual(keyUsed(s.db, "pi/dev", NOW), { used5h: 0.5, usedWeek: 0.5, used30d: 0.5 });
  assert.deepEqual(keyUsed(s.db, "pi/none", NOW), { used5h: 0, usedWeek: 0, used30d: 0 });
  s.close();
});

test("keyUsedSince sums one account's passes that started at or after the time; a running pass counts 0", () => {
  const s = store();
  pass(s, "pi/dev", 50, { cli: 100 });
  pass(s, "pi/dev", 48, { cli: 0.25 });
  pass(s, "pi/dev", 10, { catalog: 0.5 });
  pass(s, "pi/dev", 1, { cli: 2, catalog: 9 });
  pass(s, "pi/dev", 0.5, {}, false);
  pass(s, "pi/spare", 1, { cli: 7 });
  assert.equal(keyUsedSince(s.db, "pi/dev", ago(48)), 2.75);
  assert.equal(keyUsedSince(s.db, "pi/dev", ago(0)), 0);
  assert.equal(keyUsedSince(s.db, "pi/none", ago(48)), 0);
  s.close();
});
