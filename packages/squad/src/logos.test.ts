import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "./home.ts";
import { LOGO_MAX_BYTES, clearLogos, getLogo, isLogoId, logoUrl } from "./logos.ts";
import { PRICES_TTL_MS } from "./prices.ts";

const NOW = 1_800_000_000_000;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
const URL_ = "http://catalog.test:7311/api.json";

function rig(reply: (url: string) => Response | Promise<Response> = () => new Response(SVG, { headers: { "content-type": "image/svg+xml" } })) {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "logos-")), {});
  ensureHome(home);
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(reply(String(url)));
  };
  const ask = (id: string, over: { now?: number; url?: string; env?: Record<string, string> } = {}) =>
    getLogo({ home, url: over.url ?? URL_, id, now: over.now ?? NOW, fetch: fetch as typeof globalThis.fetch, env: over.env ?? {} });
  return { home, calls, ask };
}

test("a logo id is lower-case letters, digits, dot, dash or underscore, and starts with a letter or digit", () => {
  for (const ok of ["engy", "opencode-go", "a.b_c", "0x"]) assert.ok(isLogoId(ok), ok);
  for (const bad of ["", "..", ".hidden", "-x", "Upper", "a/b", "a b", "a%2fb", "x".repeat(65)]) assert.ok(!isLogoId(bad), bad);
});

test("the logo address is on the catalog's own origin, whatever path the catalog address has", () => {
  assert.equal(logoUrl("http://catalog.test:7311/api.json", "engy"), "http://catalog.test:7311/logos/engy.svg");
  assert.equal(logoUrl("https://models.dev/api.json", "openai"), "https://models.dev/logos/openai.svg");
  assert.equal(logoUrl("", "x"), undefined);
  assert.equal(logoUrl("ftp://h/api.json", "x"), undefined);
  assert.equal(logoUrl("not a url", "x"), undefined);
});

test("the first ask fetches and saves the logo; the next ask is served from the saved file", async () => {
  const r = rig();
  assert.equal((await r.ask("engy"))?.toString(), SVG);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.url, "http://catalog.test:7311/logos/engy.svg");
  assert.equal((r.calls[0]!.init as { redirect?: string }).redirect, "error", "a redirect could leave the catalog's origin");
  assert.equal(readFileSync(join(r.home.state, "logos", "engy.svg"), "utf8"), SVG);
  assert.equal((await r.ask("engy", { now: NOW + 1000 }))?.toString(), SVG);
  assert.equal(r.calls.length, 1);
});

test("a saved logo older than the price TTL is fetched again; if the catalog is down the old one is kept", async () => {
  let up = true;
  const r = rig(() => (up ? new Response(SVG, { headers: { "content-type": "image/svg+xml" } }) : new Response("no", { status: 500 })));
  await r.ask("engy");
  const later = NOW + PRICES_TTL_MS + 1;
  await r.ask("engy", { now: later });
  assert.equal(r.calls.length, 2);
  up = false;
  const stale = join(r.home.state, "logos", "engy.svg");
  utimesSync(stale, (NOW - 10 * PRICES_TTL_MS) / 1000, (NOW - 10 * PRICES_TTL_MS) / 1000);
  assert.equal((await r.ask("engy", { now: NOW + 5 * PRICES_TTL_MS }))?.toString(), SVG);
});

test("clearLogos drops the saved logos, so the next price refresh brings new ones", async () => {
  const r = rig();
  await r.ask("engy");
  clearLogos(r.home);
  assert.ok(!existsSync(join(r.home.state, "logos", "engy.svg")));
  await r.ask("engy");
  assert.equal(r.calls.length, 2);
});

test("a 404 gives no logo, and asking again soon does not hit the catalog again", async () => {
  const r = rig(() => new Response("no", { status: 404 }));
  assert.equal(await r.ask("nope"), undefined);
  assert.equal(await r.ask("nope", { now: NOW + 1000 }), undefined);
  assert.equal(r.calls.length, 1);
  assert.equal(await r.ask("nope", { now: NOW + 60 * 60_000 }), undefined);
  assert.equal(r.calls.length, 2);
});

test("only image/svg+xml is kept: html, png and a missing type are refused and nothing is saved", async () => {
  for (const type of ["text/html", "image/png", "application/octet-stream", undefined]) {
    const r = rig(() => new Response(SVG, type === undefined ? {} : { headers: { "content-type": type } }));
    assert.equal(await r.ask("engy"), undefined, String(type));
    assert.ok(!existsSync(join(r.home.state, "logos", "engy.svg")));
  }
  const withCharset = rig(() => new Response(SVG, { headers: { "content-type": "image/svg+xml; charset=utf-8" } }));
  assert.ok(await withCharset.ask("engy"));
});

test("a logo over the size cap is refused, whether the length is announced or not", async () => {
  const big = "x".repeat(LOGO_MAX_BYTES + 1);
  const r = rig(() => new Response(big, { headers: { "content-type": "image/svg+xml" } }));
  assert.equal(await r.ask("engy"), undefined);
  assert.ok(!existsSync(join(r.home.state, "logos", "engy.svg")));
  const edge = rig(() => new Response("x".repeat(LOGO_MAX_BYTES), { headers: { "content-type": "image/svg+xml" } }));
  assert.ok(await edge.ask("engy"));
  async function* chunks(): AsyncGenerator<Uint8Array> { for (let i = 0; i < 10; i++) yield new Uint8Array(LOGO_MAX_BYTES / 4); }
  const stream = rig(() => new Response(ReadableStream.from(chunks()), { headers: { "content-type": "image/svg+xml" } }));
  assert.equal(await stream.ask("engy"), undefined);
});

test("a bad id never reaches the network or the disk", async () => {
  const r = rig();
  for (const id of ["..", "a/b", "A", ""]) assert.equal(await r.ask(id), undefined);
  assert.equal(r.calls.length, 0);
});

test("no fetch when the catalog address is empty, prices are off, or this is a dry run; a saved logo is still served", async () => {
  const r = rig();
  mkdirSync(join(r.home.state, "logos"), { recursive: true });
  writeFileSync(join(r.home.state, "logos", "saved.svg"), SVG);
  utimesSync(join(r.home.state, "logos", "saved.svg"), (NOW - 100 * PRICES_TTL_MS) / 1000, (NOW - 100 * PRICES_TTL_MS) / 1000);
  for (const over of [{ url: "" }, { env: { SQUAD_NO_PRICES: "1" } }, { env: { SQUAD_DRY_RUN: "1" } }] as { url?: string; env?: Record<string, string> }[]) {
    assert.equal(await r.ask("engy", over), undefined);
    assert.equal((await r.ask("saved", over))?.toString(), SVG);
  }
  assert.equal(r.calls.length, 0);
});

test("two asks at once make one fetch", async () => {
  const r = rig();
  const [a, b] = await Promise.all([r.ask("engy"), r.ask("engy")]);
  assert.ok(a && b);
  assert.equal(r.calls.length, 1);
});

test("a fetch that throws gives no logo and leaves no file", async () => {
  const r = rig(() => { throw new Error("down"); });
  assert.equal(await r.ask("engy"), undefined);
  assert.ok(!existsSync(join(r.home.state, "logos", "engy.svg")));
});
