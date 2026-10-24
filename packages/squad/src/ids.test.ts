import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ULID_RE, ulid } from "./ids.ts";

test("a ulid has the shape and sorts by time", () => {
  const a = ulid(1_000);
  const b = ulid(2_000);
  assert.match(a, ULID_RE);
  assert.ok(a < b);
});

test("the time part is fixed for a known time", () => {
  assert.equal(ulid(0, Buffer.alloc(10)), "00000000000000000000000000");
  assert.equal(ulid(2 ** 48 - 1, Buffer.alloc(10)).slice(0, 10), "7ZZZZZZZZZ");
});
