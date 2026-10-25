// A typed caller for the API. The web app uses it; a backend test uses it against a real server; a
// machine caller uses it against `squad serve`. It has no dependency: the caller hands in its own `fetch`.
import { ALL_ROUTES, LINE_TYPES, NDJSON, STREAM_ROUTES, pathOf, type AllApi, type AnyRouteName, type ApiError, type ErrorCode, type StreamRouteName } from "./api.ts";

type Init = { method: string; headers: Record<string, string>; body?: string; credentials: "same-origin" | "include" };

/** The part of `fetch` this needs, so the package needs neither DOM nor Node types. */
export type FetchLike = (url: string, init: Init) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

/** The bytes of an answer, read piece by piece: the `body` of a fetch Response in a browser or in Node. */
export interface ByteStream {
  getReader(): { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>; releaseLock?(): void };
}

/** A fetch whose answer also gives its body as a stream. The global fetch is one; so is `nodeSocketFetch` (`@squad/contract/node`). */
export type StreamFetchLike = (
  url: string,
  init: Init,
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown>; readonly body: ByteStream | null }>;

export class ApiFailure extends Error {
  readonly status: number;
  readonly body: ApiError;
  constructor(status: number, body: ApiError) {
    super(`${body.error}: ${body.message}`);
    this.status = status;
    this.body = body;
  }
}

/** Every route but the streaming ones; those go through `callStream`. */
export type CallRouteName = Exclude<AnyRouteName, StreamRouteName>;

type Input<N extends AnyRouteName> = (AllApi[N]["params"] extends void ? {} : { params: AllApi[N]["params"] }) &
  // A query whose fields are all optional may be left out, so adding one to a route breaks no caller.
  (AllApi[N]["query"] extends void ? {} : {} extends AllApi[N]["query"] ? { query?: AllApi[N]["query"] } : { query: AllApi[N]["query"] }) &
  (AllApi[N]["body"] extends void ? {} : { body: AllApi[N]["body"] });

const isApiError = (v: unknown): v is ApiError =>
  typeof v === "object" && v !== null && typeof (v as ApiError).error === "string" && typeof (v as ApiError).message === "string";

/** `squad serve` refuses with `{ error: "<reason>" }` only. The code then comes from the status, and the reason is the message. */
const CODE_OF_STATUS: Readonly<Record<number, ErrorCode>> = { 400: "bad-request", 401: "unauthenticated", 403: "forbidden", 404: "not-found", 409: "conflict", 413: "bad-request", 429: "too-many" };
function failureOf(status: number, json: unknown): ApiFailure {
  if (isApiError(json)) return new ApiFailure(status, json);
  const reason = typeof json === "object" && json !== null && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `HTTP ${status}`;
  return new ApiFailure(status, { error: CODE_OF_STATUS[status] ?? "internal", message: reason });
}

export interface CallOptions {
  /** "include" sends the session cookie to another origin of the same site; it needs SQUAD_WEB_API_ORIGINS on the server. */
  readonly credentials?: "same-origin" | "include";
  /** Extra headers, such as `authorization: Bearer <token>` for `squad serve`. */
  readonly headers?: Readonly<Record<string, string>>;
}

function requestOf(name: AnyRouteName, base: string, input: unknown, opts: CallOptions, accept: string): { url: string; init: Init } {
  const route = ALL_ROUTES[name];
  const i = input as { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown };
  let url = base + pathOf(route.path, i.params);
  if (i.query !== undefined) {
    const q = Object.entries(i.query)
      .filter((e): e is [string, string] => e[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    if (q !== "") url += `?${q}`;
  }
  return {
    url,
    init: {
      method: route.method,
      headers: {
        ...opts.headers,
        accept,
        ...(i.body === undefined ? {} : { "content-type": "application/json" }),
        // The web backend refuses a write without it, so a page of another origin cannot make one.
        ...(route.method === "GET" ? {} : { "x-squad-csrf": "1" }),
      },
      ...(i.body === undefined ? {} : { body: JSON.stringify(i.body) }),
      credentials: opts.credentials ?? "same-origin",
    },
  };
}

/** Calls one route. The web app's session is a cookie; the app never holds a token. */
export async function call<N extends CallRouteName>(fetchFn: FetchLike, base: string, name: N, input: Input<N>, opts: CallOptions = {}): Promise<AllApi[N]["res"]> {
  const { url, init } = requestOf(name, base, input, opts, "application/json");
  const res = await fetchFn(url, init);
  if (res.ok && res.status === 204) return undefined as AllApi[N]["res"];
  const json = await res.json();
  if (!res.ok) throw failureOf(res.status, json);
  return json as AllApi[N]["res"];
}

// TextDecoder is in every browser and in Node, but not in the ES lib this package compiles with.
type Decoder = { decode(input?: Uint8Array, opts?: { stream: boolean }): string };
const newDecoder = (): Decoder => new (globalThis as unknown as { TextDecoder: new (label: string) => Decoder }).TextDecoder("utf-8");

const KNOWN: ReadonlySet<string> = new Set(LINE_TYPES);

/**
 * Calls a streaming route (`startPass`, `sendTurn`) and yields its ndjson lines in order: "started",
 * then "output" lines, then one "result". A refusal before the stream throws ApiFailure. A line type
 * this client does not know is skipped. A stream that ends with no result line throws: the pass goes
 * on, so poll `passStatus` with the started passId.
 */
export async function* callStream<N extends StreamRouteName>(fetchFn: StreamFetchLike, base: string, name: N, input: Input<N>, opts: CallOptions = {}): AsyncGenerator<AllApi[N]["res"], void, undefined> {
  if (!(STREAM_ROUTES as readonly string[]).includes(name)) throw new Error(`${name} is not a streaming route`);
  const { url, init } = requestOf(name, base, input, opts, NDJSON);
  const res = await fetchFn(url, init);
  if (!res.ok) {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    throw failureOf(res.status, json);
  }
  if (res.body === null) throw new Error(`${name}: the answer has no body`);
  const reader = res.body.getReader();
  const decoder = newDecoder();
  let buf = "";
  let sawResult = false;
  const parse = (line: string): AllApi[N]["res"] | undefined => {
    if (line.trim() === "") return undefined;
    const v = JSON.parse(line) as { type?: unknown };
    if (typeof v !== "object" || v === null || typeof v.type !== "string" || !KNOWN.has(v.type)) return undefined;
    if (v.type === "result") sawResult = true;
    return v as AllApi[N]["res"];
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (line !== undefined) yield line;
        nl = buf.indexOf("\n");
      }
      if (done) break;
    }
    const last = parse(buf);
    if (last !== undefined) yield last;
  } finally {
    reader.releaseLock?.();
  }
  if (!sawResult) throw new Error(`${name}: the stream ended before its result line`);
}
