import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "../home.ts";
import { openStore } from "../store/db.ts";
import { lockPathOf } from "../run.ts";
import { ensureLockFile } from "../lock.ts";
import { pinSession } from "../sessions.ts";
import { emptyHealth } from "./health.ts";
import { removeAccount, replacePiKey, replaceToken, revokeNote } from "./care.ts";
import { addAccount, getAccount, getHealth, putHealth, setSharing, setState } from "./store.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const FAKE_TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

function rig() {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "care-")), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const folder = (runner: string, name: string, files: Record<string, string>): string => {
    const d = join(home.accounts, runner, name);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body, { mode: 0o600 });
    return d;
  };
  return { home, store, folder };
}

test("remove: the folder goes, the row stays as removed, open conversations close, and an event is kept", async () => {
  const r = rig();
  addAccount(r.store.db, { runner: "pi", name: "k", kind: "key", ownerEmail: "o@x.test" }, NOW);
  const dir = r.folder("pi", "k", { "auth.json": '{"fake":{"type":"api_key","key":"not-real"}}' });
  r.store.db.prepare("INSERT INTO conversations (id, runner, account, model, cwd, caller_flow, caller_action, spec, created_at, last_used_at) VALUES ('c1', 'pi', 'pi/k', 'm', '/w', 'f', 'a', '{}', ?, ?)").run(NOW.toISOString(), NOW.toISOString());
  pinSession(r.store.db, "pi", "c1", "pi/k", NOW);
  assert.equal(await removeAccount(r.store, r.home, getAccount(r.store.db, "pi/k")!, NOW), "removed");
  assert.equal(existsSync(dir), false);
  assert.equal(getAccount(r.store.db, "pi/k")!.state, "removed");
  const conv = r.store.db.prepare("SELECT closed_reason FROM conversations WHERE id = 'c1'").get() as { closed_reason: string };
  assert.equal(conv.closed_reason, "removed");
  const ev = r.store.db.prepare("SELECT kind FROM events WHERE account = 'pi/k'").all() as { kind: string }[];
  assert.ok(ev.some((e) => e.kind === "removed"));
});

test("remove: a login whose lock a pass holds is busy, and nothing changes", async () => {
  const r = rig();
  const a = addAccount(r.store.db, { runner: "codex", name: "l", kind: "login" }, NOW);
  const dir = r.folder("codex", "l", { "auth.json": "{}" });
  const lock = lockPathOf(r.home, a);
  ensureLockFile(lock);
  // A pass in a container holds the same file with flock; a child does the same here.
  const holder = spawn("flock", [lock, "sh", "-c", "echo held; read x"], { stdio: ["pipe", "pipe", "ignore"] });
  await new Promise<void>((done) => holder.stdout.once("data", () => done()));
  try {
    assert.equal(await removeAccount(r.store, r.home, a, NOW), "busy");
    assert.equal(existsSync(dir), true);
    assert.equal(getAccount(r.store.db, "codex/l")!.state, "active");
  } finally {
    holder.stdin.end();
  }
});

test("the revoke note names the provider page for each kind; text only", () => {
  assert.match(revokeNote({ runner: "codex", kind: "login" }), /ChatGPT/);
  assert.match(revokeNote({ runner: "claude", kind: "token" }), /claude\.ai/);
  assert.match(revokeNote({ runner: "claude", kind: "login" }), /claude\.ai/);
  assert.match(revokeNote({ runner: "pi", kind: "key" }), /API keys page/);
  for (const t of [revokeNote({ runner: "codex", kind: "login" }), revokeNote({ runner: "claude", kind: "token" }), revokeNote({ runner: "pi", kind: "key" })]) assert.doesNotMatch(t, /https?:/);
});

test("replaceToken: a new token file (0600, tmp + rename), health and a dead state cleared, consent by the owner now", () => {
  const r = rig();
  addAccount(r.store.db, { runner: "claude", name: "t", kind: "token", ownerEmail: "o@x.test" }, NOW);
  r.folder("claude", "t", { token: "sk-ant-oat01-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLD" });
  setState(r.store.db, "claude/t", "dead", "token_revoked", NOW);
  putHealth(r.store.db, { ...emptyHealth("claude/t"), suspectSince: NOW.toISOString(), authFails: 2, lastFailCode: "401", lastFailKind: "auth" });
  setSharing(r.store.db, "claude/t", null, NOW);
  const later = new Date(NOW.getTime() + 5000);
  replaceToken(r.store, r.home, getAccount(r.store.db, "claude/t")!, FAKE_TOKEN, "o@x.test", later, null);
  const file = join(r.home.accounts, "claude", "t", "token");
  assert.equal(readFileSync(file, "utf8"), FAKE_TOKEN);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const a = getAccount(r.store.db, "claude/t")!;
  assert.deepEqual([a.state, a.deadCode, a.consentAt, a.consentBy], ["active", null, later.toISOString(), "o@x.test"]);
  const h = getHealth(r.store.db, "claude/t");
  assert.deepEqual([h.suspectSince, h.authFails, h.lastFailCode], [null, 0, null]);
});

test("replacePiKey: keeps the other providers' keys, needs a provider when the file has several, refuses one it does not have", () => {
  const r = rig();
  addAccount(r.store.db, { runner: "pi", name: "one", kind: "key", ownerEmail: "o@x.test" }, NOW);
  addAccount(r.store.db, { runner: "pi", name: "two", kind: "key", ownerEmail: "o@x.test" }, NOW);
  r.folder("pi", "one", { "auth.json": JSON.stringify({ zai: { type: "api_key", key: "old-fake" } }) });
  r.folder("pi", "two", { "auth.json": JSON.stringify({ zai: { type: "api_key", key: "a-fake" }, groq: { type: "api_key", key: "b-fake" } }), "models.json": "{}" });
  const one = getAccount(r.store.db, "pi/one")!;
  const two = getAccount(r.store.db, "pi/two")!;
  assert.equal(replacePiKey(r.store, r.home, one, undefined, "new-fake", "o@x.test", NOW), "ok");
  assert.deepEqual(JSON.parse(readFileSync(join(r.home.accounts, "pi", "one", "auth.json"), "utf8")), { zai: { type: "api_key", key: "new-fake" } });
  assert.equal(replacePiKey(r.store, r.home, two, undefined, "new-fake", "o@x.test", NOW), "pick-provider");
  assert.equal(replacePiKey(r.store, r.home, two, "openai", "new-fake", "o@x.test", NOW), "unknown-provider");
  assert.equal(replacePiKey(r.store, r.home, two, "groq", "new-fake", "o@x.test", NOW), "ok");
  assert.deepEqual(JSON.parse(readFileSync(join(r.home.accounts, "pi", "two", "auth.json"), "utf8")), { zai: { type: "api_key", key: "a-fake" }, groq: { type: "api_key", key: "new-fake" } });
  assert.equal(readFileSync(join(r.home.accounts, "pi", "two", "models.json"), "utf8"), "{}", "models.json stays");
});
