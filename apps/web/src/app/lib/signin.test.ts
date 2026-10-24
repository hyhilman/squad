import { strict as assert } from "node:assert";
import { test } from "node:test";
import { signInUrl } from "./signin.ts";

test("signInUrl sends the current path, encoded, to the full-page sign-in route", () => {
  assert.equal(signInUrl("/accounts/pi/dev", "?x=1"), "/auth/login?to=%2Faccounts%2Fpi%2Fdev%3Fx%3D1");
  assert.equal(signInUrl("/usage", ""), "/auth/login?to=%2Fusage");
});

test("signInUrl never sends a sign-in path or an odd path back as the target", () => {
  assert.equal(signInUrl("/auth/login", ""), "/auth/login");
  assert.equal(signInUrl("/", ""), "/auth/login");
  assert.equal(signInUrl("//evil.com", ""), "/auth/login");
  assert.equal(signInUrl("accounts", ""), "/auth/login");
});
