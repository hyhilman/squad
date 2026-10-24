import assert from "node:assert/strict";
import { test } from "node:test";
import { availableHint, floorHint, roomLabel, roomParts, roomState } from "./room.ts";

test("the colour follows the room left after the floor: >50 blue, >25 yellow, >5 orange, else red", () => {
  assert.equal(roomState(100, 10), "blue");
  assert.equal(roomState(61, 10), "blue");
  assert.equal(roomState(60, 10), "yellow", "50 after the floor is not over 50");
  assert.equal(roomState(36, 10), "yellow");
  assert.equal(roomState(35, 10), "orange");
  assert.equal(roomState(16, 10), "orange");
  assert.equal(roomState(15, 10), "red");
  assert.equal(roomState(10, 10), "red", "at the floor the pool skips it");
  assert.equal(roomState(3, 10), "red");
  assert.equal(roomState(80, 0), "blue");
});

test("roomLabel: the room left and the floor, or a plain word when unread", () => {
  assert.equal(roomLabel(88, 10), "88% · floor 10%");
  assert.equal(roomLabel(undefined, 10), "no read yet");
});

test("roomParts: the floor, and what is left above it to share", () => {
  assert.deepEqual(roomParts(100, 20), { floor: 20, available: 80, left: 100 });
  assert.deepEqual(roomParts(12, 20), { floor: 20, available: 0, left: 12 }, "under the floor nothing is shared");
  assert.deepEqual(roomParts(undefined, 10), { floor: 10, available: undefined, left: undefined });
});

test("room hover texts say what the floor is and what is available", () => {
  assert.match(floorHint(20), /^Floor: the minimum capacity of this seat that is never shared \(20%\)\.$/);
  assert.equal(availableHint(roomParts(100, 20)), "80% can still be shared: 100% of the window is left, minus the 20% floor.");
  assert.equal(availableHint(roomParts(12, 20)), "Nothing to share: 12% is left, under the 20% floor.");
  assert.equal(availableHint(roomParts(undefined, 20)), "No usage read yet.");
});
