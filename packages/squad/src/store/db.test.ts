import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MIGRATIONS, NO_TOKENS, isBusy, migrate, openStore, type PassStart } from "./db.ts";

const dirs = () => {
  const d = mkdtempSync(join(tmpdir(), "store-"));
  return { dbPath: join(d, "squad.db"), spoolDir: join(d, "spool") };
};

const START: PassStart = { id: "01P", startedAt: "2026-10-24T00:00:00Z", project: "p", flow: "review-bot", action: "review:codex", runner: "codex", account: "codex/a", model: "gpt-test", taskKind: "pr", taskId: "o/r#1" };

test("migrations run once and the version is the list length", () => {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "mig-")), "x.db"));
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.equal(migrate(db), MIGRATIONS.length);
});

test("a database newer than this squad is refused", () => {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "mig-")), "x.db"));
  migrate(db);
  db.prepare("UPDATE schema_version SET n = ?").run(MIGRATIONS.length + 1);
  assert.throws(() => migrate(db), /newer than this squad/);
});

test("a pass is written at start and completed at end", () => {
  const s = openStore(dirs());
  assert.equal(s.startPass(START), "db");
  const row0 = s.db.prepare("SELECT outcome, ended_at FROM passes WHERE id = ?").get("01P") as Record<string, unknown>;
  assert.deepEqual({ ...row0 }, { outcome: null, ended_at: null }, "a crashed pass still shows");
  s.endPass({ id: "01P", endedAt: "2026-10-24T00:01:00Z", outcome: "ok", tokens: { ...NO_TOKENS, input: 10, cacheRead: 90 } });
  const row = s.db.prepare("SELECT outcome, input, cache_read, flow, action, task_id FROM passes WHERE id = ?").get("01P") as Record<string, unknown>;
  assert.deepEqual({ ...row }, { outcome: "ok", input: 10, cache_read: 90, flow: "review-bot", action: "review:codex", task_id: "o/r#1" });
  s.close();
});

test("a busy database spools the row, and the next fold writes it", () => {
  const d = dirs();
  const s = openStore({ ...d, busyTimeoutMs: 0 });
  const other = new DatabaseSync(d.dbPath);
  other.exec("BEGIN IMMEDIATE");
  assert.equal(s.startPass(START), "spool");
  assert.equal(s.event({ at: "2026-10-24T00:00:01Z", kind: "refresh-seen", account: "codex/a" }), "spool");
  other.exec("ROLLBACK");
  other.close();
  assert.equal(s.foldSpool(), 2);
  assert.equal(readdirSync(d.spoolDir).length, 0);
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM passes").get() as { n: number }).n, 1);
  assert.equal(s.foldSpool(), 0);
  s.close();
});

test("a fold left half done is taken again, and starts are not doubled", () => {
  const d = dirs();
  const s = openStore(d);
  writeFileSync(join(d.spoolDir, "77.jsonl.folding"), `${JSON.stringify({ op: "start", row: START })}\n`);
  s.startPass(START);
  assert.equal(s.foldSpool(), 1);
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM passes").get() as { n: number }).n, 1);
  s.close();
});

test("isBusy reads the sqlite code, not the message", () => {
  assert.equal(isBusy({ errcode: 5 }), true);
  assert.equal(isBusy({ errcode: 261 }), true, "SQLITE_BUSY_RECOVERY");
  assert.equal(isBusy(new Error("database is locked")), false);
});

test("the migration count and the table list are pinned", () => {
  assert.equal(MIGRATIONS.length, 31);
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "mig-")), "x.db"));
  migrate(db);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(tables, ["accounts", "conversations", "events", "health", "passes", "price_history", "room_reads", "schema_version", "serve_tokens", "sessions"]);
});

