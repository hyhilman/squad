// `squad serve`: provider mode. A local listener for machine callers, on a 0600 unix socket or on
// 127.0.0.1, never the web app's port. It serves exactly the contract's SERVE_ROUTES, with a project
// token as the only proof (`squad token add`).
//
// A pass streams as ndjson: "started" once its row is written, "output" pieces, then one "result".
// The pass belongs to serve, not to the connection: a dropped client never stops it, and its result
// is kept for GET /api/passes/:passId. Every line and every JSON answer passes `findForbidden` first.
import { containerUser } from "../docker-user.ts";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection, createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import {
  HIDDEN, NDJSON, SERVE_ROUTES, findForbidden, maskSecrets, matchPath,
  type Conversation as ApiConversation, type PassResult as ApiPassResult, type PassStatus, type ServeAccountView, type ServeRouteName, type TurnResult as ApiTurnResult,
} from "@squad/contract";
import { getAccount, type AccountRow } from "../accounts/store.ts";
import { close, open, send, type TurnResult } from "../conversations.ts";
import { dockerStopArgv, stopGraceS } from "../docker.ts";
import type { HomeLayout } from "../home.ts";
import { makeLog, type Log } from "../log.ts";
import { failureOf, flockBusy, lockPathOf, runPass, type PassResult, type RunDeps } from "../run.ts";
import { SQUAD_DOCKER_ENV, SQUAD_SERVE_DRAIN_S_ENV, envNum, envOptional } from "../settings.ts";
import { NO_TOKENS, isBusy, type ServePassRow, type Store } from "../store/db.ts";
import type { Failure } from "../types.ts";
import type { ImageInfo } from "../turn.ts";
import { accountView } from "../web/account-view.ts";
import { openBody, passBody, turnBody } from "./body.ts";
import { LOST, containerStates, openServeRows, watchContainer, type OpenServeRow, type Watched } from "./recover.ts";
import { Refusal, scopeSetup, type ScopedSetup } from "./scope.ts";
import { authenticate, type ProjectToken } from "./tokens.ts";

// squad's own result types are the contract's shapes: a change on one side fails the type check here.
const passShape = (r: PassResult): ApiPassResult => r;
const turnShape = (r: TurnResult): ApiTurnResult => r;
void passShape;
void turnShape;

type Env = Readonly<Record<string, string | undefined>>;

export interface ServeOpts {
  readonly env: Env;
  readonly home: HomeLayout;
  readonly store: Store;
  /** A unix socket path. Exactly one of socket and port. */
  readonly socket?: string;
  /** A TCP port on 127.0.0.1 only; 0 picks a free one. */
  readonly port?: number;
  readonly log?: Log;
  readonly now?: () => Date;
  /** The uid and gid passes run as and cwd owners are checked against. Default: this process's. Tests set another. */
  readonly user?: { readonly uid: number; readonly gid: number } | null;
  /** Reads an image's labels and entrypoint; default is `docker image inspect`. Tests inject a fake. */
  readonly inspectImage?: (image: string) => ImageInfo | null;
}

export interface ServeHandle {
  /** `unix:<path>` or `http://127.0.0.1:<port>`. */
  readonly address: string;
  /** Stops accepting, lets running passes finish for the drain time, stops what is left. Safe to call twice. */
  stop(): Promise<void>;
}

/** The longest body: a prompt can be large, but not this large. */
const MAX_BODY = 8 * 1024 * 1024;
const INTERNAL = "internal error";
const NOT_FOUND = (): Refusal => new Refusal(404, "not found");
const STOPPING = (): Refusal => new Refusal(503, "squad serve is stopping");

type AnyResult = PassResult | TurnResult;

/** A pass serve runs now: what GET shows, and what stop must stop. */
interface Live {
  readonly handle: string;
  readonly tokenId: string;
  readonly kind: "pass" | "turn";
  readonly runner: string;
  account: string | null;
  readonly startedAt: string;
  passId: string;
  container: string | null;
}

/** A piece of stdout with every credential masked; undefined when it still looks like one. */
export function safeChunk(chunk: string): string | undefined {
  const m = maskSecrets(chunk);
  return findForbidden({ chunk: m }) === undefined ? m : undefined;
}

