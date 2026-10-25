#!/usr/bin/env bash
# Packs the SDK, installs it into a fresh folder and checks the runtime and the types. Not part of `npm test`.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tgz=$("$here/pack.sh" "$work/out")
echo "== tarball: $tgz"; tar -tzf "$work/out/$tgz" | sed 's/^/   /'
mkdir "$work/app"; cd "$work/app"
echo '{"name":"app","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund "$work/out/$tgz" >/dev/null
echo "== exports"
node -e 'import("@squad/contract").then(m=>{
  const bad=[];
  for (const k of ["call","callStream","findForbidden","maskSecrets"]) if (typeof m[k]!=="function") bad.push(k);
  for (const k of ["ROUTES","SERVE_ROUTES"]) if (typeof m[k]!=="object"||m[k]===null) bad.push(k);
  if (typeof m.ApiFailure!=="function") bad.push("ApiFailure");
  if (bad.length) { console.error("missing: "+bad); process.exit(1); }
  console.log(Object.keys(m).sort().join(","));
})'
echo "== node entry: nodeSocketFetch dials a unix socket"
node --input-type=module -e '
import { createServer } from "node:http";
import { call } from "@squad/contract";
import { nodeSocketFetch } from "@squad/contract/node";
const sock = process.cwd() + "/t.sock";
const s = createServer((q, r) => r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ account: "pi/a", auth: q.headers.authorization }])));
await new Promise((ok) => s.listen(sock, ok));
const got = await call(nodeSocketFetch(sock), "http://squad", "serveAccounts", {}, { headers: { authorization: "Bearer x" } });
s.close();
if (got[0].auth !== "Bearer x") { console.error("bad answer", got); process.exit(1); }
console.log("node entry ok");
'
echo "== types (no DOM, no node, strict)"
cat > t.ts <<'EOT'
import { call, callStream, type Api, type RouteName, type AccountView, type PassView, type LoginStart, type FetchLike, type ServeApi, type ServePassBody, type PassLine, type TurnLine, type PassStatus, type PassResult, type TurnResult, type Conversation, type ServeAccountView } from "@squad/contract";
import { nodeSocketFetch } from "@squad/contract/node";
export type Shapes = [Api, RouteName, AccountView, PassView, LoginStart, ServeApi, PassLine, TurnLine, PassStatus, PassResult, TurnResult, Conversation, ServeAccountView];
declare const f: FetchLike;
export const run = async (): Promise<readonly AccountView[]> => call(f, "https://squad.example.com", "listAccounts", {}, { credentials: "include" });
// The node entry names no Node type, so it type-checks here too.
export const serve = async (body: ServePassBody): Promise<string | undefined> => {
  for await (const l of callStream(nodeSocketFetch("/tmp/s.sock"), "http://squad", "startPass", { body }, { headers: { authorization: "Bearer t" } })) if (l.type === "result") return l.result.text;
  return undefined;
};
EOT
# An empty "types" list keeps @types/node and the DOM out, so a leak into the .d.ts files fails here.
echo '{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","strict":true,"noEmit":true,"types":[],"lib":["es2022"]},"files":["t.ts"]}' > tsconfig.json
"$repo/node_modules/.bin/tsc" -p tsconfig.json && echo "types ok"
