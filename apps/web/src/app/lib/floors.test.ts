import { test } from "node:test";
import assert from "node:assert/strict";
import { floorBody, parseFloor } from "./floors.ts";

test("empty means the default (null)", () => {
  assert.deepEqual(parseFloor(""), { ok: true, value: null });
  assert.deepEqual(parseFloor("  "), { ok: true, value: null });
});

test("a whole number from 0 to 100 is accepted", () => {
  assert.deepEqual(parseFloor("0"), { ok: true, value: 0 });
  assert.deepEqual(parseFloor("100"), { ok: true, value: 100 });
  assert.deepEqual(parseFloor(" 25 "), { ok: true, value: 25 });
});

test("bad input gives a plain error", () => {
  for (const bad of ["-1", "101", "abc", "1.5", "1e1", "5%"]) {
    const r = parseFloor(bad);
    assert.equal(r.ok, false, bad);
  }
});

test("floorBody builds the body or lists the errors", () => {
  assert.deepEqual(floorBody("10", ""), { ok: true, body: { floor5h: 10, floorWeek: null } });
  const r = floorBody("x", "200");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors.length, 2);
});