/** The result with its texts masked. A result that still fails findForbidden loses its texts. */
export function safeResult<R extends AnyResult>(r: R): R {
  const m: R = { ...r, text: maskSecrets(r.text), texts: r.texts.map(maskSecrets), ...(r.failure === undefined ? {} : { failure: { ...r.failure, message: maskSecrets(r.failure.message) } }) };
  if (findForbidden(m) === undefined) return m;
  return { ...m, text: HIDDEN, texts: [], ...(m.failure === undefined ? {} : { failure: { ...m.failure, message: HIDDEN } }) };
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => (size > MAX_BODY ? reject(new Refusal(413, "body too large")) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => reject(new Refusal(400, "cannot read the body")));
  });

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new Refusal(400, "content-type must be application/json");
  const text = await readBody(req);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Refusal(400, "body is not JSON");
  }
}

/** Waits for the promise, at most `ms`. The timer does not keep the process alive. */
const within = (p: Promise<unknown>, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    p.then(() => {
      clearTimeout(t);
      resolve();
    }, () => {
      clearTimeout(t);
      resolve();
    });
  });

/** A socket file another serve still listens on is refused; one a killed serve left behind is removed. */
async function clearStaleSocket(path: string, what: string): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
  const alive = await new Promise<boolean>((resolve) => {
    const c = createConnection(path);
    c.on("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.on("error", () => resolve(false));
  });
  if (alive) throw new Error(`another squad serve already listens on ${what}`);
  unlinkSync(path);
}

/** Listens on a unix socket that is born owner-only; the chmod after is for a umask that would allow more. */
async function listenOwnerOnly(server: Server | NetServer, path: string): Promise<void> {
  const old = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(old);
  }
  chmodSync(path, 0o600);
}

