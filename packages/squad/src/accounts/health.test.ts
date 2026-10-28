import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SQUAD_COOL_QUOTA_S_ENV, SQUAD_COOL_RATE_LIMIT_S_ENV, envNum } from "../settings.ts";
import { applyOutcome, emptyHealth, type HealthRow } from "./health.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const base = (more: Partial<HealthRow> = {}): HealthRow => ({ ...emptyHealth("pi/a"), ...more });
const fail = (kind: "quota" | "rate-limit" | "auth" | "provider" | "idle" | "timeout" | "no-account" | "busy", code = "") => ({ kind, code, message: "m" });

test("the cool times are settings with defaults 300 and 3600", () => {
  assert.equal(envNum(SQUAD_COOL_RATE_LIMIT_S_ENV, {}), 300);
  assert.equal(envNum(SQUAD_COOL_QUOTA_S_ENV, {}), 3600);
});

test("success clears the fails, the cool-down and the suspicion, and copies the room", () => {
  const prev = base({ authFails: 1, suspectSince: "2026-10-24T11:00:00.000Z", coolUntil: "2026-10-24T13:00:00.000Z", coolKind: "rate-limit" });
  const r = applyOutcome(prev, { room: { left5h: 80, leftWeek: 60 } }, NOW);
  assert.equal(r.health.authFails, 0);
  assert.equal(r.health.lastOkAt, NOW.toISOString());
  assert.equal(r.health.coolUntil, null);
  assert.equal(r.health.coolKind, null);
  assert.equal(r.health.suspectSince, null);
  assert.equal(r.health.left5h, 80);
  assert.equal(r.health.leftWeek, 60);
  assert.equal(r.health.readAt, NOW.toISOString());
  assert.equal(r.accountState, undefined);
  assert.equal(r.event, undefined);
});

test("success without a room keeps the old room", () => {
  const r = applyOutcome(base({ left5h: 40, leftWeek: 30, readAt: "2026-10-24T11:59:00.000Z" }), {}, NOW);
  assert.equal(r.health.left5h, 40);
  assert.equal(r.health.readAt, "2026-10-24T11:59:00.000Z");
});

test("rate-limit cools for 5 minutes", () => {
  const r = applyOutcome(base(), { failure: fail("rate-limit", "429") }, NOW);
  assert.equal(r.health.coolUntil, iso(NOW.getTime() + 300_000));
  assert.equal(r.health.coolKind, "rate-limit");
  assert.equal(r.health.lastFailKind, "rate-limit");
  assert.equal(r.health.lastFailCode, "429");
  assert.equal(r.health.lastFailAt, NOW.toISOString());
  assert.equal(r.accountState, undefined);
});

test("rate-limit with an empty window cools until that window resets", () => {
  const week = "2026-10-24T18:00:00.000Z";
  const r = applyOutcome(base(), { failure: fail("rate-limit", "429"), room: { left5h: 100, leftWeek: 0, resets5h: "2026-10-24T16:50:00.000Z", resetsWeek: week } }, NOW);
  assert.equal(r.health.coolUntil, week);
  assert.equal(r.health.coolKind, "quota");
  assert.equal(r.health.lastFailKind, "rate-limit");
});

test("rate-limit with both windows empty cools until the later reset", () => {
  const r = applyOutcome(base(), { failure: fail("rate-limit", "429"), room: { left5h: 0, leftWeek: 0, resets5h: "2026-10-24T13:00:00.000Z", resetsWeek: "2026-10-24T18:00:00.000Z" } }, NOW);
  assert.equal(r.health.coolUntil, "2026-10-24T18:00:00.000Z");
});

test("rate-limit ignores a stored empty window when the pass brought no room", () => {
  const r = applyOutcome(base({ left5h: 0, leftWeek: 40, resets5h: "2026-10-24T14:00:00.000Z", resetsWeek: "2026-10-30T00:00:00.000Z" }), { failure: fail("rate-limit", "429") }, NOW);
  assert.equal(r.health.coolUntil, iso(NOW.getTime() + 300_000));
  assert.equal(r.health.coolKind, "rate-limit");
});