test("migration 11: login_email is set from owner_email for codex and claude login rows only; room_reads exists", () => {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "mig-")), "x.db"));
  db.exec("CREATE TABLE schema_version (n INTEGER NOT NULL) STRICT");
  for (const m of MIGRATIONS.slice(0, 10)) db.exec(m);
  db.prepare("INSERT INTO schema_version (n) VALUES (10)").run();
  const ins = db.prepare("INSERT INTO accounts (id, runner, name, kind, owner_email, created_at) VALUES (?, ?, ?, ?, ?, 't')");
  ins.run("codex/a", "codex", "a", "login", "A@x.test");
  ins.run("claude/c", "claude", "c", "login", "c@x.test");
  ins.run("pi/p", "pi", "p", "login", "p@x.test");
  ins.run("pi/k", "pi", "k", "key", "k@x.test");
  ins.run("codex/n", "codex", "n", "login", null);
  assert.equal(migrate(db), MIGRATIONS.length);
  const rows = db.prepare("SELECT id, login_email FROM accounts ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: "claude/c", login_email: "c@x.test" }, { id: "codex/a", login_email: "A@x.test" }, { id: "codex/n", login_email: null },
    { id: "pi/k", login_email: null }, { id: "pi/p", login_email: null },
  ]);
  db.prepare("INSERT INTO room_reads (account, at, left_5h, left_week, source) VALUES ('codex/a', 't', 1, 2, 'read')").run();
});

test("migrations 23-24: every account that has no consent yet is marked shared by the migration, so nothing in use stops", () => {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "mig-")), "x.db"));
  db.exec("CREATE TABLE schema_version (n INTEGER NOT NULL) STRICT");
  db.prepare("INSERT INTO schema_version (n) VALUES (0)").run();
  for (let i = 0; i < 22; i++) {
    db.exec(MIGRATIONS[i]!);
    db.prepare("UPDATE schema_version SET n = ?").run(i + 1);
  }
  db.prepare("INSERT INTO accounts (id, runner, name, kind, created_at) VALUES ('pi/a', 'pi', 'a', 'key', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO accounts (id, runner, name, kind, created_at, consent_at) VALUES ('pi/b', 'pi', 'b', 'key', '2026-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')").run();
  assert.equal(migrate(db), MIGRATIONS.length);
  const rows = db.prepare("SELECT id, consent_at, consent_by FROM accounts ORDER BY id").all() as { id: string; consent_at: string; consent_by: string | null }[];
  assert.deepEqual(rows.map((r) => [r.id, r.consent_at, r.consent_by]), [["pi/a", "2026-01-01T00:00:00.000Z", "migration"], ["pi/b", "2026-02-02T00:00:00.000Z", null]]);
});

test("migrations 25-27: an account from before has no dollar cap", () => {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "mig-")), "x.db"));
  db.exec("CREATE TABLE schema_version (n INTEGER NOT NULL) STRICT");
  db.prepare("INSERT INTO schema_version (n) VALUES (24)").run();
  for (const m of MIGRATIONS.slice(0, 24)) db.exec(m);
  db.prepare("INSERT INTO accounts (id, runner, name, kind, created_at) VALUES ('pi/a', 'pi', 'a', 'key', '2026-01-01T00:00:00.000Z')").run();
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.deepEqual({ ...(db.prepare("SELECT cap_5h, cap_week, cap_30d FROM accounts").get() as object) }, { cap_5h: null, cap_week: null, cap_30d: null });
});

test("migrations 28-29: an account from before has no entered balance", () => {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "mig-")), "x.db"));
  db.exec("CREATE TABLE schema_version (n INTEGER NOT NULL) STRICT");
  db.prepare("INSERT INTO schema_version (n) VALUES (27)").run();
  for (const m of MIGRATIONS.slice(0, 27)) db.exec(m);
  db.prepare("INSERT INTO accounts (id, runner, name, kind, created_at) VALUES ('pi/a', 'pi', 'a', 'key', '2026-01-01T00:00:00.000Z')").run();
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.deepEqual({ ...(db.prepare("SELECT balance_usd, balance_at FROM accounts").get() as object) }, { balance_usd: null, balance_at: null });
});
