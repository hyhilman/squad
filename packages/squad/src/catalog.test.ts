import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";
import { catalogCtx, catalogModelCompare, catalogProviderDetail, catalogProviderList, isModelIdParam, isProviderIdParam, priceHistory } from "./catalog.ts";
import { parseProviders, recordPriceHistory } from "./prices.ts";
import { providerEntries } from "./providers.ts";
import { openStore } from "./store/db.ts";

const LOCAL = parseProviders(JSON.parse(readFileSync(new URL("../test/fixtures/captures/prices/local-models-dev-excerpt.json", import.meta.url), "utf8")));
const ALL = catalogCtx(providerEntries(LOCAL, undefined), new Map());

test("the provider list: sorted by name, with the runner, the model count (no embedding model) and the cheapest model", () => {
  const list = catalogProviderList(LOCAL, ALL);
  assert.equal(findForbidden(list), undefined);
  assert.deepEqual(list.map((p) => [p.id, p.runner, p.models, p.cheapest?.input, p.cheapest?.output]), [
    ["alibaba-token-plan", "pi", 3, 0.22, 0.66],
    ["anthropic", "claude", 3, 3, 15],
    ["engy", "pi", 3, 0.045, 0.09],
    ["kenari", "pi", 3, 0, 0],
    ["openai", "codex", 2, 2, 8],
    ["opencode", "pi", 3, 2, 6],
    ["opencode-go", "pi", 3, 0.14, 0.28],
    // The embedding model is cheaper (0.13), but it is left out.
    ["sumopod", "pi", 2, 0.14, 0.28],
  ]);
  assert.deepEqual(list.find((p) => p.id === "openai"), { id: "openai", name: "OpenAI", runner: "codex", offered: true, addAs: "codex", models: 2, accounts: 0, cheapest: { input: 2, output: 8 } });
  assert.equal(list.find((p) => p.id === "anthropic")!.addAs, "claude");
  assert.equal(list.find((p) => p.id === "engy")!.addAs, "engy");
});

test("offered follows the providers the web may offer; accounts count seats by runner and pi accounts by provider", () => {
  const ctx = catalogCtx(providerEntries(LOCAL, new Set(["engy", "codex"])), new Map([["codex", 2], ["claude", 1], ["opencode-go", 1]]));
  const list = catalogProviderList(LOCAL, ctx);
  const by = Object.fromEntries(list.map((p) => [p.id, [p.offered, p.addAs, p.accounts]]));
  assert.deepEqual(by, {
    "alibaba-token-plan": [false, undefined, 0], anthropic: [false, undefined, 1], engy: [true, "engy", 0], kenari: [false, undefined, 0],
    openai: [true, "codex", 2], opencode: [false, undefined, 0], "opencode-go": [false, undefined, 1], sumopod: [false, undefined, 0],
  });
});

test("a provider's models: sorted by name, embedding left out, with the price per 1M and how many other providers list the same id", () => {
  const d = catalogProviderDetail(LOCAL, "opencode", ALL)!;
  assert.equal(findForbidden(d), undefined);
  assert.equal(d.provider.id, "opencode");
  assert.deepEqual(d.models.map((m) => [m.name, m.id, m.otherProviders]), [["Claude Sonnet 4.6", "claude-sonnet-4-6", 1], ["Muse Wonder", "muse-wonder-1.0", 0], ["Qwen3.8 Max", "qwen3.8-max", 3]]);
  assert.deepEqual(d.models[2], { id: "qwen3.8-max", name: "Qwen3.8 Max", reasoning: true, context: 262144, maxOutput: 131072, inputs: ["text", "image"], price: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 }, otherProviders: 3 });
  const sumo = catalogProviderDetail(LOCAL, "sumopod", ALL)!;
  assert.deepEqual(sumo.models.map((m) => m.id), ["mimo-v2.6-flash", "qwen3.8-max"]);
  assert.deepEqual(sumo.models[1]!.price, { input: 1, output: 3, cacheRead: 0.125 }, "no cache write price: unset, not the input price");
  assert.equal(catalogProviderDetail(LOCAL, "nope", ALL), undefined);
  assert.equal(catalogProviderDetail([], "opencode", ALL), undefined);
});

