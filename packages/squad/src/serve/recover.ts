// After a restart, `squad serve` looks again at every pass it started that has no end. The container
// name is fixed, so docker can say if it still runs.
//
// The one rule that matters: only a clear answer that the container is gone ends a pass as lost.
// doppelganger starts again in the same worktree on a provider failure, so a wrong "lost" would put
// two agents in one folder. `docker ps` answers with exit 0 and a list; any other exit, a timeout or
// a spawn error is no answer, and the pass stays running. No error text is read.
import { spawn, spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { dockerPsArgv } from "../docker.ts";
import { RUNNER_SPECS, isSupported } from "../runners/table.ts";
import type { Failure, StreamOutcome } from "../types.ts";

export interface OpenServeRow {
  readonly id: string;
  readonly token_id: string;
  readonly kind: "pass" | "turn";
  readonly pass_id: string;
  readonly container: string | null;
  readonly runner: string;
  readonly account: string | null;
  readonly started_at: string;
}

export const LOST: Failure = { kind: "provider", code: "lost", message: "squad serve restarted and the pass's container was gone" };
/** A daemon that does not answer in this time counts as no answer. */
const PS_TIMEOUT_MS = 15_000;

export const openServeRows = (db: DatabaseSync): OpenServeRow[] =>
  db.prepare("SELECT id, token_id, kind, pass_id, container, runner, account, started_at FROM serve_passes WHERE ended_at IS NULL ORDER BY id").all() as unknown as OpenServeRow[];

/** Every squad container by name, with its state; null when docker gave no answer. */
export function containerStates(docker: string): Map<string, string> | null {
  const r = spawnSync(docker, dockerPsArgv(), { encoding: "utf8", timeout: PS_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error !== undefined || r.status !== 0) return null;
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const [name, , state] = line.split("\t");
    if (name !== undefined && name !== "") out.set(name, state ?? "");
  }
  return out;
}

export interface Watched {
  readonly outcome: StreamOutcome;
  /** The container's exit code from `docker wait`, or null when it gave none. */
  readonly exitCode: number | null;
  /** Both `docker logs` and `docker wait` failed: the container went away under us. */
  readonly gone: boolean;
}

const exitOf = (c: ReturnType<typeof spawn>): Promise<number | null> =>
  new Promise((resolve) => {
    c.on("error", () => resolve(null));
    c.on("close", (code) => resolve(code));
  });

/** Reads the container's whole stream with `docker logs -f` until it ends, and its exit code with `docker wait`. */
export async function watchContainer(docker: string, name: string, runner: string): Promise<Watched> {
  if (!isSupported(runner)) throw new Error(`runner ${runner} is not supported`);
  const stream = RUNNER_SPECS[runner].stream();
  const dec = new StringDecoder("utf8");
  const logs = spawn(docker, ["logs", "-f", name], { stdio: ["ignore", "pipe", "ignore"] });
  logs.stdout!.on("data", (b: Buffer) => stream.push(dec.write(b)));
  const wait = spawn(docker, ["wait", name], { stdio: ["ignore", "pipe", "ignore"] });
  let waited = "";
  wait.stdout!.on("data", (b: Buffer) => (waited += b.toString("utf8")));
  const [logsExit, waitExit] = await Promise.all([exitOf(logs), exitOf(wait)]);
  stream.push(dec.end());
  stream.end();
  const exitCode = waitExit === 0 && /^\d+\s*$/.test(waited) ? Number(waited.trim()) : null;
  return { outcome: stream.outcome(), exitCode, gone: logsExit !== 0 && waitExit !== 0 };
}
