// The request bodies of `squad serve`, checked field by field. A field the contract does not name is
// refused, so an internal PassRequest field (probe, openSkill, conversation, pool) can never come in
// over the socket. A refusal is a 400 that names the field.
import type { Identity, ServeOpenBody, ServePassBody, ServeTurnBody } from "@squad/contract";
import { Refusal } from "./scope.ts";

const bad = (message: string): Refusal => new Refusal(400, message);
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const SETUP_KEYS = ["model", "cwd", "gitDir", "caller", "task", "env", "system", "skill", "effort", "mounts", "image", "container", "labels", "identity"];
const PASS_KEYS = [...SETUP_KEYS, "runner", "account", "prompt", "session", "idleMs", "deadlineMs"];
const OPEN_KEYS = [...SETUP_KEYS, "runner", "account"];
const TURN_KEYS = ["message", "idleMs", "deadlineMs", "identity"];
/** A week: longer than any pass may sensibly run. */
const MAX_MS = 7 * 24 * 3600_000;
const CONTROL = /[\u0000-\u001f\u007f]/;

function onlyKeys(o: Obj, keys: readonly string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`unknown field ${k}`);
}

function str(o: Obj, k: string, optional = false): string | undefined {
  const v = o[k];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || v === "") throw bad(`${k} must be a string`);
  return v;
}

function pair<A extends string, B extends string>(o: Obj, k: string, a: A, b: B, optional = false): Record<A | B, string> | undefined {
  const v = o[k];
  if (v === undefined && optional) return undefined;
  if (!isObj(v) || Object.keys(v).some((x) => x !== a && x !== b) || typeof v[a] !== "string" || typeof v[b] !== "string" || v[a] === "" || v[b] === "") throw bad(`${k} must be {${a}, ${b}}`);
  return { [a]: v[a], [b]: v[b] } as Record<A | B, string>;
}

function strings(o: Obj, k: string): Record<string, string> | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!isObj(v) || Object.values(v).some((x) => typeof x !== "string")) throw bad(`${k} must be an object of strings`);
  return { ...(v as Record<string, string>) };
}

function ms(o: Obj, k: string): number | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1000 || v > MAX_MS) throw bad(`${k} must be milliseconds from 1000 to ${MAX_MS}`);
  return v;
}

/** It goes into the container's git env, so no control character and a sane length. */
function identity(o: Obj): Identity {
  const v = o.identity;
  const ok = (x: unknown): x is string => typeof x === "string" && x !== "" && x.length <= 256 && !CONTROL.test(x);
  if (!isObj(v) || Object.keys(v).some((x) => x !== "name" && x !== "email") || !ok(v.name) || !ok(v.email)) throw bad("identity must be {name, email}");
  return { name: v.name, email: v.email };
}

function runner(o: Obj): "pi" | "codex" | "claude" {
  const v = o.runner;
  if (v !== "pi" && v !== "codex" && v !== "claude") throw bad("runner must be pi, codex or claude");
  return v;
}

function mounts(o: Obj): ServePassBody["mounts"] {
  const v = o.mounts;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw bad("mounts must be a list");
  return v.map((m: unknown, i) => {
    if (!isObj(m) || Object.keys(m).some((x) => x !== "host" && x !== "container" && x !== "ro") || typeof m.host !== "string" || typeof m.container !== "string" || typeof m.ro !== "boolean") throw bad(`mounts[${i}] must be {host, container, ro}`);
    return { host: m.host, container: m.container, ro: m.ro };
  });
}

function setup(o: Obj) {
  const effort = str(o, "effort", true);
  const out = {
    model: str(o, "model")!,
    cwd: str(o, "cwd")!,
    gitDir: str(o, "gitDir", true),
    caller: pair(o, "caller", "flow", "action")!,
    task: pair(o, "task", "kind", "id", true),
    env: strings(o, "env"),
    system: str(o, "system", true),
    skill: pair(o, "skill", "name", "dir", true),
    // runPass checks the level against the runner.
    effort: effort as ServePassBody["effort"],
    mounts: mounts(o),
    image: str(o, "image", true),
    container: str(o, "container", true),
    labels: strings(o, "labels"),
    identity: identity(o),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as typeof out;
}

const parse = (v: unknown): Obj => {
  if (!isObj(v)) throw bad("the body must be a JSON object");
  return v;
};

export function passBody(v: unknown): ServePassBody {
  const o = parse(v);
  onlyKeys(o, PASS_KEYS);
  const extra = { runner: runner(o), account: str(o, "account", true), prompt: typeof o.prompt === "string" ? o.prompt : (() => { throw bad("prompt must be a string"); })(), session: str(o, "session", true), idleMs: ms(o, "idleMs"), deadlineMs: ms(o, "deadlineMs") };
  return { ...setup(o), ...Object.fromEntries(Object.entries(extra).filter(([, x]) => x !== undefined)) } as ServePassBody;
}

export function openBody(v: unknown): ServeOpenBody {
  const o = parse(v);
  onlyKeys(o, OPEN_KEYS);
  return { ...setup(o), runner: runner(o), account: str(o, "account")! } as ServeOpenBody;
}

export function turnBody(v: unknown): ServeTurnBody {
  const o = parse(v);
  onlyKeys(o, TURN_KEYS);
  if (typeof o.message !== "string" || o.message === "") throw bad("message must be a string");
  const idleMs = ms(o, "idleMs");
  const deadlineMs = ms(o, "deadlineMs");
  return { message: o.message, identity: identity(o), ...(idleMs === undefined ? {} : { idleMs }), ...(deadlineMs === undefined ? {} : { deadlineMs }) };
}
