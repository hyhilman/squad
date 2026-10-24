import assert from "node:assert/strict";
import { test } from "node:test";
import { roomState } from "./room.ts";

test("room is held at or under the floor, near within 10 points above it, ok above that", () => {
  assert.equal(roomState(88, 30), "ok");
  assert.equal(roomState(40, 30), "near");
  assert.equal(roomState(31, 30), "near");
  assert.equal(roomState(30, 30), "held", "the pool skips an account at its floor");
  assert.equal(roomState(5, 30), "held");
  assert.equal(roomState(0, 0), "held", "nothing left is held even with no floor");
  assert.equal(roomState(8, 0), "near");
});
