// `squad gc`: a pure planner and a thin executor. `planGc` turns a snapshot of the world (containers,
// pass rows, files, sessions) into a list of actions. It reads and writes nothing, so `--dry-run`
// is just "print the list". The executor does the list; running gc twice plans nothing the second time.
//
// Hard rule: gc never removes anything under `accounts/` or `locks/`. The planner drops any path that
// is not strictly inside a folder gc owns, and the executor checks again before it deletes.

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { dockerPsArgv, dockerRmArgv, dockerStopArgv, stopGraceS } from "./docker.ts";
import type { HomeLayout } from "./home.ts";
import type { Log } from "./log.ts";
import { DEFAULT_DEADLINE_MS } from "./run.ts";
import { SQUAD_CONVERSATION_IDLE_D_ENV, SQUAD_KEEP_LOGS_D_ENV, SQUAD_KEEP_PASSES_D_ENV, SQUAD_SESSION_TTL_D_ENV, envNum } from "./settings.ts";
import { closeIdle, listOpenConversations, type OpenConversation } from "./conversations.ts";
import { listSessions, deleteSession, sessionDir } from "./sessions.ts";
import { NO_TOKENS, type Store } from "./store/db.ts";

export interface GcContainer {
  readonly name: string;
  /** The `squad.pass` label. "" = no label: gc never touches such a container. */
  readonly passId: string;
  readonly state: string;
  /** null = the daemon's date did not parse; the age is then unknown. */
  readonly createdAt: Date | null;
  /** The `squad.purpose` label. "" = none (an older squad build): treated as "pass". */
  readonly purpose: string;
}
export interface GcPass {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** The conversation or session the pass belongs to. */
  readonly sessionId?: string | null;
}
export interface GcFile {
  readonly path: string;
  readonly mtime: Date;
}
export interface GcSession {
  readonly runner: string;
  readonly id: string;
  readonly account: string;
  readonly lastUsedAt: string;
}
export interface GcState {
  readonly home: HomeLayout;
  /** null = docker could not be asked. Then nothing about containers, open passes or staging is planned. */
  readonly containers: readonly GcContainer[] | null;
  readonly passes: readonly GcPass[];
  /** The top-level entries of `staging/`. */
  readonly staging: readonly GcFile[];
  /** Pass logs and usage export files. */
  readonly logs: readonly GcFile[];
  readonly sessions: readonly GcSession[];
  /** Every `sessions/<runner>/<account name>/<id>` folder on disk, with or without a row. */
  readonly sessionDirs: readonly GcFile[];
  /** The open conversations. A conversation also has a row in `sessions`; this list is what tells them apart. */
  readonly conversations?: readonly OpenConversation[];
}
export interface GcSettings {
  readonly graceS: number;
  readonly keepPassesD: number;
  readonly keepLogsD: number;
  readonly sessionTtlD: number;
  readonly conversationIdleD?: number;
  readonly deadlineMs: number;
}

