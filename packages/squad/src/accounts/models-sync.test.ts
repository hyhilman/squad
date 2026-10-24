import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "../home.ts";
import { parseProviders } from "../prices.ts";
import { modelsJsonFor } from "../providers.ts";
import { openStore } from "../store/db.ts";
import { syncModelsFiles } from "./models-sync.ts";
import { createFileAccount } from "./add.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const cat = (models: Record<string, unknown>) => parseProviders({ engy: { name: "engy", api: "https://api.engy.ai/v2", npm: "@ai-sdk/openai-compatible", models } });
const m = (input: number) => ({ name: "M", cost: { input, output: 2 } });
const AUTH = '{"engy":{"type":"api_key","key":"FAKE"}}\n';

function rig() {
  const home = layoutOf(join(mkdtempSync(join(tmpdir(), "sync-")), "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  createFileAccount(store.db, home, { runner: "pi", name: "e1", kind: "key" }, [{ name: "auth.json", body: AUTH }, { name: "models.json", body: modelsJsonFor(cat({ a: m(1) })[0]!).replace("/v2", "/v1") }], NOW);
  return { home, store, file: join(home.accounts, "pi", "e1", "models.json") };
}

test("a changed catalog rewrites the provider's models and address; auth.json is not touched; the mode stays 0600", () => {
  const { home, store, file } = rig();
  const authBefore = statSync(join(home.accounts, "pi", "e1", "auth.json")).mtimeMs;
  assert.equal(syncModelsFiles(home, store, cat({ a: m(1), b: m(3) })), 1);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.providers.engy.models.map((x: { id: string }) => x.id), ["a", "b"]);
  assert.equal(doc.providers.engy.baseUrl, "https://api.engy.ai/v2");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(home.accounts, "pi", "e1", "auth.json"), "utf8"), AUTH);
  assert.equal(statSync(join(home.accounts, "pi", "e1", "auth.json")).mtimeMs, authBefore);
  assert.deepEqual(readdirSync(join(home.accounts, "pi", "e1")).sort(), ["auth.json", "models.json"], "no tmp file");
  store.close();
});

test("an unchanged catalog writes nothing", () => {
  const { home, store } = rig();
  syncModelsFiles(home, store, cat({ a: m(1) }));
  assert.equal(syncModelsFiles(home, store, cat({ a: m(1) })), 0);
  store.close();
});

test("a provider that left the catalog, or has no model left, keeps what the account has; extra fields such as compat stay", () => {
  const { home, store, file } = rig();
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.providers.engy.compat = { supportsDeveloperRole: false };
  writeFileSync(file, JSON.stringify(doc));
  assert.equal(syncModelsFiles(home, store, []), 0);
  assert.equal(syncModelsFiles(home, store, parseProviders({ engy: { api: "https://x", npm: "@ai-sdk/openai-compatible", models: { e: { type: "embedding", cost: { input: 1, output: 1 } } } } })), 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), doc);
  assert.equal(syncModelsFiles(home, store, cat({ a: m(9) })), 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).providers.engy.compat, { supportsDeveloperRole: false });
  store.close();
});

test("an account without models.json, a broken one, and a built-in provider entry are left alone", () => {
  const { home, store } = rig();
  createFileAccount(store.db, home, { runner: "pi", name: "plain", kind: "key" }, [{ name: "auth.json", body: AUTH }], NOW);
  createFileAccount(store.db, home, { runner: "pi", name: "broken", kind: "key" }, [{ name: "auth.json", body: AUTH }, { name: "models.json", body: "{not json" }], NOW);
  const builtin = JSON.stringify({ providers: { zai: { baseUrl: "https://z", models: [] } } });
  createFileAccount(store.db, home, { runner: "pi", name: "bi", kind: "key" }, [{ name: "auth.json", body: AUTH }, { name: "models.json", body: builtin }], NOW);
  mkdirSync(join(home.accounts, "pi", "x"), { recursive: true });
  const zai = parseProviders({ zai: { api: "https://z2", npm: "@ai-sdk/openai-compatible", models: { a: m(1) } } });
  assert.equal(syncModelsFiles(home, store, zai), 0);
  assert.equal(readFileSync(join(home.accounts, "pi", "bi", "models.json"), "utf8"), builtin);
  assert.equal(readFileSync(join(home.accounts, "pi", "broken", "models.json"), "utf8"), "{not json");
  store.close();
});
