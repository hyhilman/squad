import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SETTINGS, SQUAD_NO_GC_ENV, SQUAD_STOP_GRACE_S_ENV, envNum, envOn, envOptional } from "./settings.ts";

test("every row has a key in SQUAD_ shape and a one-line why", () => {
  const keys = new Set<string>();
  for (const s of SETTINGS) {
    assert.match(s.key, /^SQUAD_[A-Z0-9_]+$/);
    assert.ok(!keys.has(s.key), `duplicate ${s.key}`);
    keys.add(s.key);
    assert.ok(s.why.length > 0 && !s.why.includes("\n"), `${s.key} why must be one line`);
  }
});

test("kill switches are SQUAD_NO_<FEATURE> and default off", () => {
  for (const s of SETTINGS.filter((r) => r.key.startsWith("SQUAD_NO_"))) {
    assert.equal(s.default, "0", s.key);
    assert.equal(envOn(s, {}), false);
  }
  assert.equal(envOn(SQUAD_NO_GC_ENV, { SQUAD_NO_GC: "1" }), true);
  assert.equal(envOn(SQUAD_NO_GC_ENV, { SQUAD_NO_GC: "true" }), false, "only exactly 1 turns a switch on");
});

test("an empty value is unset; a bad number is refused with its raw value", () => {
  assert.equal(envOptional(SQUAD_STOP_GRACE_S_ENV, { SQUAD_STOP_GRACE_S: "" }), "20");
  assert.equal(envNum(SQUAD_STOP_GRACE_S_ENV, { SQUAD_STOP_GRACE_S: "5" }), 5);
  assert.throws(() => envNum(SQUAD_STOP_GRACE_S_ENV, { SQUAD_STOP_GRACE_S: "5s" }), /got "5s"/);
});
