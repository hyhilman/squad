// Conversations: many turns on one account, each turn one pass. A conversation is tied to the
// account it was opened on and never moves, because its history folder may hold that account's
// provider state. pi only in this release: codex and claude keep history inside the login folder.
//
// `open` writes a row and starts nothing. `send` is `runPass` with the account fixed, so the lock,
// the health update and the pass row are the ones every pass has. `close` deletes the history.

import { rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getAccount, healthOf, getHealth } from "./accounts/store.ts";
import { checkCallerMounts } from "./docker.ts";
import type { HomeLayout } from "./home.ts";
import { ulid } from "./ids.ts";
import { runPass, type PassRequest, type RunDeps } from "./run.ts";
import { deleteSession, getSession, pinSession, sessionDir } from "./sessions.ts";
import { envOptional, SQUAD_DOCKER_ENV } from "./settings.ts";
import { isSupported } from "./runners/table.ts";
import { checkContainerName, checkEffort, checkImage, checkLabels, dockerInspectImage, loadSkill, type ExtraMount, type SkillRef, type TurnOptions } from "./turn.ts";
import type { Failure, Usage } from "./types.ts";

export interface OpenRequest extends Omit<TurnOptions, "onOutput"> {
  readonly runner: string;
  /** `pi/alice` or `alice`. */
  readonly account: string;
  readonly model: string;
  readonly cwd: string;
  /** The main repo's .git; default `<cwd>/.git`. */
  readonly gitDir?: string;
  readonly caller: { readonly flow: string; readonly action: string };
  readonly task?: { readonly kind: string; readonly id: string };
  readonly env?: Readonly<Record<string, string>>;
}

export interface Conversation {
  readonly id: string;
  readonly runner: string;
  /** `<runner>/<name>`. */
  readonly account: string;
  readonly model: string;
  readonly cwd: string;
  readonly createdAt: string;
}

export interface SendOptions {
  readonly onOutput?: (chunk: string) => void;
  /** Called right after the turn's pass row is written (see PassRequest.onStart). */
  readonly onStart?: (passId: string, container: string | null) => void;
  readonly idleMs?: number;
  readonly deadlineMs?: number;
}

export type ClosedReason = "first-turn-refused";

export interface TurnResult {
  readonly passId: string;
  readonly account: string;
  readonly text: string;
  readonly texts: readonly string[];
  readonly turns: number;
  readonly model: string | null;
  readonly usage: Usage;
  readonly failure?: Failure;
  /** Set when this turn ended the conversation: the tie is gone, so the caller can open again on another account. */
  readonly closed?: ClosedReason;
}

/** The fixed setup, stored as JSON. Everything here is the same on every turn, so the prompt cache hits. */
interface Spec {
  system?: string;
  skill?: SkillRef;
  effort?: string;
  mounts?: ExtraMount[];
  image?: string;
  container?: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
  gitDir?: string;
}

interface Raw {
  id: string; runner: string; account: string; model: string; cwd: string; caller_flow: string; caller_action: string;
  task_kind: string | null; task_id: string | null; spec: string; created_at: string; last_used_at: string; closed_at: string | null; closed_reason: string | null;
}

const rawOf = (db: DatabaseSync, id: string): Raw | undefined => db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Raw | undefined;
const handleOf = (r: Raw): Conversation => ({ id: r.id, runner: r.runner, account: r.account, model: r.model, cwd: r.cwd, createdAt: r.created_at });

