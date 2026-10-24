// Provider logos. The catalog serves `<its origin>/logos/<id>.svg`. The page's CSP only allows its own
// origin, so squad fetches each logo once, keeps it in `<home.state>/logos/`, and serves it itself.
//
// A logo is public data, but the fetch is bounded: one origin (the catalog's), a checked id, no
// redirect, one type, a size cap, and a cache that also remembers misses.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomeLayout } from "./home.ts";
import { PRICES_TTL_MS } from "./prices.ts";
import { SQUAD_DRY_RUN_ENV, SQUAD_NO_PRICES_ENV, envOn } from "./settings.ts";

export const LOGO_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
/** After a miss or a failure the catalog is not asked again for this long, so a page that asks for many ids cannot hammer it. */
const MISS_MS = 10 * 60_000;
const MAX_MISSES = 1024;

const LOGO_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const isLogoId = (id: string): boolean => LOGO_ID.test(id);

/** Where the catalog keeps a logo: always its own origin, never a path the id could steer. */
export function logoUrl(catalogUrl: string, id: string): string | undefined {
  if (!isLogoId(id)) return undefined;
  try {
    const u = new URL(catalogUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}/logos/${id}.svg` : undefined;
  } catch {
    return undefined;
  }
}

const dirOf = (home: HomeLayout): string => join(home.state, "logos");

interface State {
  readonly misses: Map<string, number>;
  readonly inflight: Map<string, Promise<Buffer | undefined>>;
}
const states = new WeakMap<HomeLayout, State>();
const stateOf = (home: HomeLayout): State => {
  let s = states.get(home);
  if (s === undefined) states.set(home, (s = { misses: new Map(), inflight: new Map() }));
  return s;
};

/** Drops every saved logo. The price refresh calls it, so the next ask brings the catalog's current ones. */
export function clearLogos(home: HomeLayout): void {
  rmSync(dirOf(home), { recursive: true, force: true });
  stateOf(home).misses.clear();
}

async function readCapped(res: Response): Promise<Buffer | undefined> {
  const announced = Number(res.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > LOGO_MAX_BYTES) return undefined;
  if (res.body === null) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > LOGO_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

export interface GetLogo {
  readonly home: HomeLayout;
  /** The catalog address (SQUAD_PRICES_URL). */
  readonly url: string;
  readonly id: string;
  readonly now: number;
  readonly fetch: typeof globalThis.fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The logo, or undefined. A saved copy is used while it is fresh; an old one is renewed, and kept if the catalog cannot be reached. */
export async function getLogo(g: GetLogo): Promise<Buffer | undefined> {
  if (!isLogoId(g.id)) return undefined;
  const file = join(dirOf(g.home), `${g.id}.svg`);
  let saved: Buffer | undefined;
  let fetchedAt = 0;
  try {
    saved = readFileSync(file);
    fetchedAt = statSync(file).mtimeMs;
  } catch {
    saved = undefined;
  }
  if (saved !== undefined && g.now >= fetchedAt && g.now - fetchedAt < PRICES_TTL_MS) return saved;

  const s = stateOf(g.home);
  const url = logoUrl(g.url, g.id);
  const off = url === undefined || envOn(SQUAD_NO_PRICES_ENV, g.env) || envOn(SQUAD_DRY_RUN_ENV, g.env);
  const missed = s.misses.get(g.id);
  if (off || (missed !== undefined && g.now >= missed && g.now - missed < MISS_MS)) return saved;

  const running = s.inflight.get(g.id);
  if (running !== undefined) return (await running) ?? saved;
  const job = (async (): Promise<Buffer | undefined> => {
    try {
      const res = await g.fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const body = res.ok && type === "image/svg+xml" ? await readCapped(res) : undefined;
      if (body === undefined || body.length === 0) throw new Error("no usable logo");
      mkdirSync(dirOf(g.home), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      // The mtime is the fetch time on the caller's clock, so the age check has one clock.
      utimesSync(tmp, g.now / 1000, g.now / 1000);
      renameSync(tmp, file);
      s.misses.delete(g.id);
      return body;
    } catch {
      if (s.misses.size >= MAX_MISSES) s.misses.clear();
      s.misses.set(g.id, g.now);
      return undefined;
    }
  })();
  s.inflight.set(g.id, job);
  try {
    return (await job) ?? saved;
  } finally {
    s.inflight.delete(g.id);
  }
}

