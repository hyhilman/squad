import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { call, type PassResult, type TurnResult } from "@squad/contract";
import { nodeSocketFetch } from "@squad/contract/node";
import { makeFakeDocker, type FakeDocker } from "../../test/fake-docker.ts";
import { addAccount } from "../accounts/store.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { makeLog } from "../log.ts";
import { openStore, type Store } from "../store/db.ts";
import { startServe } from "./server.ts";
import { addToken } from "./tokens.ts";

const NOW = new Date("2026-10-25T10:00:00.000Z");
const ME = { uid: process.getuid!(), gid: process.getgid!() };
const BASE = "http://squad";

/** A home where serve died while one pass of the given kind ran in `squad-p1`. */
function crashed(kind: "pass" | "turn" = "pass") {
  const root = mkdtempSync(join(tmpdir(), "rec-"));
  const home = layoutOf(join(root, "home"), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  addAccount(store.db, { runner: "pi", name: "one", kind: "key" }, NOW);
  mkdirSync(join(home.accounts, "pi", "one"), { recursive: true });
  writeFileSync(join(home.accounts, "pi", "one", "auth.json"), '{"fake":"not-a-real-key"}');
  mkdirSync(join(root, "work"));
  const { token, row } = addToken(store.db, "dg-test", { accounts: ["pi/one"], roots: [join(root, "work")], images: [] }, NOW);
  const passId = "01JZZZZZZZZZZZZZZZZZZZZZP1";
  store.startPass({ id: passId, startedAt: NOW.toISOString(), project: "dg-test", flow: "fix", action: "fix:pi", runner: "pi", model: "m", account: "pi/one" });
  store.servePass({ id: passId, tokenId: row.id, kind, passId, container: "squad-p1", runner: "pi", account: "pi/one", startedAt: NOW.toISOString() });
  const fake = makeFakeDocker(join(root, "bin"));
  return { root, home, store, token, passId, fake };
}

async function serveOn(t: TestContext, c: ReturnType<typeof crashed>, fake: FakeDocker, store: Store) {
  const sock = join(c.root, "s.sock");
  const logs: string[] = [];
  const serve = await startServe({ env: { SQUAD_DOCKER: fake.path, SQUAD_STOP_GRACE_S: "1", SQUAD_SERVE_DRAIN_S: "0.2" }, home: c.home, store, socket: sock, log: makeLog((l) => logs.push(l)), user: ME });
  t.after(async () => {
    await serve.stop();
    store.close();
  });
  const f = nodeSocketFetch(sock);
  const status = () => call(f, BASE, "passStatus", { params: { passId: c.passId } }, { headers: { authorization: `Bearer ${c.token}` } });
  return { serve, status, logs };
}

const passRow = (s: Store, id: string) => ({ ...(s.db.prepare("SELECT ended_at, outcome, fail_kind, fail_code FROM passes WHERE id = ?").get(id) as object) }) as { ended_at: string | null; outcome: string | null; fail_kind: string | null; fail_code: string | null };

test("a running row whose container is gone ends as lost: failure {provider, lost}, in GET and in the pass row", async (t) => {
  const c = crashed();
  c.fake.setPs();
  const { status } = await serveOn(t, c, c.fake, c.store);
  const s = await status();
  assert.equal(s.running, false);
  if (s.running) return;
  const r = s.result as PassResult;
  assert.equal(r.passId, c.passId);
  assert.equal(r.account, "pi/one");
  assert.equal(r.failure?.kind, "provider");
  assert.equal(r.failure?.code, "lost");
  assert.equal(r.logPath, null);
  const row = passRow(c.store, c.passId);
  assert.ok(row.ended_at !== null);
  assert.deepEqual([row.fail_kind, row.fail_code], ["provider", "lost"]);
});

test("a lost turn is a TurnResult, with no logPath", async (t) => {
  const c = crashed("turn");
  c.fake.setPs();
  const { status } = await serveOn(t, c, c.fake, c.store);
  const s = await status();
  assert.equal(s.running, false);
  if (s.running) return;
  const r = s.result as TurnResult;
  assert.equal(r.failure?.code, "lost");
  assert.ok(!("logPath" in r));
});

test("when docker ps itself fails (daemon down), the row stays running: never lost", async (t) => {
  const c = crashed();
  c.fake.setPsFail(true);
  const { status, logs } = await serveOn(t, c, c.fake, c.store);
  const s = await status();
  assert.equal(s.running, true);
  if (s.running) assert.equal(s.passId, c.passId);
  assert.equal(passRow(c.store, c.passId).ended_at, null);
  assert.equal(c.store.db.prepare("SELECT ended_at FROM serve_passes WHERE id = ?").get(c.passId)!.ended_at, null);
  assert.ok(logs.some((l) => l.includes("event=serve-recover-unknown")));
});

test("a container still alive is watched: its stream is read to the end and recorded as the result", async (t) => {
  const c = crashed();
  c.fake.setPs(["squad-p1", c.passId, "running", "2026-10-25 10:00:00 +0000 UTC"]);
  c.fake.setLogs("ok.jsonl");
  const { status } = await serveOn(t, c, c.fake, c.store);
  const end = Date.now() + 5000;
  let s = await status();
  while (s.running && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    s = await status();
  }
  assert.equal(s.running, false);
  if (s.running) return;
  const r = s.result as PassResult;
  assert.equal(r.failure, undefined);
  assert.ok(r.text.length > 0);
  assert.ok(r.usage.input > 0);
  assert.deepEqual(c.fake.callsOf("logs")[0], ["logs", "-f", "squad-p1"]);
  assert.deepEqual(c.fake.callsOf("wait")[0], ["wait", "squad-p1"]);
  const row = passRow(c.store, c.passId);
  assert.equal(row.outcome, "ok");
});

test("a row that has ended is left alone", async (t) => {
  const c = crashed();
  c.store.servePass({ id: c.passId, tokenId: "x", kind: "pass", passId: c.passId, container: "squad-p1", runner: "pi", account: "pi/one", startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), result: "{}" });
  c.fake.setPs();
  await serveOn(t, c, c.fake, c.store);
  assert.deepEqual(c.fake.callsOf("ps"), []);
  assert.equal(passRow(c.store, c.passId).ended_at, null, "the pass row is not touched");
});
