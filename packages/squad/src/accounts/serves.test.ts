import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findForbidden } from "@squad/contract";
import { ensureHome, layoutOf } from "../home.ts";
import { openStore } from "../store/db.ts";
import { addAccount, getAccount, putHealth, setState } from "./store.ts";
import { emptyHealth } from "./health.ts";
import { listAccountsWithServes, servesOf } from "./serves.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "captures", "pi", "login", "auth.json");

function rig() {
  const root = mkdtempSync(join(tmpdir(), "serves-"));
  const home = layoutOf(join(root, "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const dir = (runner: string, name: string): string => {
    const d = join(home.accounts, runner, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  return { home, store, dir };
}

test("pi: providers come from auth.json; without models.json the models are unknown", () => {
  const r = rig();
  const a = addAccount(r.store.db, { runner: "pi", name: "dev", kind: "login" }, NOW);
  copyFileSync(FIXTURE, join(r.dir("pi", "dev"), "auth.json"));
  const serves = servesOf(r.home, a);
  assert.deepEqual(serves, [{ provider: "opencode" }]);
  assert.ok(!("models" in serves[0]!));
});

test("pi: models.json lists models per provider (pi's documented shape) and adds providers that auth.json lacks", () => {
  const r = rig();
  const a = addAccount(r.store.db, { runner: "pi", name: "dev", kind: "login" }, NOW);
  const d = r.dir("pi", "dev");
  copyFileSync(FIXTURE, join(d, "auth.json"));
  writeFileSync(join(d, "models.json"), JSON.stringify({
    providers: {
      opencode: { models: [{ id: "hy4-preview" }, { id: "big" }] },
      ollama: { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "SECRET-KEY-VALUE", models: [{ id: "qwen2.5-coder:7b" }] },
      override: { modelOverrides: { "a": { promptCache: { short: 1 } } } },
    },
  }));
  const serves = servesOf(r.home, a);
  assert.deepEqual(serves, [
    { provider: "ollama", models: ["qwen2.5-coder:7b"] },
    { provider: "opencode", models: ["hy4-preview", "big"] },
    { provider: "override" },
  ]);
  assert.equal(findForbidden(serves), undefined);
  assert.ok(!JSON.stringify(serves).includes("SECRET-KEY-VALUE"));
});

test("pi: a missing or broken file gives no providers and never throws", () => {
  const r = rig();
  const a = addAccount(r.store.db, { runner: "pi", name: "none", kind: "login" }, NOW);
  assert.deepEqual(servesOf(r.home, a), []);
  const b = addAccount(r.store.db, { runner: "pi", name: "bad", kind: "login" }, NOW);
  writeFileSync(join(r.dir("pi", "bad"), "auth.json"), "{not json");
  writeFileSync(join(r.dir("pi", "bad"), "models.json"), "[]");
  assert.deepEqual(servesOf(r.home, b), []);
});

test("codex serves openai and claude serves anthropic, with no model list", () => {
  const r = rig();
  const c = addAccount(r.store.db, { runner: "codex", name: "c", kind: "login" }, NOW);
  const k = addAccount(r.store.db, { runner: "claude", name: "k", kind: "login" }, NOW);
  assert.deepEqual(servesOf(r.home, c), [{ provider: "openai" }]);
  assert.deepEqual(servesOf(r.home, k), [{ provider: "anthropic" }]);
});

test("listAccountsWithServes: health, busy, room with reset times, and no secret anywhere", () => {
  const r = rig();
  addAccount(r.store.db, { runner: "pi", name: "dev", kind: "login" }, NOW);
  addAccount(r.store.db, { runner: "codex", name: "c", kind: "login" }, NOW);
  addAccount(r.store.db, { runner: "claude", name: "dead1", kind: "login" }, NOW);
  copyFileSync(FIXTURE, join(r.dir("pi", "dev"), "auth.json"));
  setState(r.store.db, "claude/dead1", "dead", "refresh_token_reused", NOW);
  putHealth(r.store.db, { ...emptyHealth("codex/c"), coolUntil: "2026-10-24T13:00:00.000Z", coolKind: "rate-limit", left5h: 40, leftWeek: 70, readAt: NOW.toISOString(), resets5h: "2026-10-24T15:00:00.000Z", resetsWeek: "2026-10-30T00:00:00.000Z" });
  const list = listAccountsWithServes({ home: r.home, store: r.store, now: () => NOW, busy: (a) => a.id === "pi/dev" }, undefined);
  assert.deepEqual(list.map((x) => x.account), ["claude/dead1", "codex/c", "pi/dev"]);
  const [dead, codex, pi] = list;
  assert.deepEqual([dead!.runner, dead!.kind, dead!.health], ["claude", "login", { state: "dead", code: "refresh_token_reused" }]);
  assert.deepEqual(codex!.health, { state: "cooling", coolUntil: "2026-10-24T13:00:00.000Z" });
  assert.deepEqual(codex!.room, { left5h: 40, leftWeek: 70, resets5h: "2026-10-24T15:00:00.000Z", resetsWeek: "2026-10-30T00:00:00.000Z", readAt: NOW.toISOString() });
  assert.deepEqual(codex!.serves, [{ provider: "openai" }]);
  assert.deepEqual([pi!.busy, codex!.busy, pi!.health.state, pi!.room], [true, false, "ok", {}]);
  assert.equal(findForbidden(list), undefined);
  assert.deepEqual(listAccountsWithServes({ home: r.home, store: r.store, now: () => NOW, busy: () => false }, "pi").map((x) => x.account), ["pi/dev"]);
  assert.ok(getAccount(r.store.db, "pi/dev"));
});

test("listAccountsWithServes says whether the owner shares each account, and leaves removed ones out", async () => {
  const { markRemoved, setSharing } = await import("./store.ts");
  const r = rig();
  for (const n of ["a", "b", "c"]) addAccount(r.store.db, { runner: "pi", name: n, kind: "key" }, NOW);
  setSharing(r.store.db, "pi/b", null, NOW);
  markRemoved(r.store.db, "pi/c");
  const list = listAccountsWithServes({ home: r.home, store: r.store, now: () => NOW, busy: () => false });
  assert.deepEqual(list.map((x) => [x.account, x.sharing]), [["pi/a", true], ["pi/b", false]]);
});

test("servedModels: pi from models.json, else from the catalog of its providers; codex and claude from the catalog of their runner", async () => {
  const { servedModels } = await import("./serves.ts");
  const r = rig();
  const cat = [
    { id: "openai", models: [{ id: "gpt-x", price: { input: 1, output: 1 } }, { id: "emb", type: "embedding", price: { input: 1, output: 1 } }] },
    { id: "anthropic", models: [{ id: "claude-y", price: { input: 1, output: 1 } }] },
    { id: "zai", models: [{ id: "glm-z", price: { input: 1, output: 1 } }] },
  ];
  const pi1 = addAccount(r.store.db, { runner: "pi", name: "one", kind: "key" }, NOW);
  writeFileSync(join(r.dir("pi", "one"), "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: "m1" }] } } }));
  const pi2 = addAccount(r.store.db, { runner: "pi", name: "two", kind: "key" }, NOW);
  writeFileSync(join(r.dir("pi", "two"), "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "fake" } }));
  const cx = addAccount(r.store.db, { runner: "codex", name: "c", kind: "login" }, NOW);
  const cl = addAccount(r.store.db, { runner: "claude", name: "t", kind: "token" }, NOW);
  assert.deepEqual(servedModels(r.home, pi1, cat), ["custom/m1"]);
  assert.deepEqual(servedModels(r.home, pi2, cat), ["zai/glm-z"]);
  assert.deepEqual(servedModels(r.home, cx, cat), ["gpt-x"]);
  assert.deepEqual(servedModels(r.home, cl, cat), ["claude-y"]);
});
