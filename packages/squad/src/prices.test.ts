import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "./home.ts";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./store/db.ts";
import { PRICES_FILE, PRICES_TTL_MS, SQUAD_NO_PRICES_ENV, SQUAD_PRICES_URL_ENV, backfillCatalogCosts, catalogCost, catalogKey, costOf, loadPrices, loadProviders, parseCatalog, parseProviders, passCost, priceAt, recordPriceHistory, refreshPrices } from "./prices.ts";

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
  writeFileSync(join(home.state, "prices.json"), JSON.stringify({ v: 1, fetchedAt: 1, catalog: CATALOG }));
  assert.equal(loadPrices(home).size, 3);
  mkdirSync(join(home.state, "x"), { recursive: true });
});

// ---- refreshPrices ----
const BODY = readFileSync(new URL("../test/fixtures/captures/prices/models-dev-excerpt.json", import.meta.url), "utf8");
const URL_ = "https://catalog.test/api.json";
const NOW = 1_800_000_000_000;

const tmpHome = () => {
  const home = layoutOf(join(mkdtempSync(join(tmpdir(), "prices-")), "home"), {});
  ensureHome(home);
  return home;
};
type Fetch = Parameters<typeof refreshPrices>[0]["fetch"];
const answer = (body: string, status = 200): Fetch => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const never: Fetch = async () => {
  throw new Error("fetch must not run");
};
const run = (home: ReturnType<typeof tmpHome>, o: Partial<Parameters<typeof refreshPrices>[0]> = {}) =>
  refreshPrices({ home, url: URL_, now: NOW, fetch: answer(BODY), env: {}, ...o });

