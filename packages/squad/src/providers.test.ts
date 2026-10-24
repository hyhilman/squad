import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";
import { parseProviders } from "./prices.ts";
import { PI_BUILTIN_KEY, PI_NOT_OFFERED, PROVIDER_RUNNER, authJsonFor, modelsJsonFor, providerEntries, runnerOf } from "./providers.ts";
import { allowedProviders } from "./web/settings.ts";

const LOCAL = parseProviders(JSON.parse(readFileSync(new URL("../test/fixtures/captures/prices/local-models-dev-excerpt.json", import.meta.url), "utf8")));

test("the provider to runner table is pinned; a provider not in it runs on pi", () => {
  assert.deepEqual(PROVIDER_RUNNER, { anthropic: "claude", openai: "codex", deepseek: "pi", opencode: "pi", "opencode-go": "pi" });
  assert.equal(runnerOf("anthropic"), "claude");
  assert.equal(runnerOf("openai"), "codex");
  assert.equal(runnerOf("engy"), "pi");
});

test("pi 1.1.0's built-in key providers are pinned, and none of them is a provider that is not offered", () => {
  assert.equal(PI_BUILTIN_KEY.length, 34);
  assert.deepEqual([...PI_BUILTIN_KEY], [...PI_BUILTIN_KEY].sort());
  assert.ok(PI_BUILTIN_KEY.includes("opencode") && PI_BUILTIN_KEY.includes("opencode-go") && PI_BUILTIN_KEY.includes("zai"));
  assert.deepEqual(PI_NOT_OFFERED.filter((p) => PI_BUILTIN_KEY.includes(p)), []);
  assert.deepEqual([...PI_NOT_OFFERED].sort(), ["amazon-bedrock", "azure", "cloudflare-ai-gateway", "cloudflare-workers-ai", "github-copilot", "google-vertex", "openai-codex", "radius"]);
});

test("the list: seats first, then pi built-ins, then custom catalog providers; anthropic and openai are the seats", () => {
  const all = providerEntries(LOCAL, undefined);
  assert.deepEqual(all.slice(0, 2).map((e) => [e.id, e.runner, e.kind]), [["codex", "codex", "login"], ["claude", "claude", "token"]]);
  const ids = all.map((e) => e.id);
  assert.ok(!ids.includes("anthropic") && !ids.includes("openai"), "they are seats, not pi providers");
  const oc = all.find((e) => e.id === "opencode-go")!;
  assert.deepEqual([oc.runner, oc.kind, oc.builtin, oc.source], ["pi", "key", true, undefined]);
  assert.ok(oc.models > 0);
  const engy = all.find((e) => e.id === "engy")!;
  assert.deepEqual([engy.runner, engy.kind, engy.builtin], ["pi", "key", undefined]);
  assert.equal(engy.source?.api, "https://api.engy.ai/v1");
  assert.ok(ids.indexOf("opencode") < ids.indexOf("engy"), "built-ins come before custom ones");
  assert.ok(ids.includes("zai"), "a built-in is offered though the catalog excerpt lacks it");
  assert.equal(all.find((e) => e.id === "zai")!.models, 0);
  assert.equal(all.find((e) => e.id === "claude")!.models, LOCAL.find((p) => p.id === "anthropic")!.models.length);
});

test("a provider pi cannot run with one key is never offered, built-in or custom", () => {
  const fake = parseProviders({ azure: { api: "https://x.test/v1", npm: "@ai-sdk/openai-compatible", models: { m: { cost: { input: 1, output: 1 } } } } });
  assert.ok(!providerEntries(fake, undefined).some((e) => e.id === "azure"));
  assert.ok(!providerEntries([], undefined).some((e) => PI_NOT_OFFERED.includes(e.id)));
});

test("a catalog provider needs an api address and the openai-compatible package to be custom", () => {
  const cat = parseProviders({
    ok: { api: "https://ok.test/v1", npm: "@ai-sdk/openai-compatible", models: { m: { cost: { input: 1, output: 1 } } } },
    noapi: { npm: "@ai-sdk/openai-compatible", models: { m: { cost: { input: 1, output: 1 } } } },
    other: { api: "https://o.test", npm: "@ai-sdk/anthropic", models: { m: { cost: { input: 1, output: 1 } } } },
    onlyembed: { api: "https://e.test", npm: "@ai-sdk/openai-compatible", models: { m: { type: "embedding", cost: { input: 1, output: 1 } } } },
  });
  assert.deepEqual(providerEntries(cat, undefined).filter((e) => e.source !== undefined).map((e) => e.id), ["ok"]);
});

test("SQUAD_WEB_PROVIDERS: all by default, or a comma list that restricts", () => {
  assert.equal(allowedProviders({}), undefined);
  assert.equal(allowedProviders({ SQUAD_WEB_PROVIDERS: "all" }), undefined);
  const allow = allowedProviders({ SQUAD_WEB_PROVIDERS: "codex, claude,engy" });
  assert.deepEqual(providerEntries(LOCAL, allow).map((e) => e.id), ["codex", "claude", "engy"]);
  assert.deepEqual(providerEntries(LOCAL, allowedProviders({ SQUAD_WEB_PROVIDERS: "nope" })), []);
});

test("models.json for a custom provider has pi's shape, no embedding, only text and image input, and cache prices", () => {
  const engy = LOCAL.find((p) => p.id === "engy")!;
  const doc = JSON.parse(modelsJsonFor(engy));
  assert.deepEqual(Object.keys(doc), ["providers"]);
  assert.equal(doc.providers.engy.baseUrl, "https://api.engy.ai/v1");
  assert.equal(doc.providers.engy.api, "openai-completions");
  const glm = doc.providers.engy.models.find((m: { id: string }) => m.id === "glm-5.2");
  assert.deepEqual(glm, { id: "glm-5.2", name: "GLM-5.2", reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 32768, cost: { input: 0.68, output: 1.5, cacheRead: 0.18, cacheWrite: 0 } });
  const cat = parseProviders({ p: { api: "https://p.test", npm: "@ai-sdk/openai-compatible", models: { e: { type: "embedding", cost: { input: 1, output: 1 } }, v: { modalities: { input: ["text", "image", "pdf", "video"] }, cost: { input: 1, output: 1 } } } } });
  const models = JSON.parse(modelsJsonFor(cat[0]!)).providers.p.models;
  assert.deepEqual(models.map((m: { id: string; input: string[] }) => [m.id, m.input]), [["v", ["text", "image"]]]);
});

test("auth.json for a key is pi's api_key shape", () => {
  assert.deepEqual(JSON.parse(authJsonFor("engy", "FAKE-KEY")), { engy: { type: "api_key", key: "FAKE-KEY" } });
  assert.equal(findForbidden(JSON.parse(modelsJsonFor(LOCAL.find((p) => p.id === "engy")!))), undefined);
});