export type GcAction =
  | { readonly kind: "stop-container"; readonly name: string; readonly graceS: number }
  | { readonly kind: "remove-container"; readonly name: string; readonly force: boolean }
  | { readonly kind: "end-pass"; readonly id: string }
  | { readonly kind: "delete-pass"; readonly id: string }
  | { readonly kind: "remove-path"; readonly path: string }
  | { readonly kind: "delete-session"; readonly runner: string; readonly id: string }
  | { readonly kind: "close-conversation"; readonly id: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const LIVE = new Set(["running", "paused", "restarting"]);
const DEAD = new Set(["exited", "created", "dead"]);

export function gcSettings(env?: Readonly<Record<string, string | undefined>>): GcSettings {
  return {
    graceS: stopGraceS(env),
    keepPassesD: envNum(SQUAD_KEEP_PASSES_D_ENV, env),
    keepLogsD: envNum(SQUAD_KEEP_LOGS_D_ENV, env),
    sessionTtlD: envNum(SQUAD_SESSION_TTL_D_ENV, env),
    conversationIdleD: envNum(SQUAD_CONVERSATION_IDLE_D_ENV, env),
    deadlineMs: DEFAULT_DEADLINE_MS,
  };
}

/** The pass id inside a key copy name (`<runner>-<name>-<pass id>-<random>`), or null for a name without one. */
export function passOfStaging(name: string): string | null {
  const m = /-([0-9A-HJKMNP-TV-Z]{26})-[A-Za-z0-9]{6}$/.exec(name);
  return m === null ? null : m[1]!;
}

/** The folders gc may delete inside. `accounts/` and `locks/` are not here, and never will be. */
const ownedRoots = (home: HomeLayout): string[] => [home.staging, home.passLogs, home.usageExport, home.sessions].map((p) => resolve(p));

/** True for a path strictly inside a folder gc owns. A path that climbs out with `..` fails. */
export function removable(home: HomeLayout, path: string): boolean {
  const p = resolve(path);
  if ([home.accounts, home.locks].some((g) => p === resolve(g) || p.startsWith(resolve(g) + sep))) return false;
  return ownedRoots(home).some((r) => p.startsWith(r + sep));
}

export function planGc(state: GcState, now: Date, s: GcSettings): GcAction[] {
  const acts: GcAction[] = [];
  const t = now.getTime();
  const olderThan = (d: Date | string | null, ms: number): boolean => {
    const x = d === null ? NaN : typeof d === "string" ? Date.parse(d) : d.getTime();
    return Number.isFinite(x) && t - x > ms;
  };
  const byId = new Map(state.passes.map((p) => [p.id, p]));
  const doomed = new Set(state.passes.filter((p) => olderThan(p.startedAt, s.keepPassesD * DAY_MS)).map((p) => p.id));

  // Containers. The label is the guard: a row without one is skipped, whatever the state.
  const liveIds = new Set<string>();
  let liveLeft = false;
  if (state.containers !== null) {
    for (const c of state.containers) {
      if (c.passId === "") continue;
      const pass = byId.get(c.passId);
      if (LIVE.has(c.state)) {
        // A person sits in a login or shell. It has no pass row, so the deadline rule would kill it.
        if (c.state === "running" && (c.purpose === "login" || c.purpose === "shell")) {
          liveIds.add(c.passId);
          liveLeft = true;
          continue;
        }
        const orphan = c.state === "running" && (pass !== undefined ? pass.endedAt !== null : olderThan(c.createdAt, s.deadlineMs));
        if (orphan) {
          acts.push({ kind: "stop-container", name: c.name, graceS: s.graceS }, { kind: "remove-container", name: c.name, force: true });
        } else {
          liveIds.add(c.passId);
          liveLeft = true;
        }
      } else if (DEAD.has(c.state)) {
        acts.push({ kind: "remove-container", name: c.name, force: false });
      }
    }
    // A pass left open with nothing running for it died with its supervisor.
    for (const p of state.passes) {
      if (p.endedAt === null && !doomed.has(p.id) && !liveIds.has(p.id) && olderThan(p.startedAt, HOUR_MS)) acts.push({ kind: "end-pass", id: p.id });
    }
    // A running pass may still read its key copy, so that copy stays. A name that does not tell its
    // pass keeps the old rule: it waits until no pass container is left.
    for (const f of state.staging) {
      if (!olderThan(f.mtime, HOUR_MS)) continue;
      const owner = passOfStaging(basename(f.path));
      if (owner === null ? !liveLeft : !liveIds.has(owner)) acts.push({ kind: "remove-path", path: f.path });
    }
    // A new session whose account lost the lock race leaves a folder and no row. A pass that runs
    // always has a row, so a folder with none is dead once it is older than a pass may run.
    const rowDirs = new Set(state.sessions.map((x) => resolve(sessionDir(state.home, x.runner, x.account, x.id))));
    for (const d of state.sessionDirs) if (!rowDirs.has(resolve(d.path)) && olderThan(d.mtime, Math.max(HOUR_MS, s.deadlineMs))) acts.push({ kind: "remove-path", path: d.path });
  }

  for (const p of state.passes) if (doomed.has(p.id)) acts.push({ kind: "delete-pass", id: p.id });
  for (const f of state.logs) if (olderThan(f.mtime, s.keepLogsD * DAY_MS)) acts.push({ kind: "remove-path", path: f.path });
  // Only with a live view of the containers: a turn that runs now must not lose its history.
  const openConvs = new Set((state.conversations ?? []).map((x) => x.id));
  if (state.containers !== null && s.conversationIdleD !== undefined) {
    for (const x of state.conversations ?? []) {
      const running = state.passes.some((q) => q.sessionId === x.id && q.endedAt === null && liveIds.has(q.id));
      if (!running && olderThan(x.lastUsedAt, s.conversationIdleD * DAY_MS)) acts.push({ kind: "close-conversation", id: x.id });
    }
  }
  for (const x of state.sessions) {
    // An open conversation's history is closed by its own rule above.
    if (openConvs.has(x.id)) continue;
    if (!olderThan(x.lastUsedAt, s.sessionTtlD * DAY_MS)) continue;
    const dir = sessionDir(state.home, x.runner, x.account, x.id);
    // A row whose folder would fall outside sessions/ is not touched: it is not ours to judge.
    if (removable(state.home, dir)) acts.push({ kind: "remove-path", path: dir }, { kind: "delete-session", runner: x.runner, id: x.id });
  }
  return acts.filter((a) => a.kind !== "remove-path" || removable(state.home, a.path));
}

/** The text of one action, relative to the home so no host path is printed. */
export function describeAction(a: GcAction, home: HomeLayout, dry: boolean): string {
  const rel = (p: string): string => relative(home.root, p);
  switch (a.kind) {
    case "stop-container": return `${dry ? "would stop" : "stopped"} container ${a.name}`;
    case "remove-container": return `${dry ? "would remove" : "removed"} container ${a.name}`;
    case "end-pass": return `${dry ? "would end" : "ended"} pass ${a.id} as lost`;
    case "delete-pass": return `${dry ? "would delete" : "deleted"} pass ${a.id}`;
    case "remove-path": return `${dry ? "would remove" : "removed"} ${rel(a.path)}`;
    case "delete-session": return `${dry ? "would delete" : "deleted"} session ${a.runner}/${a.id}`;
    case "close-conversation": return `${dry ? "would close" : "closed"} idle conversation ${a.id}`;
  }
}

const CREATED = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.\d+)? ([+-]\d\d)(\d\d)/;

