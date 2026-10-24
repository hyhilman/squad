import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CLIENT_ID, startFakeOidc, type FakeOidc } from "../../test/fake-oidc.ts";
import { main, type Io } from "./squad.ts";

let p: FakeOidc;
before(async () => { p = await startFakeOidc(); });
after(async () => { await p.close(); });

function rig(env: Record<string, string>, signal?: AbortSignal) {
  const root = mkdtempSync(join(tmpdir(), "cliweb-"));
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { SQUAD_HOME: join(root, "home"), ...env }, cwd: root, ...(signal === undefined ? {} : { signal }) };
  return { io, out, err };
}

const ENV = () => ({ SQUAD_WEB_URL: "http://127.0.0.1:3000", SQUAD_WEB_PORT: "0", SQUAD_OIDC_ISSUER: p.issuer, SQUAD_OIDC_CLIENT_ID: CLIENT_ID });

test("squad web starts on a free port, prints where, answers, and stops on the signal", async () => {
  const ac = new AbortController();
  const r = rig(ENV(), ac.signal);
  const done = main(["web", "--api-only"], r.io);
  let port = "";
  for (let i = 0; i < 100 && port === ""; i++) {
    port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(r.out.join(""))?.[1] ?? "";
    if (port === "") await new Promise((res) => setTimeout(res, 20));
  }
  assert.notEqual(port, "", r.err.join(""));
  assert.match(r.out.join(""), /public http:\/\/127\.0\.0\.1:3000/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401);
  ac.abort();
  assert.equal(await done, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/me`));
});

test("squad web refuses to start without its settings, or with the kill switch, and says which", async () => {
  const none = rig({});
  assert.equal(await main(["web"], none.io), 1);
  assert.match(none.err.join(""), /SQUAD_WEB_URL is required/);
  const off = rig({ ...ENV(), SQUAD_NO_WEB_LOGIN: "1" });
  assert.equal(await main(["web"], off.io), 1);
  assert.match(off.err.join(""), /SQUAD_NO_WEB_LOGIN/);
});

test("squad web takes only --api-only", async () => {
  const r = rig(ENV());
  assert.equal(await main(["web", "--port", "1"], r.io), 2);
  assert.match(r.err.join(""), /usage: squad/);
});
