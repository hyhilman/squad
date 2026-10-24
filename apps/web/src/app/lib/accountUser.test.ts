import { strict as assert } from "node:assert";
import { test } from "node:test";
import { UNKNOWN_USER_HINT, accountUser } from "./accountUser.ts";

test("known: the provider account, then the squad owner", () => {
  const u = accountUser({ runner: "codex", kind: "login", loginEmail: "seat.person@personal-mail.test", ownerEmail: "seat.person@work-mail.test" });
  assert.deepEqual(u, { user: "seat.person@personal-mail.test", owner: "seat.person@work-mail.test", text: "seat.person@personal-mail.test / seat.person@work-mail.test", fillable: true });
});

test("unknown: 'unknown / owner' with the hover note", () => {
  const u = accountUser({ runner: "claude", kind: "token", ownerEmail: "bob@example.test" });
  assert.equal(u.text, "unknown / bob@example.test");
  assert.equal(u.user, undefined);
  assert.equal(u.hint, UNKNOWN_USER_HINT);
  assert.equal(UNKNOWN_USER_HINT, "squad could not read which provider account this is");
});

test("fillable: a new sign-in can tell the account user for a codex login or a claude token; a pi key never can", () => {
  assert.equal(accountUser({ runner: "codex", kind: "login", ownerEmail: "a@x" }).fillable, true);
  assert.equal(accountUser({ runner: "claude", kind: "token", ownerEmail: "a@x" }).fillable, true);
  assert.equal(accountUser({ runner: "pi", kind: "key", ownerEmail: "a@x" }).fillable, false);
  assert.equal(accountUser({ runner: "claude", kind: "login", ownerEmail: "a@x" }).fillable, false);
});

test("no owner shows a dash", () => {
  assert.equal(accountUser({ runner: "pi", kind: "key", ownerEmail: "" }).text, "unknown / -");
});