/** The rows of `docker ps` made with `dockerPsArgv`. */
export function parsePs(text: string): GcContainer[] {
  const rows: GcContainer[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [name = "", passId = "", state = "", created = "", purpose = ""] = line.split("\t");
    const m = CREATED.exec(created);
    const at = m === null ? NaN : Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    rows.push({ name, passId, state, createdAt: Number.isFinite(at) ? new Date(at) : null, purpose });
  }
  return rows;
}

export interface GcDeps {
  readonly docker: string;
  readonly store: Store;
  readonly home: HomeLayout;
  readonly now: () => Date;
  readonly log?: Log;
  /** Fold the spool first. A dry run leaves it alone. Default true. */
  readonly fold?: boolean;
}

function filesIn(dir: string): GcFile[] {
  const out: GcFile[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const path = join(dir, n);
    const st = lstatSync(path);
    if (st.isDirectory()) out.push(...filesIn(path));
    else out.push({ path, mtime: st.mtime });
  }
  return out;
}

/** The names of the real folders (not links) directly inside `dir`; none when it does not exist. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => lstatSync(join(dir, n)).isDirectory());
  } catch {
    return [];
  }
}

/** Reads the world. It runs `docker ps` (read-only) and folds the spool, and changes nothing else. */
export function gatherGcState(deps: GcDeps): GcState {
  const { store, home } = deps;
  // The spool holds rows a busy database refused; fold them first, so the plan sees every pass.
  if (deps.fold !== false) store.foldSpool();
  let containers: GcContainer[] | null;
  try {
    containers = parsePs(execFileSync(deps.docker, dockerPsArgv(), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }));
  } catch {
    containers = null;
  }
  const passes = (store.db.prepare("SELECT id, started_at, ended_at, session_id FROM passes").all() as { id: string; started_at: string; ended_at: string | null; session_id: string | null }[]).map((r) => ({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at, sessionId: r.session_id }));
  let staging: GcFile[] = [];
  try {
    staging = readdirSync(home.staging).map((n) => ({ path: join(home.staging, n), mtime: lstatSync(join(home.staging, n)).mtime }));
  } catch {
    // no staging folder yet
  }
  const sessionDirs: GcFile[] = [];
  for (const runner of subdirs(home.sessions)) {
    for (const account of subdirs(join(home.sessions, runner))) {
      for (const id of subdirs(join(home.sessions, runner, account))) {
        const path = join(home.sessions, runner, account, id);
        sessionDirs.push({ path, mtime: lstatSync(path).mtime });
      }
    }
  }
  const sessions = listSessions(store.db).map((x) => ({ runner: x.runner, id: x.id, account: x.account, lastUsedAt: x.lastUsedAt }));
  return { home, containers, passes, staging, logs: [...filesIn(home.passLogs), ...filesIn(home.usageExport)], sessions, sessionDirs, conversations: listOpenConversations(store.db) };
}

