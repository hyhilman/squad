// `squad connect` against a real `squad web` on 127.0.0.1, with a fake `claude` program on PATH that
// prints a token-shaped fake under the real `script` pseudo-terminal. No real sign-in.
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConnectStart } from "@squad/contract";
import { CLIENT_ID, startFakeOidc, type FakeOidc } from "../../test/fake-oidc.ts";
import { getAccount } from "../accounts/store.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { makeLog } from "../log.ts";
import { openStore } from "../store/db.ts";
import { startWeb } from "../web/server.ts";
import { originOf, scriptArgv } from "./connect.ts";
import { main } from "./squad.ts";

const TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEHELPERFAKE_-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const PUBLIC = "http://127.0.0.1:3000";
const NOW = new Date("2026-10-24T12:00:00.000Z");

let p: FakeOidc;
before(async () => { p = await startFakeOidc("ES256"); });
after(async () => { await p.close(); });

test("the script argv: util-linux on Linux, BSD on macOS (no shell of its own, so sh -c), none on Windows", () => {
  const line = "stty cols 400 rows 50; exec 'claude' 'setup-token'";
  assert.deepEqual(scriptArgv("linux"), ["-qfc", line, "/dev/null"]);
  assert.deepEqual(scriptArgv("darwin"), ["-q", "/dev/null", "/bin/sh", "-c", line]);
  assert.equal(scriptArgv("win32"), undefined);
  assert.equal(scriptArgv("freebsd"), undefined);
});

test("the url must be an https origin; plain http only for this computer", () => {
  assert.equal(originOf("https://squad.example.test"), "https://squad.example.test");
  assert.equal(originOf("https://squad.example.test/"), "https://squad.example.test");
  assert.equal(originOf("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(originOf("http://localhost:8080/"), "http://localhost:8080");
  for (const bad of ["http://squad.example.test", "https://squad.example.test/api", "https://u:p@squad.example.test", "https://squad.example.test/?x=1", "https://squad.example.test/#x", "ftp://squad.example.test", "squad.example.test", "", "http://127.0.0.1.evil.test"]) {
    assert.equal(originOf(bad), undefined, bad);
  }
});

/** A fake `claude` on PATH. It notes its config dir and terminal size, prints the token, then lingers (squad must stop it). */
function fakeClaude(kind: "token" | "none" | "absent") {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  if (kind !== "absent") {
    const body = kind === "token"
      ? `printf '\\033[1mOpening\\033[1Cbrowser\\033[22m\\r\\n'\nsleep 0.2\nprintf 'Your OAuth token (valid for 1 year):\\r\\n\\r\\n%s\\r\\n\\r\\nStore this token securely.\\r\\n' "$FAKE_TOKEN"\nsleep 20\n`
      : `printf 'Error: sign-in failed\\r\\n'\nexit 1\n`;
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in --version) echo "2.1.310 (Claude Code)"; exit 0;; setup-token) ;; *) exit 64;; esac\necho "$CLAUDE_CONFIG_DIR" > "${dir}/config-dir"\nstty size > "${dir}/size"\n[ -d "$CLAUDE_CONFIG_DIR" ] || exit 65\n${body}`);
    chmodSync(join(bin, "claude"), 0o755);
  }
  return { dir, env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_TOKEN: TOKEN, HOME: dir } };
}

async function rig() {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "connect-web-")), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const logs: string[] = [];
  const web = await startWeb({ env: { SQUAD_WEB_URL: PUBLIC, SQUAD_WEB_PORT: "0", SQUAD_OIDC_ISSUER: p.issuer, SQUAD_OIDC_CLIENT_ID: CLIENT_ID }, home, store, now: () => NOW, busy: () => false, log: makeLog((l) => logs.push(l)) });
  const base = `http://127.0.0.1:${web.port}`;
  // A signed-in session through the real /auth routes.
  p.mutate = (c) => { c.email = "alice@example.test"; c.groups = ["squad"]; };
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const auth = await fetch(login.headers.get("location")!, { redirect: "manual" });
  const back = new URL(auth.headers.get("location")!);
  const cb = await fetch(`${base}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: login.headers.getSetCookie()[0]!.split(";")[0]! } });
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("squad_session="))!.split(";")[0]!;
  const startConnect = async (name: string): Promise<ConnectStart> => {
    const res = await fetch(`${base}/api/connect`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-squad-csrf": "1", origin: PUBLIC }, body: JSON.stringify({ runner: "claude", name }) });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as ConnectStart;
  };
  return { home, store, logs, base, startConnect, close: async () => { await web.close(); store.close(); } };
}

async function connect(args: string[], env: Record<string, string>, extra: { platform?: NodeJS.Platform; waitMs?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "connect-cwd-"));
  const code = await main(["connect", ...args], { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env, cwd, ...extra });
  return { code, out: out.join(""), err: err.join(""), cwd };
}

test("squad connect runs the local claude under a terminal, sends the token once, and prints only the fixed line", async () => {
  const r = await rig();
  await (await import("../prices.ts")).refreshPrices({ home: r.home, url: "https://catalog.test/api.json", now: NOW.getTime(), fetch: async () => ({ ok: true, status: 200, text: async () => readFileSync(new URL("../../test/fixtures/captures/prices/local-models-dev-excerpt.json", import.meta.url), "utf8") }), env: {} });
  const s = await r.startConnect("laptop");
  const f = fakeClaude("token");
  const t0 = Date.now();
  const res = await connect(["--url", r.base, "--pair", s.pairCode], f.env);
  assert.equal(res.code, 0, res.err);
  assert.ok(Date.now() - t0 < 10_000, "the lingering CLI was stopped once the token came");
  assert.equal(res.out, "A browser window opens on this computer. Sign in with Claude there.\nSigned in. claude/laptop is ready in squad.\n");
  assert.equal(res.err, "");
  assert.equal(readFileSync(join(r.home.accounts, "claude", "laptop", "token"), "utf8"), TOKEN);
  assert.equal(getAccount(r.store.db, "claude/laptop")?.ownerEmail, "alice@example.test");
  assert.equal(readFileSync(join(f.dir, "size"), "utf8").trim(), "50 400", "a wide terminal, so the token is not wrapped");
  const configDir = readFileSync(join(f.dir, "config-dir"), "utf8").trim();
  assert.ok(configDir !== "" && !existsSync(configDir), "the throwaway claude config folder is gone");
  assert.deepEqual(readdirSync(res.cwd), [], "connect makes no squad home where it runs");
  assert.ok(!r.logs.join("\n").includes("oat01") && !r.logs.join("\n").includes(s.pairCode));
  // The code was used: a second run is refused with a fixed text.
  const again = await connect(["--url", r.base, "--pair", s.pairCode], fakeClaude("token").env);
  assert.equal(again.code, 1);
  assert.equal(again.err, "squad connect: the pair code is wrong, used or expired. Start again from the web page.\n");
  assert.ok(!again.out.includes("oat01") && !again.err.includes("oat01"));
  await r.close();
});

test("the token is never sent through a redirect", async () => {
  let hits = 0;
  const target = createServer((_q, s) => { hits++; s.end("{}"); });
  await new Promise<void>((ok) => target.listen(0, "127.0.0.1", ok));
  const tport = (target.address() as { port: number }).port;
  const redirector = createServer((_q, s) => { s.writeHead(307, { location: `http://127.0.0.1:${tport}/api/connect/x/token` }); s.end(); });
  await new Promise<void>((ok) => redirector.listen(0, "127.0.0.1", ok));
  const rport = (redirector.address() as { port: number }).port;
  const res = await connect(["--url", `http://127.0.0.1:${rport}`, "--pair", "A".repeat(43)], fakeClaude("token").env);
  assert.equal(res.code, 1);
  assert.equal(res.err, `squad connect: could not send the token to squad at http://127.0.0.1:${rport}.\n`);
  assert.equal(hits, 0);
  target.close();
  redirector.close();
});

