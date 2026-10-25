import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePiStream } from "../streams/pi.ts";
import { usedCostOf } from "./key-used.ts";

const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/captures/pi/${name}`, import.meta.url), "utf8");

test("a pi pass counts what pi said it cost when the catalog has no price", () => {
  // The real capture: opencode-go/hy4-preview, which the catalog excerpt does not list.
  const o = parsePiStream(fixture("ok.jsonl"));
  assert.equal(o.cliCostUsd, 0.001425421);
  assert.equal(usedCostOf(o.cliCostUsd ?? null, null), 0.001425421);
});

test("the CLI cost wins over the catalog cost; a CLI cost of 0 falls back to the catalog", () => {
  assert.equal(usedCostOf(0.5, 0.3), 0.5);
  assert.equal(usedCostOf(null, 0.3), 0.3);
  assert.equal(usedCostOf(0, 0.3), 0.3);
  assert.equal(usedCostOf(0, null), 0);
  assert.equal(usedCostOf(null, null), 0);
});

test("a failed pi pass with no tokens counts 0", () => {
  const o = parsePiStream(fixture("auth-error.jsonl"));
  assert.equal(usedCostOf(o.cliCostUsd ?? null, null), 0);
});
