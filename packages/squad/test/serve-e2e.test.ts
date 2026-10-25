// The peer's end-to-end check (rc.6 spec, section 6), with the real CLI in child processes: a
// throwaway home, add-key a pi account, token add, `squad serve --socket` with SQUAD_DOCKER at the
// fake docker (it streams a captured pi stream), one pass and one conversation through the SDK, then
// SIGTERM, and serve exits 0.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, callStream, type PassLine, type TurnLine } from "@squad/contract";
import { nodeSocketFetch } from "@squad/contract/node";
import { makeFakeDocker } from "./fake-docker.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "squad.ts");

test("e2e: add-key, token add, serve on a socket, one pass and one conversation through the SDK, SIGTERM, exit 0", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "e2e-"));
  const home = join(root, "home");
  const work = join(root, "work");
  const repo = join(work, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const keyFile = join(root, "auth.json");
  writeFileSync(keyFile, '{"fake":"not-a-real-key"}');
  const fake = makeFakeDocker(join(root, "bin"));
  const env = { ...process.env, SQUAD_HOME: home, SQUAD_DOCKER: fake.path, SQUAD_STOP_GRACE_S: "2", SQUAD_SERVE_DRAIN_S: "2" };
  const squad = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", cwd: root });

  const added = squad("add-key", "pi/acct-one", "--from", keyFile);
  assert.equal(added.status, 0, added.stderr);
  const tok = squad("token", "add", "dg-test", "--accounts", "pi/acct-one", "--roots", work);
  assert.equal(tok.status, 0, tok.stderr);
  assert.match(tok.stdout, /^sqd_[A-Za-z0-9_-]{43}\n$/, "only the token on stdout");
  const token = tok.stdout.trim();

  const sock = join(home, "x.sock");
  const serve = spawn(process.execPath, [CLI, "serve", "--socket", sock], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (serve.exitCode === null) serve.kill("SIGKILL");
  });
  let stderr = "";
  serve.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => serve.on("exit", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    let out = "";
    serve.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      if (out.includes("listening on")) resolve();
    });
    serve.on("exit", () => reject(new Error(`serve exited early: ${stderr}`)));
  });

  const f = nodeSocketFetch(sock);
  const headers = { authorization: `Bearer ${token}` };
  const identity = { name: "Doppelganger", email: "dg@example.com" };

  const accounts = await call(f, "http://squad", "serveAccounts", {}, { headers });
  assert.deepEqual(accounts.map((a) => a.account), ["pi/acct-one"]);

  const passLines: PassLine[] = [];
  for await (const l of callStream(f, "http://squad", "startPass", { body: { runner: "pi", account: "pi/acct-one", model: "opencode-go/hy4-preview", prompt: "say ok", cwd: repo, caller: { flow: "fix", action: "fix:pi" }, identity } }, { headers })) passLines.push(l);
  assert.equal(passLines[0]!.type, "started");
  const passResult = passLines.at(-1)!;
  assert.equal(passResult.type, "result");
  if (passResult.type === "result") {
    assert.equal(passResult.result.failure, undefined);
    assert.ok(passResult.result.text.length > 0);
  }

  const conv = await call(f, "http://squad", "openConversation", { body: { runner: "pi", account: "pi/acct-one", model: "opencode-go/hy4-preview", cwd: repo, caller: { flow: "chat", action: "chat:pi" }, identity } }, { headers });
  const turnLines: TurnLine[] = [];
  for await (const l of callStream(f, "http://squad", "sendTurn", { params: { id: conv.id }, body: { message: "hello", identity } }, { headers })) turnLines.push(l);
  const turnResult = turnLines.at(-1)!;
  assert.equal(turnResult.type, "result");
  if (turnResult.type === "result") assert.equal(turnResult.result.failure, undefined);
  assert.equal(await call(f, "http://squad", "closeConversation", { params: { id: conv.id } }, { headers }), undefined);

  serve.kill("SIGTERM");
  assert.equal(await exited, 0, stderr);
  assert.ok(!existsSync(sock), "the socket is gone");
  assert.ok(!stderr.includes(token), "the token is in no log line");
});