test("fixed errors: no claude, no token, a timeout, Windows, and a wrong use", async () => {
  const code = "A".repeat(43);
  const url = "http://127.0.0.1:9";
  const none = await connect(["--url", url, "--pair", code], fakeClaude("absent").env);
  assert.deepEqual([none.code, none.err], [1, "squad connect: claude is not installed here. Install Claude Code first (npm install -g @anthropic-ai/claude-code).\n"]);
  const fail = await connect(["--url", url, "--pair", code], fakeClaude("none").env);
  assert.deepEqual([fail.code, fail.err], [1, "squad connect: the sign-in did not finish. Nothing was sent.\n"]);
  const slow = fakeClaude("token");
  const late = await connect(["--url", url, "--pair", code], { ...slow.env, FAKE_TOKEN: "not-yet" }, { waitMs: 1500 });
  assert.deepEqual([late.code, late.err], [1, "squad connect: no sign-in in time. Start again from the web page.\n"]);
  const win = await connect(["--url", url, "--pair", code], fakeClaude("token").env, { platform: "win32" });
  assert.deepEqual([win.code, win.err], [1, "squad connect: this does not work on Windows yet. Use another sign-in way on the web page.\n"]);
  for (const args of [[], ["--url", url], ["--url", "http://squad.example.test", "--pair", code], ["--url", url, "--pair", "short"], ["--url", url, "--pair", code, "extra"], ["--url", url, "--pair", `-${code.slice(1)}`]]) {
    const bad = await connect(args, fakeClaude("token").env);
    assert.equal(bad.code, 2, args.join(" "));
    assert.match(bad.err, /^squad connect: /);
  }
});