export interface GcResult {
  readonly done: GcAction[];
  readonly failed: { readonly action: GcAction; readonly why: string }[];
}

/** Does the actions in order. One that fails is reported and the rest still run: the next gc plans it again. */
export function executeGc(actions: readonly GcAction[], deps: GcDeps): GcResult {
  const { store, home } = deps;
  const done: GcAction[] = [];
  const failed: { action: GcAction; why: string }[] = [];
  const docker = (argv: string[], timeoutMs: number): void => void execFileSync(deps.docker, argv, { stdio: "ignore", timeout: timeoutMs });
  for (const a of actions) {
    try {
      switch (a.kind) {
        case "stop-container":
          docker(dockerStopArgv(a.name, a.graceS), (a.graceS + 15) * 1000);
          break;
        case "remove-container":
          docker(dockerRmArgv(a.name, a.force), 30_000);
          break;
        case "end-pass":
          store.endPass({ id: a.id, endedAt: deps.now().toISOString(), outcome: "lost", tokens: NO_TOKENS });
          break;
        case "delete-pass":
          store.db.prepare("DELETE FROM passes WHERE id = ?").run(a.id);
          break;
        case "remove-path": {
          if (!removable(home, a.path)) throw new Error("not a path gc owns");
          rmSync(a.path, { recursive: true, force: true });
          // A day folder of logs goes with its last file.
          const parent = dirname(a.path);
          if (resolve(parent).startsWith(resolve(home.passLogs) + sep)) {
            try {
              rmdirSync(parent);
            } catch {
              // not empty: other logs are still there
            }
          }
          break;
        }
        case "delete-session":
          deleteSession(store.db, a.runner, a.id);
          break;
        case "close-conversation":
          closeIdle(store.db, home, a.id, deps.now());
          break;
      }
      done.push(a);
    } catch (e) {
      const why = e instanceof Error ? e.message.split("\n")[0]! : "failed";
      deps.log?.warn("gc-action-failed", { action: a.kind, why });
      failed.push({ action: a, why });
    }
  }
  return { done, failed };
}
