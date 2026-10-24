import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "./home.ts";
import { costOf, loadPrices, parseCatalog, passCost } from "./prices.ts";

const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// A models.dev style catalog, cut down to what the parse reads.
const CATALOG = {
  "opencode-go": {
    models: {
      "hy4-preview": { cost: { input: 0.15, output: 0.5, cache_read: 0.03 }, canonical_model_id: "x/hy4" },
      "no-cost": { name: "no cost here" },
      "bad-cost": { cost: { input: "1", output: 2 } },
      free: { cost: { input: 0, output: 0 } },
    },
  },
  anthropic: { models: { "claude-sonnet-5-5": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
  broken: "not an object",
};

test("each kind of token has its own price, and a cache price left out is the input price", () => {
  const t = { input: 1e6, output: 1e6, cacheRead: 10e6, cacheWrite: 1e6 };
  near(costOf(t, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }), 1 + 2 + 1 + 1.25);
  near(costOf(t, { input: 1, output: 2 }), 1 + 2 + 10 + 1);
});

test("parseCatalog keys prices provider/model and skips a model without a usable input and output price", () => {
  const p = parseCatalog(CATALOG);
  assert.deepEqual([...p.keys()].sort(), ["anthropic/claude-sonnet-5-5", "opencode-go/free", "opencode-go/hy4-preview"]);
  assert.deepEqual(p.get("opencode-go/hy4-preview"), { input: 0.15, output: 0.5, cacheRead: 0.03 });
  assert.deepEqual(p.get("anthropic/claude-sonnet-5-5"), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
});

test("parseCatalog takes junk without throwing", () => {
  for (const j of [null, 1, "x", [], {}, { a: { models: 3 } }]) assert.equal(parseCatalog(j).size, 0);
});

const usage = { input: 1493, output: 71, cacheRead: 64, cacheWrite: 0, reasoning: 68 };

test("passCost: a key pass with a price has a cost; reasoning is not charged twice", () => {
  const r = passCost("key", "opencode-go/hy4-preview", usage, parseCatalog(CATALOG));
  assert.ok(r !== null);
  near(r.costUsd, (1493 * 0.15 + 71 * 0.5 + 64 * 0.03) / 1e6);
  assert.equal(r.priceSrc, "catalog");
});

test("passCost: login and token accounts have no money cost", () => {
  const p = parseCatalog(CATALOG);
  assert.equal(passCost("login", "opencode-go/hy4-preview", usage, p), null);
  assert.equal(passCost("token", "opencode-go/hy4-preview", usage, p), null);
});

test("passCost: an unknown model has no cost", () => {
  assert.equal(passCost("key", "opencode-go/nope", usage, parseCatalog(CATALOG)), null);
  assert.equal(passCost("key", "opencode-go/hy4-preview", usage, new Map()), null);
});

test("loadPrices reads state/prices.json; a missing or bad file is no prices", () => {
  const home = layoutOf(join(mkdtempSync(join(tmpdir(), "prices-")), "home"), {});
  ensureHome(home);
  assert.equal(loadPrices(home).size, 0);
  writeFileSync(join(home.state, "prices.json"), "{not json");
  assert.equal(loadPrices(home).size, 0);
  writeFileSync(join(home.state, "prices.json"), JSON.stringify(CATALOG));
  assert.equal(loadPrices(home).size, 3);
  mkdirSync(join(home.state, "x"), { recursive: true });
});
