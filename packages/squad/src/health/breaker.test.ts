import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Candidate, Health } from "../pool/pick.ts";
import { scopeState } from "./breaker.ts";

const c = (health: Health, busy = false): Candidate => ({ account: "codex/x", health, floor5h: 10, floorWeek: 10, busy });

test("open when every account is cooling, dead, disabled or moved", () => {
  assert.equal(scopeState([c("cooling"), c("dead"), c("disabled"), c("moved")]), "open");
});

test("closed when one account is ok, busy or suspect (a busy account will free; a suspect one waits for a probe)", () => {
  assert.equal(scopeState([c("dead"), c("ok")]), "closed");
  assert.equal(scopeState([c("cooling"), c("ok", true)]), "closed");
  assert.equal(scopeState([c("dead"), c("suspect")]), "closed");
});

test("an empty pool is closed, so runPass keeps its own no-account message", () => {
  assert.equal(scopeState([]), "closed");
});