test("refresh saves the real catalog and loadPrices reads what was saved", async () => {
  const home = tmpHome();
  assert.equal(await run(home), "refreshed");
  const p = loadPrices(home);
  assert.deepEqual(p.get("opencode-go/beam-free"), { input: 0, output: 0, cacheRead: 0 });
  assert.deepEqual(p.get("anthropic/claude-sonnet-4-5"), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  assert.equal(p.size, parseCatalog(JSON.parse(BODY)).size);
  const saved = JSON.parse(readFileSync(join(home.state, PRICES_FILE), "utf8"));
  assert.equal(saved.fetchedAt, NOW);
  assert.ok(readFileSync(join(home.state, PRICES_FILE)).length < BODY.length, "the saved copy is trimmed");
  assert.deepEqual(readdirSync(home.state).filter((f) => f.endsWith(".tmp")), []);
});

test("a copy younger than the TTL is fresh and nothing is fetched", async () => {
  const home = tmpHome();
  await run(home);
  assert.equal(await run(home, { now: NOW + PRICES_TTL_MS - 1, fetch: never }), "fresh");
});

test("a copy at the TTL is renewed", async () => {
  const home = tmpHome();
  await run(home);
  assert.equal(await run(home, { now: NOW + PRICES_TTL_MS }), "refreshed");
  assert.equal(JSON.parse(readFileSync(join(home.state, PRICES_FILE), "utf8")).fetchedAt, NOW + PRICES_TTL_MS);
});

test("a copy from the future is not fresh (the clock moved back)", async () => {
  const home = tmpHome();
  await run(home, { now: NOW + 1000 });
  assert.equal(await run(home), "refreshed");
});

const keptOld = async (o: Partial<Parameters<typeof refreshPrices>[0]>, reason: RegExp) => {
  const home = tmpHome();
  await run(home);
  const before = readFileSync(join(home.state, PRICES_FILE), "utf8");
  const r = await run(home, { now: NOW + PRICES_TTL_MS, ...o });
  assert.match(r, reason);
  assert.ok(r.startsWith("kept: "));
  assert.equal(readFileSync(join(home.state, PRICES_FILE), "utf8"), before);
  assert.ok(loadPrices(home).size > 0);
};

test("a 500 keeps the old copy", () => keptOld({ fetch: answer("oops", 500) }, /500/));
test("junk keeps the old copy", () => keptOld({ fetch: answer("<html>nope") }, /./));
test("a catalog with no usable model keeps the old copy", () => keptOld({ fetch: answer(JSON.stringify({ a: { models: { m: { cost: { input: "1" } } } } })) }, /no model/));
test("a body over the byte cap keeps the old copy", () => keptOld({ fetch: answer(" ".repeat(33 * 1024 * 1024)) }, /too big/));
test("a fetch that throws keeps the old copy", () =>
  keptOld(
    {
      fetch: async () => {
        throw new Error("boom");
      },
    },
    /boom/,
  ));

test("a failure with no old copy writes nothing", async () => {
  const home = tmpHome();
  assert.match(await run(home, { fetch: answer("x", 503) }), /^kept: /);
  assert.equal(loadPrices(home).size, 0);
  assert.deepEqual(readdirSync(home.state).filter((f) => f.startsWith(PRICES_FILE)), []);
});

test("an empty url is off", async () => {
  assert.equal(await run(tmpHome(), { url: "", fetch: never }), "off");
});

test("SQUAD_NO_PRICES=1 is off; other values are not", async () => {
  assert.equal(await run(tmpHome(), { env: { SQUAD_NO_PRICES: "1" }, fetch: never }), "off");
  assert.equal(await run(tmpHome(), { env: { SQUAD_NO_PRICES: "true" } }), "refreshed");
});

test("SQUAD_DRY_RUN=1 never fetches", async () => {
  const home = tmpHome();
  assert.equal(await run(home, { env: { SQUAD_DRY_RUN: "1" }, fetch: never }), "off");
  assert.deepEqual(readdirSync(home.state).filter((f) => f.startsWith(PRICES_FILE)), []);
});

test("the fetch has a timeout and refuses redirects", async () => {
  let init: RequestInit | undefined;
  await run(tmpHome(), {
    fetch: async (_u, i) => {
      init = i;
      return { ok: true, status: 200, text: async () => BODY };
    },
  });
  assert.equal(init?.redirect, "error");
  assert.ok(init?.signal instanceof AbortSignal);
});

test("loadPrices gives no prices for the old raw shape or a wrong version", () => {
  const home = tmpHome();
  writeFileSync(join(home.state, PRICES_FILE), JSON.stringify(CATALOG));
  assert.equal(loadPrices(home).size, 0);
  writeFileSync(join(home.state, PRICES_FILE), JSON.stringify({ v: 99, fetchedAt: 1, catalog: CATALOG }));
  assert.equal(loadPrices(home).size, 0);
});

test("the settings rows", () => {
  assert.equal(SQUAD_PRICES_URL_ENV.key, "SQUAD_PRICES_URL");
  assert.equal(SQUAD_PRICES_URL_ENV.default, "https://models.dev/api.json");
  assert.equal(SQUAD_NO_PRICES_ENV.key, "SQUAD_NO_PRICES");
  assert.ok(!SQUAD_PRICES_URL_ENV.why.includes("\n"));
});

// ---- the richer saved copy, the history, the catalog cost ----

const LOCAL = readFileSync(new URL("../test/fixtures/captures/prices/local-models-dev-excerpt.json", import.meta.url), "utf8");

test("refresh keeps the base URL, names, limits, reasoning and input kinds, and the saved version is 2", async () => {
  const home = tmpHome();
  assert.equal(await run(home, { fetch: answer(LOCAL) }), "refreshed");
  assert.equal(JSON.parse(readFileSync(join(home.state, PRICES_FILE), "utf8")).v, 2);
  const engy = loadProviders(home).find((p) => p.id === "engy")!;
  assert.equal(engy.api, "https://api.engy.ai/v1");
  assert.equal(engy.name, "engy");
  assert.equal(engy.npm, "@ai-sdk/openai-compatible");
  const glm = engy.models.find((m) => m.id === "glm-5.2")!;
  assert.deepEqual({ ...glm }, { id: "glm-5.2", name: "GLM-5.2", reasoning: true, context: 262144, output: 32768, input: ["text"], price: { input: 0.68, output: 1.5, cacheRead: 0.18 } });
  assert.equal(loadProviders(home).find((p) => p.id === "anthropic")!.api, undefined);
  assert.ok(readFileSync(join(home.state, PRICES_FILE)).length < LOCAL.length / 2, "no description or other bulk is kept");
  assert.equal(loadPrices(home).size, parseCatalog(JSON.parse(LOCAL)).size);
});

test("an old version-1 file still loads its prices, but a refresh renews it at once", async () => {
  const home = tmpHome();
  writeFileSync(join(home.state, PRICES_FILE), JSON.stringify({ v: 1, fetchedAt: NOW, catalog: CATALOG }));
  assert.equal(loadPrices(home).size, 3);
  assert.equal(await run(home, { fetch: answer(LOCAL) }), "refreshed");
});

test("parseProviders takes junk without throwing", () => {
  for (const j of [null, 1, "x", [], {}, { a: { models: 3 } }, { a: { models: { m: {} } } }]) assert.deepEqual(parseProviders(j), []);
});

const history = () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
};

