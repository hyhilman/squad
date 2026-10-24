import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderView } from "@squad/contract";
import { accountPrefix, addBody, badgeLetter, groupProviders, logoIdOf, logoSrc, pickerGroups, providerSub, visibleProviders, secretError, secretField } from "./providers.ts";

const L: ProviderView[] = [
  { id: "codex", name: "Codex (device login)", runner: "codex", kind: "login", models: 3, accounts: 1 },
  { id: "claude", name: "Claude (setup-token)", runner: "claude", kind: "token", models: 1, accounts: 0 },
  { id: "zai", name: "zai", runner: "pi", kind: "key", builtin: true, models: 0, accounts: 0 },
  { id: "engy", name: "engy", runner: "pi", kind: "key", models: 7, accounts: 0 },
];

test("groupProviders: seats, built into pi, then other providers, with the model count; an empty group is dropped", () => {
  const g = groupProviders(L);
  assert.deepEqual(g.map((x) => x.label), ["Seats", "Built into pi", "Other providers (from the catalog)"]);
  assert.deepEqual(g[0]!.options.map((o) => o.value), ["codex", "claude"]);
  assert.equal(g[1]!.options[0]!.label, "zai (zai) - 0 models");
  assert.equal(g[2]!.options[0]!.label, "engy (engy) - 7 models");
  assert.equal(groupProviders([L[1]!])[0]!.options[0]!.label, "Claude (setup-token) (claude) - 1 model");
  assert.deepEqual(groupProviders([L[3]!]).map((x) => x.label), ["Other providers (from the catalog)"]);
  assert.deepEqual(groupProviders([]), []);
});

test("secretField: none for the device login, setup-token with its hint for claude, API key for pi", () => {
  assert.equal(secretField(L[0]).label, undefined);
  assert.equal(secretField(undefined).label, undefined);
  assert.equal(secretField(L[1]).label, "setup-token");
  assert.match(secretField(L[1]).hint!, /claude setup-token/);
  assert.equal(secretField(L[3]).label, "API key");
});

test("secretError follows the server's shape rule", () => {
  assert.equal(secretError("abc-123"), undefined);
  assert.ok(secretError(undefined) && secretError("") && secretError("a b") && secretError("a\nb") && secretError("x".repeat(4097)));
  assert.equal(secretError("x".repeat(4096)), undefined);
});

test("addBody builds the request for each runner", () => {
  assert.deepEqual(addBody(L[0]!, "n", ""), { runner: "codex", name: "n" });
  assert.deepEqual(addBody(L[1]!, "n", "tok"), { runner: "claude", name: "n", token: "tok" });
  assert.deepEqual(addBody(L[3]!, "n", "k"), { runner: "pi", name: "n", provider: "engy", key: "k" });
  assert.deepEqual(addBody(L[2]!, "n", "k"), { runner: "pi", name: "n", provider: "zai", key: "k" });
});

test("accountPrefix is the runner", () => {
  assert.equal(accountPrefix(L[3]), "pi");
  assert.equal(accountPrefix(undefined), "<runner>");
});

const P = (id: string, over: Partial<ProviderView> = {}): ProviderView => ({ id, name: id, runner: "pi", kind: "key", models: 5, accounts: 0, ...over });
const LIST: ProviderView[] = [
  P("engy"), P("zai", { builtin: true }), P("groq", { builtin: true, accounts: 2 }), P("sumopod", { accounts: 1 }), P("empty", { models: 0 }), P("emptybuiltin", { builtin: true, models: 0 }),
  { id: "codex", name: "Codex", runner: "codex", kind: "login", models: 0, accounts: 3 },
  { id: "claude", name: "Claude", runner: "claude", kind: "token", models: 0, accounts: 0 },
];

test("visibleProviders hides a pi provider with no models; the seats always show", () => {
  assert.deepEqual(visibleProviders(LIST).map((p) => p.id), ["engy", "zai", "groq", "sumopod", "codex", "claude"]);
});

test("pickerGroups: Seats, then In use, then Built into pi, then From the catalog; a provider is in the first group that fits", () => {
  const g = pickerGroups(LIST);
  assert.deepEqual(g.map((x) => x.label), ["Seats", "In use", "Built into pi", "From the catalog"]);
  assert.deepEqual(g[0]!.items.map((i) => i.id), ["codex", "claude"], "a used seat stays in Seats");
  assert.deepEqual(g[1]!.items.map((i) => i.id), ["groq", "sumopod"], "most accounts first; groq is built in but sits in In use only");
  assert.deepEqual(g[2]!.items.map((i) => i.id), ["zai"]);
  assert.deepEqual(g[3]!.items.map((i) => i.id), ["engy"]);
  const all = g.flatMap((x) => x.items.map((i) => i.id));
  assert.equal(new Set(all).size, all.length);
});

test("pickerGroups: a search matches name or id, ignores case, and drops empty groups", () => {
  assert.deepEqual(pickerGroups(LIST, "  ENG ").map((x) => [x.label, x.items.map((i) => i.id)]), [["From the catalog", ["engy"]]]);
  assert.deepEqual(pickerGroups([P("a", { name: "Big Pickle" })], "pickle")[0]!.items.map((i) => i.id), ["a"]);
  assert.deepEqual(pickerGroups(LIST, "nothing-like-this"), []);
  assert.deepEqual(pickerGroups([]), []);
});

test("the card says how to sign in, and which logo to ask for", () => {
  assert.equal(providerSub(LIST[6]!), "device login");
  assert.equal(providerSub(LIST[7]!), "setup-token");
  assert.equal(providerSub(P("x", { models: 26 })), "API key · 26 models");
  assert.equal(providerSub(P("x", { models: 1 })), "API key · 1 model");
  assert.equal(logoIdOf(LIST[6]!), "openai");
  assert.equal(logoIdOf(LIST[7]!), "anthropic");
  assert.equal(logoIdOf(P("opencode-go")), "opencode-go");
  assert.equal(logoSrc("opencode-go"), "/logos/opencode-go.svg");
  assert.equal(logoSrc("a/b"), "/logos/a%2Fb.svg");
});

test("badgeLetter is the first letter or digit, upper case, or ? when there is none", () => {
  assert.equal(badgeLetter("engy"), "E");
  assert.equal(badgeLetter("  (zai)"), "Z");
  assert.equal(badgeLetter("!!"), "?");
});

test("addBody for claude with no token starts the server-side sign-in", () => {
  assert.deepEqual(addBody(L[1]!, "n", ""), { runner: "claude", name: "n" });
  assert.deepEqual(addBody(L[1]!, "n"), { runner: "claude", name: "n" });
});

test("pickerGroups: an item has a catalog page only when the catalog lists models for it, so a seat with no catalog gets no details link", () => {
  const items = pickerGroups([
    { id: "codex", name: "Codex (device login)", runner: "codex", kind: "login", models: 0, accounts: 0 },
    { id: "claude", name: "Claude (setup-token)", runner: "claude", kind: "token", models: 3, accounts: 0 },
    { id: "engy", name: "engy", runner: "pi", kind: "key", models: 7, accounts: 0 },
  ]).flatMap((g) => g.items);
  assert.deepEqual(items.map((i) => [i.id, i.catalogId]), [["codex", undefined], ["claude", "anthropic"], ["engy", "engy"]]);
});
