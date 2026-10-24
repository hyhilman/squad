import { strict as assert } from "node:assert";
import { test } from "node:test";
import { signInPlan, signInUrl } from "./signin.ts";

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

test("signInPlan: a top-level page goes to the sign-in page itself", () => {
  const w = {} as object;
  assert.deepEqual(signInPlan({ top: w, self: w }, "/passes", "?pass=1"), { kind: "redirect", url: "/auth/login?to=%2Fpasses%3Fpass%3D1" });
});

test("signInPlan: in a frame the plain sign-in page opens in a popup", () => {
  assert.deepEqual(signInPlan({ top: {}, self: {} }, "/passes", ""), { kind: "popup", url: "/auth/login" });
});

test("signInPlan: a top that cannot be read counts as a frame", () => {
  assert.equal(signInPlan({ top: null, self: {} }, "/", "").kind, "popup");
});