test("compare: the exact model id across providers, by input then output price then id; the cheapest flagged, ties all cheapest", () => {
  const q = catalogModelCompare(LOCAL, "qwen3.8-max", ALL, [])!;
  assert.equal(findForbidden(q), undefined);
  assert.equal(q.name, "Qwen3.8 Max");
  assert.deepEqual(q.offers.map((o) => [o.provider, o.price?.input, o.price?.output, o.cheapest]), [
    ["sumopod", 1, 3, true], ["alibaba-token-plan", 2, 6, false], ["opencode", 2, 6, false], ["opencode-go", 2, 6, false],
  ]);
  assert.deepEqual(q.offers[0], { provider: "sumopod", providerName: "SumoPod", runner: "pi", offered: true, addAs: "sumopod", accounts: 0, price: { input: 1, output: 3, cacheRead: 0.125 }, context: 991808, maxOutput: 131072, cheapest: true });
  const s = catalogModelCompare(LOCAL, "claude-sonnet-4-6", ALL, [])!;
  assert.deepEqual(s.offers.map((o) => [o.provider, o.runner, o.cheapest]), [["anthropic", "claude", true], ["opencode", "pi", true]]);
  // Two names for one id: the most common one, then the one of the first provider by id.
  assert.equal(catalogModelCompare(LOCAL, "deepseek-v4-pro", ALL, [])!.name, "DeepSeek V4 Pro");
  // The saved copy has no canonical id: kenari's muse-wonder-1-0 is not opencode's muse-wonder-1.0.
  assert.deepEqual(catalogModelCompare(LOCAL, "muse-wonder-1.0", ALL, [])!.offers.map((o) => o.provider), ["opencode"]);
  assert.equal(catalogModelCompare(LOCAL, "text-embedding-3-large", ALL, []), undefined, "embedding models are left out");
  assert.equal(catalogModelCompare(LOCAL, "QWEN3.8-MAX", ALL, []), undefined, "exact, case and all");
});

test("priceHistory: the rows of the last 90 days for one model id and the given providers, oldest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"));
  const store = openStore({ dbPath: join(dir, "squad.db"), spoolDir: join(dir, "spool") });
  try {
    recordPriceHistory(store.db, new Map([["sumopod/qwen3.8-max", { input: 1.5, output: 4 }]]), new Date("2026-05-01T00:00:00Z"));
    recordPriceHistory(store.db, new Map([["sumopod/qwen3.8-max", { input: 1.2, output: 3.5 }], ["opencode/qwen3.8-max", { input: 2, output: 6 }], ["engy/glm-5.2", { input: 0.68, output: 1.5 }], ["kenari/qwen3.8-max", { input: 9, output: 9 }]]), new Date("2026-09-01T00:00:00Z"));
    recordPriceHistory(store.db, new Map([["sumopod/qwen3.8-max", { input: 1, output: 3 }]]), new Date("2026-10-10T00:00:00Z"));
    const h = priceHistory(store.db, "qwen3.8-max", ["opencode", "sumopod", "opencode-go"], new Date("2026-07-26T12:00:00Z"));
    assert.deepEqual(h, [
      { provider: "opencode", at: "2026-09-01T00:00:00.000Z", input: 2, output: 6 },
      { provider: "sumopod", at: "2026-09-01T00:00:00.000Z", input: 1.2, output: 3.5 },
      { provider: "sumopod", at: "2026-10-10T00:00:00.000Z", input: 1, output: 3 },
    ]);
    assert.deepEqual(priceHistory(store.db, "qwen3.8-max", [], new Date(0)), []);
  } finally {
    store.close();
  }
});

test("the path params: a provider id as the catalog names one; a model id of 1 to 200 visible characters, never only dots", () => {
  for (const ok of ["opencode-go", "a", "x.y_z"]) assert.equal(isProviderIdParam(ok), true, ok);
  for (const bad of ["", "-a", "a/b", "a b", "x".repeat(65), ".."]) assert.equal(isProviderIdParam(bad), false, bad);
  for (const ok of ["qwen3.8-max", "solar-mini4:free", "@cf/meta/llama-4.1", "x".repeat(200)]) assert.equal(isModelIdParam(ok), true, ok);
  for (const bad of ["", ".", "..", "a b", "a\nb", "x".repeat(201), "é"]) assert.equal(isModelIdParam(bad), false, bad);
});
