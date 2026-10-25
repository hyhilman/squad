// The token store: one SQLite file per project home (`state/squad.db`), written by the squad library
// in whatever process ran the pass. WAL mode, so readers never block the writer. Migrations are
// append-only: a shipped migration is never edited, a change is a new one at the end.
//
// A busy database never loses a pass. squad does not retry: the row goes to a spool file
// (`state/spool/<pid>.jsonl`). `openStore` does not fold it: a caller runs `foldSpool()` to apply it.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Each entry runs once, in order. Never edit a shipped one; add a new one at the end. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE passes (
     id TEXT PRIMARY KEY,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     project TEXT NOT NULL,
     flow TEXT NOT NULL,
     action TEXT NOT NULL,
     task_kind TEXT,
     task_id TEXT,
     session_id TEXT,
     job TEXT,
     runner TEXT NOT NULL,
     account TEXT,
     model TEXT NOT NULL,
     image_digest TEXT,
     cli_version TEXT,
     outcome TEXT,
     fail_kind TEXT,
     fail_code TEXT,
     input INTEGER NOT NULL DEFAULT 0,
     output INTEGER NOT NULL DEFAULT 0,
     cache_read INTEGER NOT NULL DEFAULT 0,
     cache_write INTEGER NOT NULL DEFAULT 0,
     reasoning INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL,
     price_src TEXT,
     left_5h_before REAL,
     left_5h_after REAL,
     left_week_before REAL,
     left_week_after REAL,
     turns INTEGER,
     exit_code INTEGER,
     log_path TEXT
   ) STRICT`,
  `CREATE INDEX passes_started ON passes (started_at)`,
  `CREATE INDEX passes_task ON passes (task_kind, task_id)`,
  `CREATE INDEX passes_account ON passes (account, started_at)`,
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     account TEXT,
     kind TEXT NOT NULL,
     code TEXT,
     pass_id TEXT,
     detail TEXT
   ) STRICT`,
  `CREATE INDEX events_account ON events (account, at)`,
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     runner TEXT NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     owner_email TEXT,
     state TEXT NOT NULL DEFAULT 'active',
     dead_code TEXT,
     dead_at TEXT,
     floor_5h REAL,
     floor_week REAL,
     created_at TEXT NOT NULL
   ) STRICT`,
  `CREATE TABLE health (
     account TEXT PRIMARY KEY,
     cool_until TEXT,
     cool_kind TEXT,
     suspect_since TEXT,
     auth_fails INTEGER NOT NULL DEFAULT 0,
     last_ok_at TEXT,
     last_fail_at TEXT,
     last_fail_kind TEXT,
     last_fail_code TEXT,
     last_used_at TEXT,
     left_5h REAL,
     left_week REAL,
     read_at TEXT
   ) STRICT`,
  // A session is pinned to the account that started it: its transcript may hold that account's provider state.
  `CREATE TABLE sessions (
     id TEXT NOT NULL,
     runner TEXT NOT NULL,
     account TEXT NOT NULL,
     created_at TEXT NOT NULL,
     last_used_at TEXT NOT NULL,
     PRIMARY KEY (runner, id)
   ) STRICT`,
  `ALTER TABLE accounts ADD COLUMN consent_at TEXT`,
  // The seat's own email. Before this, squad set the owner from the login's identity, so for a codex
  // or claude login row the two are the same. pi has no identity: its owner came from --owner.
  `ALTER TABLE accounts ADD COLUMN login_email TEXT`,
  `UPDATE accounts SET login_email = owner_email WHERE kind = 'login' AND runner IN ('codex', 'claude')`,
  // The history of room left, for a chart: the latest value alone is in `health`.
  `CREATE TABLE room_reads (
     id INTEGER PRIMARY KEY,
     account TEXT NOT NULL,
     at TEXT NOT NULL,
     left_5h REAL,
     left_week REAL,
     source TEXT NOT NULL
   ) STRICT`,
  `CREATE INDEX room_reads_account ON room_reads (account, at)`,
  // A conversation is a session with a fixed setup (system, skill, effort, mounts...) and a close
  // reason. It has its own table because \`sessions\` is only a pin, keyed by runner and id; the pin row
  // stays too, so the pass code finds the history folder the same way for both.
  `CREATE TABLE conversations (
     id TEXT PRIMARY KEY,
     runner TEXT NOT NULL,
     account TEXT NOT NULL,
     model TEXT NOT NULL,
     cwd TEXT NOT NULL,
     caller_flow TEXT NOT NULL,
     caller_action TEXT NOT NULL,
     task_kind TEXT,
     task_id TEXT,
     spec TEXT NOT NULL,
     created_at TEXT NOT NULL,
     last_used_at TEXT NOT NULL,
     closed_at TEXT,
     closed_reason TEXT
   ) STRICT`,
  `CREATE INDEX conversations_open ON conversations (closed_at, last_used_at)`,
  // The times the windows reset, with the room left (see room_reads).
  `ALTER TABLE health ADD COLUMN resets_5h TEXT`,
  `ALTER TABLE health ADD COLUMN resets_week TEXT`,
  // Two costs per pass. \`cost_usd\` and \`price_src\` stay as they were: they hold the money cost of a key
  // account and equal \`catalog_cost_usd\` there (null for a seat). New readers use the two columns below.
  `ALTER TABLE passes ADD COLUMN cli_cost_usd REAL`,
  `ALTER TABLE passes ADD COLUMN catalog_cost_usd REAL`,
  // One row each time a model's catalog price is new or changed. A cache price of NULL means the input price.
  `CREATE TABLE price_history (
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     input REAL NOT NULL,
     output REAL NOT NULL,
     cache_read REAL,
     cache_write REAL,
     seen_at TEXT NOT NULL
   ) STRICT`,
  `CREATE INDEX price_history_model ON price_history (provider, model, seen_at)`,
  // Consent now gates the pool: an account with none is refused. Who gave it: an email, `cli`, or
  // `migration` for every account that was in use before the gate, so none of them stops.
  `ALTER TABLE accounts ADD COLUMN consent_by TEXT`,
  `UPDATE accounts SET consent_at = created_at, consent_by = 'migration' WHERE consent_at IS NULL`,
  // The owner's dollar caps on a key account, one per window (5 hours, 7 days, 30 days). NULL = no cap.
  `ALTER TABLE accounts ADD COLUMN cap_5h REAL`,
  `ALTER TABLE accounts ADD COLUMN cap_week REAL`,
  `ALTER TABLE accounts ADD COLUMN cap_30d REAL`,
  // The balance the owner typed from the provider's console, and when (ISO). NULL = none entered.
  // Display only: the pool never reads it.
  `ALTER TABLE accounts ADD COLUMN balance_usd REAL`,
  `ALTER TABLE accounts ADD COLUMN balance_at TEXT`,
  // Project tokens for `squad serve`. Only the sha256 of a token is kept, never the token. A revoked
  // row stays, so a pass or a conversation still names the token it was made with.
  `CREATE TABLE serve_tokens (
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL,
     hash TEXT NOT NULL UNIQUE,
     accounts TEXT NOT NULL,
     roots TEXT NOT NULL,
     images TEXT NOT NULL,
     created_at TEXT NOT NULL,
     last_used_at TEXT,
     revoked_at TEXT
   ) STRICT`,
  `CREATE UNIQUE INDEX serve_tokens_live ON serve_tokens (project) WHERE revoked_at IS NULL`,
];

/** The labels and setup of a pass, written when it starts, so a crashed pass still shows. */
export interface PassStart {
  readonly id: string;
  readonly startedAt: string;
  readonly project: string;
  readonly flow: string;
  readonly action: string;
  readonly taskKind?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly job?: string;
  readonly runner: string;
  readonly account?: string;
  readonly model: string;
  readonly imageDigest?: string;
  readonly cliVersion?: string;
  readonly logPath?: string;
}

/** The token fields, the same four as pi's `usage`, plus reasoning. */
export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

/** What a pass ended with. */
export interface PassEnd {
  readonly id: string;
  readonly endedAt: string;
  readonly outcome: string;
  readonly failKind?: string;
  readonly failCode?: string;
  readonly tokens: Tokens;
  readonly costUsd?: number;
  readonly priceSrc?: string;
  /** What the CLI said the pass cost (pi, claude). */
  readonly cliCostUsd?: number;
  /** Tokens times the catalog price at the pass time. */
  readonly catalogCostUsd?: number;
  readonly left5hBefore?: number;
  readonly left5hAfter?: number;
  readonly leftWeekBefore?: number;
  readonly leftWeekAfter?: number;
  readonly turns?: number;
  readonly exitCode?: number;
  /** The model the stream reported; it replaces the requested one on the row. */
  readonly model?: string;
}

export interface SquadEvent {
  readonly at: string;
  readonly kind: string;
  readonly account?: string;
  readonly code?: string;
  readonly passId?: string;
  readonly detail?: string;
}

type SpoolLine = { readonly op: "start"; readonly row: PassStart } | { readonly op: "end"; readonly row: PassEnd } | { readonly op: "event"; readonly row: SquadEvent };

/** SQLITE_BUSY (5) or one of its extended codes, from node:sqlite's `errcode`. */
export function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 5;
}

const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export interface Store {
  /** Writes the start row, or spools it when the database is busy. Returns where it went. */
  startPass(row: PassStart): "db" | "spool";
  endPass(row: PassEnd): "db" | "spool";
  event(row: SquadEvent): "db" | "spool";
  /** Applies every spool file in order, then removes it. Returns the lines applied. */
  foldSpool(): number;
  readonly db: DatabaseSync;
  close(): void;
}

export interface StoreOptions {
  readonly dbPath: string;
  readonly spoolDir: string;
  /** How long a statement waits on a held write lock before it counts as busy. */
  readonly busyTimeoutMs?: number;
  readonly pid?: number;
}

export function migrate(db: DatabaseSync): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (n INTEGER NOT NULL) STRICT");
  const row = db.prepare("SELECT n FROM schema_version").get() as { n: number } | undefined;
  let n = row?.n ?? 0;
  if (row === undefined) db.prepare("INSERT INTO schema_version (n) VALUES (0)").run();
  if (n > MIGRATIONS.length) throw new Error(`squad.db is at migration ${n}, newer than this squad (${MIGRATIONS.length})`);
  while (n < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[n]!);
      n++;
      db.prepare("UPDATE schema_version SET n = ?").run(n);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return n;
}

export function openStore(opts: StoreOptions): Store {
  mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
  mkdirSync(opts.spoolDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(opts.dbPath);
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 1000))}`);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  const spoolFile = join(opts.spoolDir, `${opts.pid ?? process.pid}.jsonl`);

  const insertStart = db.prepare(
    `INSERT INTO passes (id, started_at, project, flow, action, task_kind, task_id, session_id, job, runner, account, model, image_digest, cli_version, log_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );
  const updateEnd = db.prepare(
    `UPDATE passes SET ended_at = ?, outcome = ?, fail_kind = ?, fail_code = ?, input = ?, output = ?, cache_read = ?, cache_write = ?, reasoning = ?,
       cost_usd = ?, price_src = ?, cli_cost_usd = ?, catalog_cost_usd = ?, left_5h_before = ?, left_5h_after = ?, left_week_before = ?, left_week_after = ?, turns = ?, exit_code = ?, model = COALESCE(?, model)
     WHERE id = ?`,
  );
  const insertEvent = db.prepare("INSERT INTO events (at, account, kind, code, pass_id, detail) VALUES (?, ?, ?, ?, ?, ?)");

  const apply = (line: SpoolLine): void => {
    if (line.op === "start") {
      const r = line.row;
      insertStart.run(r.id, r.startedAt, r.project, r.flow, r.action, nul(r.taskKind), nul(r.taskId), nul(r.sessionId), nul(r.job), r.runner, nul(r.account), r.model, nul(r.imageDigest), nul(r.cliVersion), nul(r.logPath));
    } else if (line.op === "end") {
      const r = line.row;
      const t = r.tokens;
      updateEnd.run(r.endedAt, r.outcome, nul(r.failKind), nul(r.failCode), t.input, t.output, t.cacheRead, t.cacheWrite, t.reasoning, nul(r.costUsd), nul(r.priceSrc), nul(r.cliCostUsd), nul(r.catalogCostUsd), nul(r.left5hBefore), nul(r.left5hAfter), nul(r.leftWeekBefore), nul(r.leftWeekAfter), nul(r.turns), nul(r.exitCode), nul(r.model), r.id);
    } else {
      const r = line.row;
      insertEvent.run(r.at, nul(r.account), r.kind, nul(r.code), nul(r.passId), nul(r.detail));
    }
  };

  const write = (line: SpoolLine): "db" | "spool" => {
    try {
      apply(line);
      return "db";
    } catch (e) {
      if (!isBusy(e)) throw e;
      appendFileSync(spoolFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      return "spool";
    }
  };

  const foldSpool = (): number => {
    if (!existsSync(opts.spoolDir)) return 0;
    let applied = 0;
    for (const name of readdirSync(opts.spoolDir).sort()) {
      // A `.folding` file is one an earlier fold claimed and did not finish: fold it again.
      // Starts and ends are idempotent; an event may land twice after such a crash.
      const resumed = name.endsWith(".jsonl.folding");
      if (!resumed && !name.endsWith(".jsonl")) continue;
      // Claim the file first, so a writer that spools again starts a new file.
      const base = resumed ? name.slice(0, -".folding".length) : name;
      const claimed = join(opts.spoolDir, `${base}.folding`);
      if (!resumed) renameSync(join(opts.spoolDir, name), claimed);
      const lines = readFileSync(claimed, "utf8").split("\n").filter((l) => l !== "");
      db.exec("BEGIN IMMEDIATE");
      try {
        // A start sorts before its end in the file, since one process wrote both in order.
        for (const l of lines) apply(JSON.parse(l) as SpoolLine);
        db.exec("COMMIT");
      } catch (e) {
        // The claimed file stays as `.folding`; the next fold takes it again. Renaming it back could
        // overwrite a new spool file of the same pid.
        db.exec("ROLLBACK");
        throw e;
      }
      rmSync(claimed);
      applied += lines.length;
    }
    return applied;
  };

  return {
    startPass: (row) => write({ op: "start", row }),
    endPass: (row) => write({ op: "end", row }),
    event: (row) => write({ op: "event", row }),
    foldSpool,
    db,
    close: () => db.close(),
  };
}
