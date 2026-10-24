import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pick, type Candidate } from "./pick.ts";

const NOW = Date.parse("2026-10-24T10:00:00Z");
const fresh = new Date(NOW - 10_000).toISOString();
const stale = new Date(NOW - 120_000).toISOString();
const base = (account: string, more: Partial<Candidate> = {}): Candidate => ({ account, health: "ok", floor5h: 20, floorWeek: 20, busy: false, ...more });

test("dead, disabled, moved, suspect and busy accounts are left out with a reason", () => {
  const r = pick(
    [
      base("codex/a", { health: "dead" }),
      base("codex/b", { health: "disabled" }),
      base("codex/c", { health: "moved" }),
      base("codex/d", { health: "suspect" }),
      base("codex/e", { busy: true }),
      base("codex/f"),
    ],
    NOW,
  );
  assert.deepEqual(r.order, ["codex/f"]);
  assert.deepEqual(r.skipped, { "codex/a": "dead", "codex/b": "disabled", "codex/c": "moved", "codex/d": "suspect", "codex/e": "busy" });
});

test("a cool-down in the future skips; one that ran out does not", () => {
  const r = pick(
    [
      base("codex/a", { health: "cooling", coolUntil: new Date(NOW + 60_000).toISOString() }),
      base("codex/b", { health: "cooling", coolUntil: new Date(NOW - 1).toISOString() }),
      base("codex/c", { health: "cooling" }),
    ],
    NOW,
  );
  assert.deepEqual(r.order, ["codex/b"]);
  assert.equal(r.skipped["codex/a"], "cooling");
  assert.equal(r.skipped["codex/c"], "cooling");
});

test("at or under a floor on either window skips, from a fresh read only", () => {
  const r = pick(
    [
      base("codex/a", { left5h: 20, leftWeek: 90, readAt: fresh }),
      base("codex/b", { left5h: 90, leftWeek: 15, readAt: fresh }),
      base("codex/c", { left5h: 5, leftWeek: 5, readAt: stale }),
    ],
    NOW,
  );
  assert.deepEqual(r.order, ["codex/c"], "a stale read counts as no read, which is allowed");
  assert.equal(r.skipped["codex/a"], "under-floor");
  assert.equal(r.skipped["codex/b"], "under-floor");
});

test("most room on the tighter window first; ties go to the least recently used", () => {
  const r = pick(
    [
      base("codex/a", { left5h: 50, leftWeek: 90, readAt: fresh }),
      base("codex/b", { left5h: 90, leftWeek: 80, readAt: fresh, lastUsedAt: "2026-10-24T09:00:00Z" }),
      base("codex/c", { left5h: 90, leftWeek: 80, readAt: fresh, lastUsedAt: "2026-10-24T08:00:00Z" }),
      base("codex/d"),
    ],
    NOW,
  );
  assert.deepEqual(r.order, ["codex/d", "codex/c", "codex/b", "codex/a"]);
});

test("no account left gives an empty order, never a wait", () => {
  assert.deepEqual(pick([base("codex/a", { busy: true })], NOW).order, []);
});

test("a removed account and one its owner does not share are left out with a reason", () => {
  const r = pick([base("codex/a", { health: "removed" }), base("codex/b", { sharing: false }), base("codex/c", { sharing: true })], NOW);
  assert.deepEqual(r.order, ["codex/c"]);
  assert.deepEqual(r.skipped, { "codex/a": "removed", "codex/b": "no-consent" });
});

test("a probe may pick a suspect or cooling account; dead, disabled, moved, removed, unshared and busy still refuse", () => {
  const list = [
    base("codex/a", { health: "suspect" }),
    base("codex/b", { health: "cooling", coolUntil: new Date(NOW + 60_000).toISOString() }),
    base("codex/c", { health: "cooling" }),
    base("codex/d", { health: "dead" }),
    base("codex/e", { health: "disabled" }),
    base("codex/f", { health: "moved" }),
    base("codex/g", { health: "removed" }),
    base("codex/h", { sharing: false }),
    base("codex/i", { busy: true }),
  ];
  const r = pick(list, NOW, undefined, { probe: true });
  assert.deepEqual(r.order, ["codex/a", "codex/b", "codex/c"]);
  assert.deepEqual(r.skipped, { "codex/d": "dead", "codex/e": "disabled", "codex/f": "moved", "codex/g": "removed", "codex/h": "no-consent", "codex/i": "busy" });
  assert.deepEqual(pick(list, NOW).order, [], "not a probe: today's rule");
});
