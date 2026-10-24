import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogModelView, CatalogProviderView } from "@squad/contract";
import { cheapestIds, contextText, filterProviders, historyRows, modelPath, perMillionText, providerPath, runnersOf, sortModels } from "./catalog.ts";

test("perMillionText: dollars per 1M tokens; free for zero; small prices keep their digits", () => {
  assert.equal(perMillionText(undefined), "-");
  assert.equal(perMillionText(0), "free");
  assert.equal(perMillionText(3), "$3.00");
  assert.equal(perMillionText(150), "$150.00");
  assert.equal(perMillionText(3.90059), "$3.90");
  assert.equal(perMillionText(0.14), "$0.14");
  assert.equal(perMillionText(0.125), "$0.125");
  assert.equal(perMillionText(0.045), "$0.045");
  assert.equal(perMillionText(0.0028), "$0.0028");
  assert.equal(perMillionText(0.111445), "$0.1114");
});

test("contextText: tokens as K or M", () => {
  assert.equal(contextText(undefined), "-");
  assert.equal(contextText(8191), "8K");
  assert.equal(contextText(262144), "262K");
  assert.equal(contextText(1000000), "1M");
  assert.equal(contextText(1100000), "1.1M");
});

const P = (id: string, name: string, runner: CatalogProviderView["runner"], accounts: number): CatalogProviderView => ({ id, name, runner, offered: true, models: 1, accounts });
const LIST = [P("anthropic", "Anthropic", "claude", 0), P("engy", "engy", "pi", 2), P("openai", "OpenAI", "codex", 1), P("opencode-go", "OpenCode Go", "pi", 0)];

test("filterProviders: the search matches the name or the id; the filter is all, in use, or one runner", () => {
  assert.deepEqual(filterProviders(LIST, "", "all").map((p) => p.id), ["anthropic", "engy", "openai", "opencode-go"]);
  assert.deepEqual(filterProviders(LIST, " open ", "all").map((p) => p.id), ["openai", "opencode-go"]);
  assert.deepEqual(filterProviders(LIST, "code-go", "all").map((p) => p.id), ["opencode-go"]);
  assert.deepEqual(filterProviders(LIST, "", "in-use").map((p) => p.id), ["engy", "openai"]);
  assert.deepEqual(filterProviders(LIST, "", "pi").map((p) => p.id), ["engy", "opencode-go"]);
  assert.deepEqual(filterProviders(LIST, "anth", "pi"), []);
  assert.deepEqual(runnersOf(LIST), ["claude", "codex", "pi"]);
});

const M = (id: string, name: string, input: number, extra: Partial<CatalogModelView> = {}): CatalogModelView => ({ id, name, reasoning: false, inputs: ["text"], price: { input, output: input * 2 }, otherProviders: 0, ...extra });
const MODELS = [M("b", "Beta", 2, { context: 1000 }), M("a", "Alpha", 1, { price: { input: 1, output: 3, cacheRead: 0.1 } }), M("c", "Gamma", 0.5, { context: 5000, price: { input: 0.5, output: 9, cacheRead: 0.1 } })];

test("sortModels: by any column, both ways; a missing value goes last either way; ties by name", () => {
  assert.deepEqual(sortModels(MODELS, "name", "asc").map((m) => m.id), ["a", "b", "c"]);
  assert.deepEqual(sortModels(MODELS, "name", "desc").map((m) => m.id), ["c", "b", "a"]);
  assert.deepEqual(sortModels(MODELS, "input", "asc").map((m) => m.id), ["c", "a", "b"]);
  assert.deepEqual(sortModels(MODELS, "output", "desc").map((m) => m.id), ["c", "b", "a"]);
  assert.deepEqual(sortModels(MODELS, "context", "asc").map((m) => m.id), ["b", "c", "a"]);
  assert.deepEqual(sortModels(MODELS, "context", "desc").map((m) => m.id), ["c", "b", "a"]);
  assert.deepEqual(sortModels(MODELS, "cacheRead", "desc").map((m) => m.id), ["a", "c", "b"], "equal values keep name order; missing last");
  assert.deepEqual(MODELS.map((m) => m.id), ["b", "a", "c"], "the input is not changed");
});

test("cheapestIds: the lowest price in a column; none when a column has under two prices or all are equal; a missing cache price is not the input price", () => {
  assert.deepEqual([...cheapestIds(MODELS, "input")], ["c"]);
  assert.deepEqual([...cheapestIds(MODELS, "output")], ["a"]);
  assert.deepEqual([...cheapestIds(MODELS, "cacheRead")], [], "two equal values");
  assert.deepEqual([...cheapestIds(MODELS, "cacheWrite")], []);
  assert.deepEqual([...cheapestIds([MODELS[0]!], "input")], []);
  assert.deepEqual([...cheapestIds([...MODELS, M("d", "Delta", 0.5)], "input")].sort(), ["c", "d"], "ties are all cheapest");
});

test("paths: a model id with a slash, a colon or a dot stays one path part", () => {
  assert.equal(modelPath("qwen3.8-max"), "/catalog/models/qwen3.8-max");
  assert.equal(modelPath("@cf/meta/llama"), "/catalog/models/%40cf%2Fmeta%2Fllama");
  assert.equal(modelPath("solar-mini4:free"), "/catalog/models/solar-mini4%3Afree");
  assert.equal(providerPath("opencode-go"), "/catalog/opencode-go");
});

test("historyRows: one row per time, one input price per provider, carried forward; the providers in order", () => {
  const h = historyRows([
    { provider: "sumopod", modelId: "qwen3.8-max", at: "2026-09-01T00:00:00.000Z", input: 1.2, output: 3.5 },
    { provider: "opencode", modelId: "qwen3.8-max", at: "2026-09-01T00:00:00.000Z", input: 2, output: 6 },
    { provider: "sumopod", modelId: "qwen3.8-max", at: "2026-10-10T00:00:00.000Z", input: 1, output: 3 },
  ]);
  assert.deepEqual(h.providers, ["opencode", "sumopod"]);
  assert.deepEqual(h.rows, [
    { at: "2026-09-01T00:00:00.000Z", opencode: 2, sumopod: 1.2 },
    { at: "2026-10-10T00:00:00.000Z", opencode: 2, sumopod: 1 },
  ]);
  assert.deepEqual(historyRows([]), { providers: [], rows: [] });
});
