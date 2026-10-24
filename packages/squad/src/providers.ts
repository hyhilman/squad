// Which providers the web app may offer when a person adds an account, and the models.json that
// pi needs for a provider it does not know by itself.
//
// Two tables decide it, both here: which runner serves a provider (PROVIDER_RUNNER), and which API-key
// providers pi has built in (PI_BUILTIN_KEY).

import { readFileSync } from "node:fs";
import type { AccountKind, Runner } from "./docker.ts";
import type { CatalogModel, CatalogProvider } from "./prices.ts";

/**
 * Which runner serves a catalog provider. A provider that is not listed runs on pi. Change one row to
 * move a provider: deepseek, opencode and opencode-go run on pi for now, and move to their own runners
 * (dsh, an opencode runner) when those exist.
 */
export const PROVIDER_RUNNER: Readonly<Record<string, Runner>> = {
  anthropic: "claude",
  openai: "codex",
  deepseek: "pi",
  opencode: "pi",
  "opencode-go": "pi",
};

export const runnerOf = (provider: string): Runner => PROVIDER_RUNNER[provider] ?? "pi";

/** What a person gives to add an account of a runner. */
export const KIND_OF_RUNNER: Readonly<Partial<Record<Runner, AccountKind>>> = { claude: "token", codex: "login", pi: "key" };

/**
 * The providers pi 1.1.0 has built in (models.generated.js) that take one plain API key. It changes
 * with the pinned image: a test pins this list. Left out on purpose: the ones that need more than one
 * setting (amazon-bedrock, azure, google-vertex, cloudflare-ai-gateway, cloudflare-workers-ai, radius)
 * and the subscription logins (github-copilot, openai-codex).
 */
export const PI_BUILTIN_KEY: readonly string[] = [
  "ant-ling", "anthropic", "baseten", "cerebras", "deepseek", "fireworks", "google", "groq", "huggingface", "kimi-coding", "meta", "minimax", "minimax-cn",
  "mistral", "moonshotai", "moonshotai-cn", "nvidia", "openai", "opencode", "opencode-go", "openrouter", "qwen-token-plan", "qwen-token-plan-cn",
  "qwen-token-plan-individual", "together", "typesafe", "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
];
/** pi built-ins that must not be offered, and must not be built as a custom provider either. */
export const PI_NOT_OFFERED: readonly string[] = ["amazon-bedrock", "azure", "google-vertex", "cloudflare-ai-gateway", "cloudflare-workers-ai", "radius", "github-copilot", "openai-codex"];

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible";

export interface ProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly runner: Runner;
  readonly kind: AccountKind;
  readonly builtin?: true;
  readonly models: number;
  /** The catalog provider that holds its models and, for a custom one, its address. */
  readonly source?: CatalogProvider;
}

const offeredModels = (p: CatalogProvider): readonly CatalogModel[] => p.models.filter((m) => m.type !== "embedding");

/** Every provider the web may offer, seats first, then pi's built-ins, then the catalog's custom ones. */
export function providerEntries(catalog: readonly CatalogProvider[], allow: ReadonlySet<string> | undefined): ProviderEntry[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const count = (runner: Runner): number => catalog.filter((p) => runnerOf(p.id) === runner).reduce((n, p) => n + offeredModels(p).length, 0);
  const out: ProviderEntry[] = [
    { id: "codex", name: "Codex (device login)", runner: "codex", kind: "login", models: count("codex") },
    { id: "claude", name: "Claude (setup-token)", runner: "claude", kind: "token", models: count("claude") },
  ];
  const builtin = PI_BUILTIN_KEY.filter((id) => runnerOf(id) === "pi" && !PI_NOT_OFFERED.includes(id)).sort();
  for (const id of builtin) {
    const p = byId.get(id);
    out.push({ id, name: p?.name ?? id, runner: "pi", kind: "key", builtin: true, models: p === undefined ? 0 : offeredModels(p).length });
  }
  const custom = catalog
    .filter((p) => runnerOf(p.id) === "pi" && !PI_BUILTIN_KEY.includes(p.id) && !PI_NOT_OFFERED.includes(p.id) && p.api !== undefined && p.npm === OPENAI_COMPATIBLE && offeredModels(p).length > 0 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of custom) out.push({ id: p.id, name: p.name ?? p.id, runner: "pi", kind: "key", models: offeredModels(p).length, source: p });
  return allow === undefined ? out : out.filter((e) => allow.has(e.id));
}

// ---- models.json for a custom provider ----

const PI_INPUTS: readonly string[] = ["text", "image"];

function modelEntry(m: CatalogModel): Record<string, unknown> {
  const input = (m.input ?? ["text"]).filter((x) => PI_INPUTS.includes(x));
  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    ...(m.context === undefined ? {} : { contextWindow: m.context }),
    ...(m.output === undefined ? {} : { maxTokens: m.output }),
    cost: { input: m.price.input, output: m.price.output, cacheRead: m.price.cacheRead ?? 0, cacheWrite: m.price.cacheWrite ?? 0 },
  };
}

/** The `models` list pi reads for a custom provider; embedding models are left out. */
export function piModels(p: CatalogProvider): Record<string, unknown>[] {
  return offeredModels(p).map(modelEntry);
}

/** The whole models.json for one custom provider (pi 1.1.0, docs/models.md). */
export function modelsJsonFor(p: CatalogProvider): string {
  return `${JSON.stringify({ providers: { [p.id]: { baseUrl: p.api, api: "openai-completions", models: piModels(p) } } }, null, 2)}\n`;
}

/** The auth.json pi reads for an API key. */
export const authJsonFor = (provider: string, key: string): string => `${JSON.stringify({ [provider]: { type: "api_key", key } }, null, 2)}\n`;

/** The provider ids in a pi account's auth.json (the keys only, never a value). Unreadable or odd = none. */
export function piProvidersIn(authFile: string): string[] {
  try {
    const j: unknown = JSON.parse(readFileSync(authFile, "utf8"));
    return typeof j === "object" && j !== null && !Array.isArray(j) ? Object.keys(j) : [];
  } catch {
    return [];
  }
}
