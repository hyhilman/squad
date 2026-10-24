import assert from "node:assert/strict";
import { test } from "node:test";
import { healthColor, outcomeBadge } from "./badges.ts";

test("healthColor: every health has a color", () => {
  assert.equal(healthColor("ok"), "success");
  assert.equal(healthColor("dead"), "error");
  assert.equal(healthColor("suspect"), "warning");
  assert.equal(healthColor("cooling"), "processing");
  assert.equal(healthColor("disabled"), "default");
  assert.equal(healthColor("moved"), "default");
});

test("outcomeBadge: ok, running, lost and failures", () => {
  assert.deepEqual(outcomeBadge(undefined), { text: "running", color: "processing" });
  assert.deepEqual(outcomeBadge("ok"), { text: "ok", color: "success" });
  assert.deepEqual(outcomeBadge("lost"), { text: "lost", color: "warning" });
  assert.deepEqual(outcomeBadge("auth"), { text: "auth", color: "error" });
});
