import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderView } from "@squad/contract";
import { accountPrefix, addBody, groupProviders, secretError, secretField } from "./providers.ts";

const L: ProviderView[] = [
  { id: "codex", name: "Codex (device login)", runner: "codex", kind: "login", models: 3 },
  { id: "claude", name: "Claude (setup-token)", runner: "claude", kind: "token", models: 1 },
  { id: "zai", name: "zai", runner: "pi", kind: "key", builtin: true, models: 0 },
  { id: "engy", name: "engy", runner: "pi", kind: "key", models: 7 },
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