export function open(req: OpenRequest, deps: RunDeps): Conversation {
  if (!isSupported(req.runner)) throw new Error(`runner ${req.runner} is not supported yet`);
  if (req.runner !== "pi") throw new Error(`${req.runner} conversations are not supported yet; only pi can`);
  const docker = deps.docker ?? envOptional(SQUAD_DOCKER_ENV, deps.env) ?? "docker";
  // The same checks a pass makes, before any row is written.
  if (req.skill !== undefined) loadSkill(req.skill);
  if (req.effort !== undefined) checkEffort(req.runner, req.effort);
  if (req.labels !== undefined) checkLabels(req.labels);
  if (req.container !== undefined) checkContainerName(req.container);
  if (req.mounts !== undefined) checkCallerMounts(req.mounts, deps.home.root);
  if (req.image !== undefined) checkImage(req.image, req.runner, deps.inspectImage ?? ((i) => dockerInspectImage(docker, i)));
  const now = (deps.now ?? (() => new Date()))();
  const id = req.account.includes("/") ? req.account : `${req.runner}/${req.account}`;
  const account = getAccount(deps.store.db, id);
  if (account === undefined || account.runner !== req.runner) throw new Error(`unknown ${req.runner} account ${id}`);
  // The lock is not taken here: busy is a fact of each turn. State is checked, so a caller learns early.
  const state = healthOf(account, getHealth(deps.store.db, id), now);
  if (state === "dead" || state === "disabled" || state === "moved") throw new Error(`${id} is ${state}: it cannot hold a conversation`);

  const spec: Spec = {
    ...(req.system === undefined ? {} : { system: req.system }),
    ...(req.skill === undefined ? {} : { skill: { name: req.skill.name, dir: req.skill.dir } }),
    ...(req.effort === undefined ? {} : { effort: req.effort }),
    ...(req.mounts === undefined ? {} : { mounts: req.mounts.map((m) => ({ host: m.host, container: m.container, ro: m.ro })) }),
    ...(req.image === undefined ? {} : { image: req.image }),
    ...(req.container === undefined ? {} : { container: req.container }),
    ...(req.labels === undefined ? {} : { labels: { ...req.labels } }),
    ...(req.env === undefined ? {} : { env: { ...req.env } }),
    ...(req.gitDir === undefined ? {} : { gitDir: req.gitDir }),
  };
  // Lower case, so the id is also a valid session id (the history folder name).
  const convId = ulid(now.getTime()).toLowerCase();
  const t = now.toISOString();
  const db = deps.store.db;
  db.prepare("INSERT INTO conversations (id, runner, account, model, cwd, caller_flow, caller_action, task_kind, task_id, spec, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(convId, req.runner, id, req.model, req.cwd, req.caller.flow, req.caller.action, req.task?.kind ?? null, req.task?.id ?? null, JSON.stringify(spec), t, t);
  pinSession(db, req.runner, convId, id, now);
  return handleOf(rawOf(db, convId)!);
}

/** True for a first turn that the provider refused before it spent a token: nothing is lost by dropping the tie. */
export function firstTurnRefused(failure: Failure | undefined, usage: Usage, earlierTokens: boolean): boolean {
  if (failure === undefined || earlierTokens) return false;
  if (failure.kind !== "quota" && failure.kind !== "rate-limit" && failure.kind !== "auth") return false;
  return Object.values(usage).every((n) => n === 0);
}

export async function send(conv: Conversation | string, message: string, opts: SendOptions, deps: RunDeps): Promise<TurnResult> {
  const db = deps.store.db;
  const id = typeof conv === "string" ? conv : conv.id;
  const row = rawOf(db, id);
  if (row === undefined) throw new Error(`unknown conversation ${id}`);
  if (row.closed_at !== null) throw new Error(`conversation ${id} is closed`);
  const spec = JSON.parse(row.spec) as Spec;
  const now = deps.now ?? (() => new Date());
  // A lost pin row must not let a pass start a fresh, empty history: put it back on the same account.
  if (getSession(db, row.runner, id) === undefined) pinSession(db, row.runner, id, row.account, now());

  // A turn that spent tokens put the opened skill into the history; later turns must not open it again.
  const skillInHistory = db.prepare("SELECT 1 FROM passes WHERE session_id = ? AND (input + output + cache_read + cache_write + reasoning) > 0 LIMIT 1").get(id) !== undefined;

  const res = await runPass({
    runner: row.runner as PassRequest["runner"],
    model: row.model,
    prompt: message,
    account: row.account,
    cwd: row.cwd,
    caller: { flow: row.caller_flow, action: row.caller_action },
    ...(row.task_kind === null || row.task_id === null ? {} : { task: { kind: row.task_kind, id: row.task_id } }),
    session: id,
    conversation: true,
    ...(spec.system === undefined ? {} : { system: spec.system }),
    ...(spec.skill === undefined ? {} : { skill: spec.skill }),
    ...(skillInHistory ? { openSkill: false } : {}),
    ...(spec.effort === undefined ? {} : { effort: spec.effort as PassRequest["effort"] }),
    ...(spec.mounts === undefined ? {} : { mounts: spec.mounts }),
    ...(spec.image === undefined ? {} : { image: spec.image }),
    ...(spec.container === undefined ? {} : { container: spec.container }),
    ...(spec.labels === undefined ? {} : { labels: spec.labels }),
    ...(spec.env === undefined ? {} : { env: spec.env }),
    ...(spec.gitDir === undefined ? {} : { gitDir: spec.gitDir }),
    ...(opts.onOutput === undefined ? {} : { onOutput: opts.onOutput }),
    ...(opts.onStart === undefined ? {} : { onStart: opts.onStart }),
    ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
    ...(opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
  }, deps);

  const ran = res.failure?.kind !== "busy" && res.failure?.kind !== "no-account";
  if (ran) db.prepare("UPDATE conversations SET last_used_at = ? WHERE id = ?").run(now().toISOString(), id);
  let closed: ClosedReason | undefined;
  if (ran && res.failure !== undefined) {
    const earlier = db.prepare("SELECT 1 FROM passes WHERE session_id = ? AND id <> ? AND (input + output + cache_read + cache_write + reasoning) > 0 LIMIT 1").get(id, res.passId) !== undefined;
    if (firstTurnRefused(res.failure, res.usage, earlier)) {
      closeRow(db, deps.home, row, "first-turn-refused", now());
      closed = "first-turn-refused";
    }
  }
  return {
    passId: res.passId,
    account: row.account,
    text: res.text,
    texts: res.texts,
    turns: res.turns,
    model: res.model,
    usage: res.usage,
    ...(res.failure === undefined ? {} : { failure: res.failure }),
    ...(closed === undefined ? {} : { closed }),
  };
}

/** Deletes the history folder, drops the pin and marks the row. A second call changes nothing. */
function closeRow(db: DatabaseSync, home: HomeLayout, row: Raw, reason: string, now: Date): void {
  if (row.closed_at !== null) return;
  // The id is a checked session id, so this path is always one history folder under sessions/.
  rmSync(sessionDir(home, row.runner, row.account, row.id), { recursive: true, force: true });
  deleteSession(db, row.runner, row.id);
  db.prepare("UPDATE conversations SET closed_at = ?, closed_reason = ? WHERE id = ? AND closed_at IS NULL").run(now.toISOString(), reason, row.id);
}

export function close(conv: Conversation | string, deps: RunDeps): void {
  const id = typeof conv === "string" ? conv : conv.id;
  const row = rawOf(deps.store.db, id);
  if (row === undefined) throw new Error(`unknown conversation ${id}`);
  closeRow(deps.store.db, deps.home, row, "closed", (deps.now ?? (() => new Date()))());
}

/** For `squad gc`: closes one conversation as idle. */
export function closeIdle(db: DatabaseSync, home: HomeLayout, id: string, now: Date): void {
  const row = rawOf(db, id);
  if (row !== undefined) closeRow(db, home, row, "idle", now);
}

export interface OpenConversation {
  readonly id: string;
  readonly lastUsedAt: string;
}

/** Closes every open conversation on one account (it was removed). */
export function closeForAccount(db: DatabaseSync, home: HomeLayout, account: string, now: Date): void {
  for (const row of db.prepare("SELECT * FROM conversations WHERE account = ? AND closed_at IS NULL").all(account) as unknown as Raw[]) closeRow(db, home, row, "removed", now);
}

/** The open conversations, for gc. */
export function listOpenConversations(db: DatabaseSync): OpenConversation[] {
  return (db.prepare("SELECT id, last_used_at FROM conversations WHERE closed_at IS NULL ORDER BY id").all() as { id: string; last_used_at: string }[]).map((r) => ({ id: r.id, lastUsedAt: r.last_used_at }));
}
