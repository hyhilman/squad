import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { call, callStream } from "./client.ts";
import { nodeSocketFetch } from "./node.ts";

test("nodeSocketFetch dials a unix socket: JSON, 204, refusals and an ndjson stream through call and callStream", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sock = join(dir, "s.sock");
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      if (req.url === "/api/accounts") return res.writeHead(200, { "content-type": "application/json" }).end('[{"account":"pi/a"}]');
      if (req.method === "DELETE") return res.writeHead(204).end();
      if (req.url === "/api/passes/nope") return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"type":"started","passId":"P"}\n{"type":"out');
      setTimeout(() => res.end('put","chunk":"x"}\n{"type":"result","result":{"passId":"P"}}\n'), 20);
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  t.after(() => server.close());
  const f = nodeSocketFetch(sock);
  const headers = { authorization: "Bearer tok" };
  assert.deepEqual(await call(f, "http://squad", "serveAccounts", {}, { headers }), [{ account: "pi/a" }]);
  assert.equal(await call(f, "http://squad", "closeConversation", { params: { id: "c" } }, { headers }), undefined);
  await assert.rejects(call(f, "http://squad", "passStatus", { params: { passId: "nope" } }, { headers }), (e: unknown) => (e as { status: number }).status === 404);
  const lines: unknown[] = [];
  for await (const l of callStream(f, "http://squad", "sendTurn", { params: { id: "c" }, body: { message: "m", identity: { name: "n", email: "e@x" } } }, { headers })) lines.push(l);
  assert.deepEqual(lines, [{ type: "started", passId: "P" }, { type: "output", chunk: "x" }, { type: "result", result: { passId: "P" } }]);
  assert.deepEqual(seen.map((s) => [s.method, s.url, s.auth]), [
    ["GET", "/api/accounts", "Bearer tok"],
    ["DELETE", "/api/conversations/c", "Bearer tok"],
    ["GET", "/api/passes/nope", "Bearer tok"],
    ["POST", "/api/conversations/c/turns", "Bearer tok"],
  ]);
  assert.equal(seen[3]!.body, '{"message":"m","identity":{"name":"n","email":"e@x"}}');
});

test("nodeSocketFetch: a socket with nobody behind it rejects", async () => {
  const f = nodeSocketFetch(join(tmpdir(), "no-such-squad.sock"));
  await assert.rejects(f("http://squad/api/accounts", { method: "GET", headers: {}, credentials: "same-origin" }));
});
