import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ULID_RE, ulid, uuidOfUlid } from "./ids.ts";

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

test("uuidOfUlid: the same 128 bits as a UUID, one to one, any case", () => {
  assert.equal(uuidOfUlid("00000000000000000000000000"), "00000000-0000-0000-0000-000000000000");
  assert.equal(uuidOfUlid("7ZZZZZZZZZZZZZZZZZZZZZZZZZ"), "ffffffff-ffff-ffff-ffff-ffffffffffff");
  // The time part is the first 48 bits: 1 ms is the last bit of the 12th hex digit.
  assert.equal(uuidOfUlid(ulid(1, Buffer.alloc(10))), "00000000-0001-0000-0000-000000000000");
  const a = ulid(5, Buffer.from("00112233445566778899", "hex"));
  assert.equal(uuidOfUlid(a), "00000000-0005-0011-2233-445566778899");
  assert.equal(uuidOfUlid(a.toLowerCase()), uuidOfUlid(a));
  assert.notEqual(uuidOfUlid(ulid(5, Buffer.alloc(10, 1))), uuidOfUlid(ulid(5, Buffer.alloc(10, 2))));
  for (const bad of ["", "8ZZZZZZZZZZZZZZZZZZZZZZZZZ", "0000000000000000000000000U", "000"]) assert.throws(() => uuidOfUlid(bad), /not a ulid/);
});
