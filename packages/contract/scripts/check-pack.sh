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
  for (const k of ["call","findForbidden","maskSecrets"]) if (typeof m[k]!=="function") bad.push(k);
  if (typeof m.ROUTES!=="object"||m.ROUTES===null) bad.push("ROUTES");
  if (typeof m.ApiFailure!=="function") bad.push("ApiFailure");
  if (bad.length) { console.error("missing: "+bad); process.exit(1); }
  console.log(Object.keys(m).sort().join(","));
})'
echo "== types (no DOM, no node, strict)"
cat > t.ts <<'EOT'
import { call, type Api, type RouteName, type AccountView, type PassView, type LoginStart, type FetchLike } from "@squad/contract";
export type Shapes = [Api, RouteName, AccountView, PassView, LoginStart];
declare const f: FetchLike;
export const run = async (): Promise<readonly AccountView[]> => call(f, "https://squad.example.com", "listAccounts", {}, { credentials: "include" });
EOT
# An empty "types" list keeps @types/node and the DOM out, so a leak into the .d.ts files fails here.
echo '{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","strict":true,"noEmit":true,"types":[],"lib":["es2022"]},"files":["t.ts"]}' > tsconfig.json
"$repo/node_modules/.bin/tsc" -p tsconfig.json && echo "types ok"