test("rate-limit with room left, or an empty window whose reset passed, cools for 5 minutes", () => {
  const roomy = applyOutcome(base(), { failure: fail("rate-limit", "429"), room: { left5h: 30, leftWeek: 50, resets5h: "2026-10-24T14:00:00.000Z", resetsWeek: "2026-10-30T00:00:00.000Z" } }, NOW);
  assert.equal(roomy.health.coolUntil, iso(NOW.getTime() + 300_000));
  assert.equal(roomy.health.coolKind, "rate-limit");
  const passed = applyOutcome(base(), { failure: fail("rate-limit", "429"), room: { left5h: 0, resets5h: "2026-10-24T11:00:00.000Z" } }, NOW);
  assert.equal(passed.health.coolUntil, iso(NOW.getTime() + 300_000));
});

test("quota cools until the reset of the empty window", () => {
  const reset = "2026-10-24T15:00:00.000Z";
  const r = applyOutcome(base(), { failure: fail("quota", "402"), room: { left5h: 0, leftWeek: 50, resets5h: reset, resetsWeek: "2026-10-30T00:00:00.000Z" } }, NOW);
  assert.equal(r.health.coolUntil, reset);
  assert.equal(r.health.coolKind, "quota");
});

test("quota with no known reset cools for one hour", () => {
  const r = applyOutcome(base(), { failure: fail("quota", "402") }, NOW);
  assert.equal(r.health.coolUntil, iso(NOW.getTime() + 3_600_000));
});

test("quota with a reset in the past falls back to one hour", () => {
  const r = applyOutcome(base(), { failure: fail("quota"), room: { left5h: 0, resets5h: "2026-10-24T11:00:00.000Z" } }, NOW);
  assert.equal(r.health.coolUntil, iso(NOW.getTime() + 3_600_000));
});

test("a permanent auth code kills the account at once", () => {
  const r = applyOutcome(base(), { failure: fail("auth", "token_revoked") }, NOW);
  assert.equal(r.accountState, "dead");
  assert.deepEqual(r.event, { kind: "dead", code: "token_revoked" });
});

test("the first other auth fail makes the account suspect", () => {
  const r = applyOutcome(base(), { failure: fail("auth", "401:AuthError") }, NOW);
  assert.equal(r.health.authFails, 1);
  assert.equal(r.health.suspectSince, NOW.toISOString());
  assert.equal(r.accountState, undefined);
  assert.deepEqual(r.event, { kind: "auth-fail", code: "401:AuthError" });
});

test("the second auth fail kills the account and keeps the first suspect time", () => {
  const first = applyOutcome(base(), { failure: fail("auth", "401") }, NOW);
  const later = new Date(NOW.getTime() + 60_000);
  const r = applyOutcome(first.health, { failure: fail("auth", "401") }, later);
  assert.equal(r.health.authFails, 2);
  assert.equal(r.health.suspectSince, NOW.toISOString());
  assert.equal(r.accountState, "dead");
  assert.equal(r.event?.kind, "dead");
});

test("provider, idle and timeout record the fail and change nothing else", () => {
  for (const kind of ["provider", "idle", "timeout"] as const) {
    const r = applyOutcome(base(), { failure: fail(kind, "x") }, NOW);
    assert.equal(r.health.lastFailKind, kind);
    assert.equal(r.health.lastFailCode, "x");
    assert.equal(r.health.lastFailAt, NOW.toISOString());
    assert.equal(r.health.coolUntil, null);
    assert.equal(r.health.authFails, 0);
    assert.equal(r.accountState, undefined);
    assert.equal(r.event, undefined);
  }
});

test("busy and no-account never feed health", () => {
  const prev = base({ authFails: 1, lastOkAt: "2026-10-24T10:00:00.000Z" });
  for (const kind of ["busy", "no-account"] as const) {
    const r = applyOutcome(prev, { failure: fail(kind) }, NOW);
    assert.deepEqual(r, { health: prev });
  }
});

test("a pass that reads room also keeps the reset times; a later read without them keeps the old ones", () => {
  const room = { left5h: 40, leftWeek: 70, resets5h: "2026-10-24T15:00:00.000Z", resetsWeek: "2026-10-30T00:00:00.000Z" };
  const a = applyOutcome(emptyHealth("pi/a"), { room }, new Date("2026-10-24T12:00:00.000Z")).health;
  assert.deepEqual([a.resets5h, a.resetsWeek], [room.resets5h, room.resetsWeek]);
  const b = applyOutcome(a, { room: { left5h: 30 } }, new Date("2026-10-24T12:05:00.000Z")).health;
  assert.deepEqual([b.left5h, b.resets5h], [30, room.resets5h]);
});
