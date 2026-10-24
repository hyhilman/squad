import assert from "node:assert/strict";
import { test } from "node:test";
import { roomLabel, roomState } from "./room.ts";

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