test("price history: a row for a new or changed price only, and priceAt gives the price in force at a time", () => {
  const db = history();
  const t = (n: number) => new Date(Date.UTC(2026, 9, n));
  assert.equal(recordPriceHistory(db, new Map([["p/m", { input: 1, output: 2 }], ["p/n", { input: 5, output: 6, cacheRead: 1 }]]), t(1)), 2);
  assert.equal(recordPriceHistory(db, new Map([["p/m", { input: 1, output: 2 }], ["p/n", { input: 5, output: 6, cacheRead: 1 }]]), t(2)), 0, "unchanged");
  assert.equal(recordPriceHistory(db, new Map([["p/m", { input: 1.5, output: 2 }], ["p/n", { input: 5, output: 6, cacheRead: 1 }]]), t(3)), 1, "one changed");
  assert.equal(priceAt(db, "p/m", t(0)), undefined, "before the first row");
  assert.deepEqual(priceAt(db, "p/m", t(2)), { input: 1, output: 2 });
  assert.deepEqual(priceAt(db, "p/m", t(3)), { input: 1.5, output: 2 });
  assert.deepEqual(priceAt(db, "p/n", t(9)), { input: 5, output: 6, cacheRead: 1 });
  assert.equal(priceAt(db, "p/none", t(9)), undefined);
});

test("catalogKey: pi keeps provider/model, codex is under openai, claude under anthropic", () => {
  assert.equal(catalogKey("pi", "engy/glm-5.2"), "engy/glm-5.2");
  assert.equal(catalogKey("pi", "bare"), undefined);
  assert.equal(catalogKey("codex", "gpt-6-1-sol"), "openai/gpt-6-1-sol");
  assert.equal(catalogKey("claude", "claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5");
});

test("catalogCost uses the price at the pass time, falls back to the saved copy, and is null with no price", () => {
  const db = history();
  recordPriceHistory(db, new Map([["anthropic/m", { input: 1, output: 2 }]]), new Date("2026-10-01T00:00:00Z"));
  recordPriceHistory(db, new Map([["anthropic/m", { input: 10, output: 20 }]]), new Date("2026-10-10T00:00:00Z"));
  const u = { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const cur = new Map([["anthropic/m", { input: 10, output: 20 }], ["openai/x", { input: 3, output: 0 }]]);
  near(catalogCost(db, cur, "claude", "m", u, new Date("2026-10-05T00:00:00Z"))!, 3);
  near(catalogCost(db, cur, "claude", "m", u, new Date("2026-10-11T00:00:00Z"))!, 30);
  near(catalogCost(db, cur, "codex", "x", u, new Date("2026-10-11T00:00:00Z"))!, 3); // from the saved copy: no history row
  assert.equal(catalogCost(db, cur, "codex", "nope", u, new Date()), null);
  assert.equal(catalogCost(db, cur, "pi", "bare", u, new Date()), null);
});

test("backfillCatalogCosts prices old passes that have none, and leaves set ones and unknown models alone", () => {
  const db = history();
  const add = (id: string, runner: string, model: string, cost: number | null) => {
    db.prepare("INSERT INTO passes (id, started_at, ended_at, project, flow, action, runner, model, outcome, input, output, catalog_cost_usd) VALUES (?, ?, ?, 'p', 'f', 'a', ?, ?, 'ok', 1000000, 1000000, ?)")
      .run(id, "2026-10-01T00:00:00.000Z", "2026-10-01T00:01:00.000Z", runner, model, cost);
  };
  add("A", "codex", "x", null);
  add("B", "codex", "x", 99);
  add("C", "codex", "unknown-model", null);
  const cur = new Map([["openai/x", { input: 3, output: 1 }]]);
  assert.equal(backfillCatalogCosts(db, cur), 1);
  const cost = (id: string) => (db.prepare("SELECT catalog_cost_usd c FROM passes WHERE id = ?").get(id) as { c: number | null }).c;
  near(cost("A")!, 4);
  assert.equal(cost("B"), 99, "a cost already set is kept");
  assert.equal(cost("C"), null, "no price, no cost");
  assert.equal(backfillCatalogCosts(db, cur), 0, "nothing left to do");
});