export async function startServe(o: ServeOpts): Promise<ServeHandle> {
  if ((o.socket === undefined) === (o.port === undefined)) throw new Error("squad serve takes exactly one of a socket and a port");
  const log = o.log ?? makeLog();
  const now = o.now ?? (() => new Date());
  const db = o.store.db;
  const docker = envOptional(SQUAD_DOCKER_ENV, o.env)!;
  const user = o.user !== undefined ? o.user : containerUser(docker);
  const live = new Map<string, Live>();
  /** Every streaming request from its first byte to its result, so stop waits for each one. */
  const work = new Set<Promise<void>>();
  let stopping = false;

  const depsFor = (token: ProjectToken, identity: { name: string; email: string }): RunDeps => ({
    home: o.home, store: o.store, project: token.project, identity, user, env: o.env, log,
    ...(o.now === undefined ? {} : { now: o.now }),
    ...(o.inspectImage === undefined ? {} : { inspectImage: o.inspectImage }),
  });
  const scopeCtx = { home: o.home.root, uid: user?.uid ?? null };

  function sendJson(res: ServerResponse, route: string, status: number, body: unknown): void {
    if (findForbidden(body) !== undefined) {
      log.error("serve_response_refused", { route });
      status = 500;
      body = { error: INTERNAL };
    }
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  /** Writes one ndjson line when the client is still there. A line that fails findForbidden is dropped. */
  function writeLine(res: ServerResponse, line: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    if (findForbidden(line) !== undefined) {
      log.error("serve_line_refused", {});
      return;
    }
    res.write(`${JSON.stringify(line)}\n`);
  }

  const rowOf = (l: Live): ServePassRow => ({ id: l.handle, tokenId: l.tokenId, kind: l.kind, passId: l.passId, container: l.container, runner: l.runner, account: l.account, startedAt: l.startedAt });

  /**
   * Runs one pass or turn and streams it. Nothing is written to the client before the pass row exists:
   * a throw before that is a plain JSON 400. After "started", every failure is a result line.
   */
  async function streamed<R extends AnyResult>(
    res: ServerResponse, route: ServeRouteName, token: ProjectToken, kind: "pass" | "turn", runner: string, account: string | null,
    run: (onStart: (passId: string, container: string | null, account: string | null) => void, onOutput: (chunk: string) => void) => Promise<R>,
    failed: (passId: string, message: string) => R,
  ): Promise<void> {
    let entry: Live | undefined;
    let markStarted!: () => void;
    const startedP = new Promise<void>((r) => (markStarted = r));
    const onStart = (passId: string, container: string | null, picked: string | null): void => {
      if (entry === undefined) {
        entry = { handle: passId, tokenId: token.id, kind, runner, account, startedAt: now().toISOString(), passId, container };
        live.set(passId, entry);
      }
      entry.passId = passId;
      entry.container = container;
      // A pool pass learns its account here, and a busy one moves to the next.
      entry.account = picked ?? account;
      try {
        o.store.servePass(rowOf(entry));
      } catch {
        log.error("serve_row_failed", { pass: passId });
      }
      log.info("serve-pass-start", { pass: passId, project: token.project, kind });
      markStarted();
    };
    const onOutput = (chunk: string): void => {
      if (entry === undefined) return;
      const c = safeChunk(chunk);
      if (c !== undefined) writeLine(res, { type: "output", chunk: c });
    };
    const p = run(onStart, onOutput);
    await Promise.race([startedP, p.then(() => undefined, () => undefined)]);
    if (entry === undefined) {
      // It ended before any row: a refusal of the caller's fields.
      try {
        await p;
      } catch (e) {
        throw new Refusal(400, e instanceof Error ? e.message.split("\n")[0]! : "refused");
      }
      throw new Error("a pass ended with no row");
    }
    const e = entry;
    if (!res.destroyed) res.writeHead(200, { "content-type": `${NDJSON}; charset=utf-8`, "cache-control": "no-store" });
    writeLine(res, { type: "started", passId: e.handle });
    let result: R;
    try {
      result = safeResult(await p);
    } catch (err) {
      log.error("serve_pass_failed", { pass: e.passId });
      result = safeResult(failed(e.passId, err instanceof Error ? err.message.split("\n")[0]! : "the pass failed"));
    }
    let where: "db" | "spool" | "failed" = "failed";
    try {
      where = o.store.servePass({ ...rowOf(e), endedAt: now().toISOString(), result: JSON.stringify(result) });
    } catch {
      log.error("serve_row_failed", { pass: e.handle });
    }
    // Once the end is in the database, GET reads it there; memory holds only what the database lacks.
    if (where !== "db") ended.set(e.handle, { tokenId: e.tokenId, result });
    live.delete(e.handle);
    log.info("serve-pass-end", { pass: e.handle, route, outcome: result.failure === undefined ? "ok" : result.failure.kind });
    writeLine(res, { type: "result", result });
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  /** Results whose end row went to the spool (or failed), so GET still answers them. */
  const ended = new Map<string, { tokenId: string; result: AnyResult }>();

  const failedPass = (account: string | null) => (passId: string, message: string): PassResult => ({ passId, account, text: "", texts: [], turns: 0, model: null, usage: NO_TOKENS, failure: { kind: "provider", code: "setup", message }, logPath: null });
  const failedTurn = (account: string) => (passId: string, message: string): TurnResult => ({ passId, account, text: "", texts: [], turns: 0, model: null, usage: NO_TOKENS, failure: { kind: "provider", code: "setup", message } });

  /** The conversation, when this token opened it; else the same 404 as no conversation at all. */
  const boundConversation = (token: ProjectToken, id: string): { runner: string; account: string; cwd: string; spec: string; closed_at: string | null } => {
    if (db.prepare("SELECT 1 FROM serve_conversations WHERE id = ? AND token_id = ?").get(id, token.id) === undefined) throw NOT_FOUND();
    const row = db.prepare("SELECT runner, account, cwd, spec, closed_at FROM conversations WHERE id = ?").get(id) as { runner: string; account: string; cwd: string; spec: string; closed_at: string | null } | undefined;
    if (row === undefined) throw NOT_FOUND();
    return row;
  };

  const busy = (a: AccountRow): boolean => {
    if (a.kind !== "login") return false;
    const lock = lockPathOf(o.home, a);
    return existsSync(lock) && flockBusy(lock);
  };

  async function route(name: ServeRouteName, params: Record<string, string>, token: ProjectToken, req: IncomingMessage, res: ServerResponse): Promise<void> {
    switch (name) {
      case "serveAccounts": {
        const list: ServeAccountView[] = token.accounts
          .map((id) => getAccount(db, id))
          .filter((a): a is AccountRow => a !== undefined && a.state !== "removed")
          .map((a) => {
            const { ownerEmail, loginEmail, consentBy, ...view } = accountView({ db, env: o.env, now: now(), busy }, a);
            void ownerEmail, void loginEmail, void consentBy;
            return view;
          });
        return sendJson(res, name, 200, list);
      }
      case "passStatus": {
        const id = params.passId!;
        const l = live.get(id);
        if (l !== undefined && l.tokenId === token.id) return sendJson(res, name, 200, { running: true, passId: l.handle, account: l.account, startedAt: l.startedAt } satisfies PassStatus);
        const e = ended.get(id);
        if (e !== undefined && e.tokenId === token.id) return sendJson(res, name, 200, { running: false, result: e.result } satisfies PassStatus);
        const row = db.prepare("SELECT account, started_at, ended_at, result FROM serve_passes WHERE id = ? AND token_id = ?").get(id, token.id) as { account: string | null; started_at: string; ended_at: string | null; result: string | null } | undefined;
        if (row === undefined) throw NOT_FOUND();
        const status: PassStatus = row.ended_at === null || row.result === null
          ? { running: true, passId: id, account: row.account, startedAt: row.started_at }
          : { running: false, result: JSON.parse(row.result) as AnyResult };
        return sendJson(res, name, 200, status);
      }
      case "startPass": {
        const b = passBody(await jsonBody(req));
        const s = scopeSetup(token, b, scopeCtx);
        if (stopping) throw STOPPING();
        // A conversation's history is its own: only its turns route, and only its token, reach it.
        if (b.session !== undefined && db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(b.session) !== undefined) throw new Refusal(403, "out of scope: session");
        const { identity, ...rest } = b;
        const deps = depsFor(token, identity);
        const { account, allowed, ...paths } = s;
        const target = account === undefined ? { pool: token.project, allowed: allowed! } : { account };
        return streamed(res, name, token, "pass", b.runner, account ?? null, (onStart, onOutput) => runPass({ ...rest, ...paths, ...target, onStart, onOutput }, deps), failedPass(account ?? null));
      }
      case "openConversation": {
        const b = openBody(await jsonBody(req));
        const s = scopeSetup(token, b, scopeCtx);
        if (stopping) throw STOPPING();
        const { identity, ...rest } = b;
        let conv;
        try {
          conv = open({ ...rest, ...s, account: s.account! }, depsFor(token, identity));
        } catch (e) {
          throw new Refusal(400, e instanceof Error ? e.message.split("\n")[0]! : "refused");
        }
        db.prepare("INSERT INTO serve_conversations (id, token_id) VALUES (?, ?)").run(conv.id, token.id);
        const out: ApiConversation = { id: conv.id, runner: conv.runner, account: conv.account, model: conv.model, cwd: conv.cwd, createdAt: conv.createdAt };
        return sendJson(res, name, 200, out);
      }
      case "sendTurn": {
        const id = params.id!;
        const conv = boundConversation(token, id);
        const b = turnBody(await jsonBody(req));
        if (conv.closed_at !== null) throw new Refusal(409, "the conversation is closed");
        // The paths were checked at open; check them again, so a symlink swapped since cannot move a mount.
        const spec = JSON.parse(conv.spec) as Partial<ScopedSetup> & { image?: string; container?: string };
        scopeSetup(token, { runner: conv.runner as "pi", account: conv.account, cwd: conv.cwd, ...(spec.gitDir === undefined ? {} : { gitDir: spec.gitDir }), ...(spec.skill === undefined ? {} : { skill: spec.skill }), ...(spec.mounts === undefined ? {} : { mounts: spec.mounts }), ...(spec.image === undefined ? {} : { image: spec.image }), ...(spec.container === undefined ? {} : { container: spec.container }) }, scopeCtx);
        if (stopping) throw STOPPING();
        const deps = depsFor(token, b.identity);
        return streamed(res, name, token, "turn", conv.runner, conv.account, (onStart, onOutput) => send(id, b.message, { onStart, onOutput, ...(b.idleMs === undefined ? {} : { idleMs: b.idleMs }), ...(b.deadlineMs === undefined ? {} : { deadlineMs: b.deadlineMs }) }, deps), failedTurn(conv.account));
      }
      case "closeConversation": {
        boundConversation(token, params.id!);
        close(params.id!, depsFor(token, { name: "squad", email: "squad@localhost" }));
        if (!res.destroyed) {
          res.writeHead(204);
          res.end();
        }
        return;
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.on("error", () => {});
    res.on("error", () => {});
    if (stopping) return sendJson(res, "stopping", 503, { error: STOPPING().error });
    let token: ProjectToken;
    try {
      token = authenticate(db, req.headers.authorization, now());
    } catch (e) {
      if (e instanceof Refusal) return sendJson(res, "auth", e.status, { error: e.error });
      throw e;
    }
    const pathname = new URL(req.url ?? "/", "http://squad").pathname;
    let hit: { name: ServeRouteName; params: Record<string, string> } | undefined;
    let pathMatched = false;
    try {
      for (const [name, r] of Object.entries(SERVE_ROUTES) as [ServeRouteName, (typeof SERVE_ROUTES)[ServeRouteName]][]) {
        const params = matchPath(r.path, pathname);
        if (params === undefined) continue;
        pathMatched = true;
        if (r.method === req.method) hit = { name, params };
      }
    } catch {
      return sendJson(res, "bad-path", 400, { error: "bad path" });
    }
    if (hit === undefined) return sendJson(res, "unknown", pathMatched ? 405 : 404, { error: pathMatched ? "method not allowed" : "no such route" });
    const name = hit.name;
    const streaming = name === "startPass" || name === "sendTurn";
    const job = (async () => {
      try {
        await route(name, hit.params, token, req, res);
      } catch (e) {
        if (e instanceof Refusal) return sendJson(res, name, e.status, { error: e.error });
        // The error text may hold anything, so it is not logged.
        log.error("serve_handler_failed", { route: name });
        sendJson(res, name, 500, { error: INTERNAL });
      }
    })();
    if (streaming) {
      work.add(job);
      void job.finally(() => work.delete(job));
    }
    await job;
  }

  /** The result of a pass serve found again after a restart: the same shape a live pass gives. */
  const recoveredResult = (row: OpenServeRow, failure: Failure | undefined, w?: Watched): AnyResult => {
    const base = {
      passId: row.pass_id, text: w?.outcome.text ?? "", texts: w?.outcome.texts ?? [], turns: w?.outcome.turns ?? 0, model: w?.outcome.model ?? null, usage: w?.outcome.usage ?? NO_TOKENS,
      ...(failure === undefined ? {} : { failure }),
    };
    return row.kind === "turn" ? { ...base, account: row.account ?? "" } : { ...base, account: row.account, logPath: null };
  };
  const endRecovered = (row: OpenServeRow, result: AnyResult, outcome: string, w?: Watched): void => {
    const at = now().toISOString();
    const safe = safeResult(result);
    o.store.endPass({
      id: row.pass_id, endedAt: at, outcome, tokens: result.usage,
      ...(result.failure === undefined ? {} : { failKind: result.failure.kind, failCode: result.failure.code }),
      ...(w === undefined ? {} : { turns: w.outcome.turns, ...(w.outcome.model === null ? {} : { model: w.outcome.model }), ...(w.exitCode === null ? {} : { exitCode: w.exitCode }) }),
    });
    const where = o.store.servePass({ id: row.id, tokenId: row.token_id, kind: row.kind, passId: row.pass_id, container: row.container, runner: row.runner, account: row.account, startedAt: row.started_at, endedAt: at, result: JSON.stringify(safe) });
    if (where !== "db") ended.set(row.id, { tokenId: row.token_id, result: safe });
    live.delete(row.id);
    log.info("serve-recovered", { pass: row.id, outcome: result.failure === undefined ? "ok" : `${result.failure.kind}:${result.failure.code}` });
  };

  /** Every pass this serve started and never ended: watch the ones still running, end the gone ones as lost. */
  function recover(): void {
    try {
      o.store.foldSpool();
    } catch (e) {
      if (!isBusy(e)) throw e;
      log.warn("serve-spool-busy", {});
    }
    const rows = openServeRows(db);
    if (rows.length === 0) return;
    const states = containerStates(docker);
    if (states === null) {
      // No answer is not "gone": the rows stay running until a later start can ask again.
      log.warn("serve-recover-unknown", { rows: rows.length });
      return;
    }
    for (const row of rows) {
      if (row.container === null || !states.has(row.container)) {
        endRecovered(row, recoveredResult(row, LOST), "lost");
        continue;
      }
      const container = row.container;
      live.set(row.id, { handle: row.id, tokenId: row.token_id, kind: row.kind, runner: row.runner, account: row.account, startedAt: row.started_at, passId: row.pass_id, container });
      log.info("serve-watch", { pass: row.id, container });
      const job = (async () => {
        try {
          const w = await watchContainer(docker, container, row.runner);
          if (w.gone) {
            // logs and wait both failed: the daemon may be down. Only a clear answer without the container is "lost".
            const now = containerStates(docker);
            if (now === null || now.has(container)) {
              log.warn("serve-watch-unknown", { pass: row.id, container });
              live.delete(row.id);
              return;
            }
            return endRecovered(row, recoveredResult(row, LOST), "lost");
          }
          const failure = failureOf(w.outcome, w.exitCode, undefined, "");
          endRecovered(row, recoveredResult(row, failure, w), failure === undefined ? "ok" : "fail", w);
        } catch {
          // The row stays running: a later start looks again.
          log.error("serve_watch_failed", { pass: row.id });
          live.delete(row.id);
        }
      })();
      work.add(job);
      void job.finally(() => work.delete(job));
    }
  }
  // One serve per home, whatever its socket or port: two would both recover the same rows. The guard
  // is a socket nobody talks to; it goes away with the process, even on SIGKILL.
  mkdirSync(o.home.state, { recursive: true, mode: 0o700 });
  const guardPath = join(o.home.state, "serve.guard");
  await clearStaleSocket(guardPath, "this home");
  const guard: NetServer = createNetServer((c) => c.destroy());
  await listenOwnerOnly(guard, guardPath);

  const server: Server = createServer((req, res) => void handle(req, res));
  let address: string;
  try {
    if (o.socket !== undefined) {
      await clearStaleSocket(o.socket, o.socket);
      await listenOwnerOnly(server, o.socket);
      address = `unix:${o.socket}`;
    } else {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(o.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const a = server.address();
      address = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : o.port}`;
    }
  } catch (e) {
    await new Promise<void>((resolve) => guard.close(() => resolve()));
    throw e;
  }
  // Only now, with this serve the one for the home, may it end or watch earlier rows. No request runs
  // before this: the handlers start on a later turn of the event loop.
  recover();
  log.info("serve-listen", { address });

  let stopP: Promise<void> | undefined;
  const allDone = (): Promise<unknown> => Promise.all([...work]);
  const stop = (): Promise<void> =>
    (stopP ??= (async () => {
      stopping = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await within(allDone(), envNum(SQUAD_SERVE_DRAIN_S_ENV, o.env) * 1000);
      const graceS = stopGraceS(o.env);
      if (work.size > 0) {
        // Stop before kill: the grace time lets a token refresh in flight finish.
        for (const l of live.values()) {
          if (l.container === null) continue;
          log.info("serve-stop-pass", { pass: l.handle, container: l.container });
          spawn(docker, dockerStopArgv(l.container, graceS), { stdio: "ignore" }).on("error", () => {});
        }
        await within(allDone(), (graceS + 10) * 1000);
      }
      server.closeAllConnections();
      await closed;
      if (o.socket !== undefined) rmSync(o.socket, { force: true });
      await new Promise<void>((resolve) => guard.close(() => resolve()));
      rmSync(guardPath, { force: true });
      log.info("serve-stopped", { left: work.size });
    })());
  return { address, stop };
}
