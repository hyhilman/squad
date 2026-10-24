// A typed caller for the API. The web app uses it (Refine's data provider wraps it); a backend test
// uses it against a real server. It has no dependency: the caller hands in its own `fetch`.
import { ROUTES, pathOf, type Api, type ApiError, type RouteName } from "./api.ts";

/** The part of `fetch` this needs, so the package needs neither DOM nor Node types. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; credentials: "same-origin" },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export class ApiFailure extends Error {
  readonly status: number;
  readonly body: ApiError;
  constructor(status: number, body: ApiError) {
    super(`${body.error}: ${body.message}`);
    this.status = status;
    this.body = body;
  }
}

type Input<N extends RouteName> = (Api[N]["params"] extends void ? {} : { params: Api[N]["params"] }) &
  (Api[N]["query"] extends void ? {} : { query: Api[N]["query"] }) &
  (Api[N]["body"] extends void ? {} : { body: Api[N]["body"] });

const isApiError = (v: unknown): v is ApiError =>
  typeof v === "object" && v !== null && typeof (v as ApiError).error === "string" && typeof (v as ApiError).message === "string";

/** Calls one route. The session is the same-origin cookie; the app never holds a token. */
export async function call<N extends RouteName>(fetchFn: FetchLike, base: string, name: N, input: Input<N>): Promise<Api[N]["res"]> {
  const route = ROUTES[name];
  const i = input as { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown };
  let url = base + pathOf(route.path, i.params);
  if (i.query !== undefined) {
    const q = Object.entries(i.query)
      .filter((e): e is [string, string] => e[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    if (q !== "") url += `?${q}`;
  }
  const res = await fetchFn(url, {
    method: route.method,
    headers: {
      accept: "application/json",
      ...(i.body === undefined ? {} : { "content-type": "application/json" }),
      // The backend refuses a write without it, so a page of another origin cannot make one.
      ...(route.method === "GET" ? {} : { "x-squad-csrf": "1" }),
    },
    ...(i.body === undefined ? {} : { body: JSON.stringify(i.body) }),
    credentials: "same-origin",
  });
  const json = await res.json();
  if (!res.ok) throw new ApiFailure(res.status, isApiError(json) ? json : { error: "internal", message: `HTTP ${res.status}` });
  return json as Api[N]["res"];
}
