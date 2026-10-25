#!/usr/bin/env bash
# Packs squad, installs the tarball into a fresh folder and exercises it. Not part of `npm test`.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
work=$(mktemp -d)
home=$(mktemp -d)
trap 'rm -rf "$work" "$home"' EXIT
cd "$repo"
tgz=$(npm pack -w squad --pack-destination "$work" --silent | tail -1)
echo "== tarball: $tgz"; tar -tzf "$work/$tgz" | sed 's/^/   /' | awk 'NR<=12 || /vendor\/contract\/index|images\/entry|webapp\/index|assets/'
mkdir "$work/app"; cd "$work/app"
echo '{"name":"app","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund "$work/$tgz" >/dev/null
echo "== exports"; node -e 'import("squad").then(m=>{const want=["runPass","open","send","close","listAccounts","listAccountsWithServes","servesOf","openHome"];const miss=want.filter(k=>typeof m[k]!=="function");console.log(Object.keys(m).sort().join(","));if(miss.length){console.error("missing exports: "+miss);process.exit(1)}})'
echo "== squad --help"; npx squad --help 2>&1 | head -5 || true
echo "== squad list"; SQUAD_HOME="$home" npx squad list; echo "exit $?"
echo "== image build pi (dry run)"; SQUAD_DRY_RUN=1 SQUAD_HOME="$home" npx squad image build pi
echo "== image build runs from the installed package (fake docker prints its cwd and the context)"
printf '#!/bin/sh\npwd; ls -d images/pi/Dockerfile\n' > "$work/fake-docker"; chmod +x "$work/fake-docker"
SQUAD_DOCKER="$work/fake-docker" SQUAD_HOME="$home" npx squad image build pi 2>&1 | grep -v Warning | grep -v trace-warnings
echo "== bundled paths from the installed dist"
node -e 'import("./node_modules/squad/dist/paths.js").then(m=>{for (const r of ["webapp","images","assets/codex-config.toml"]) console.log(r, "->", m.bundledPath(r))})'
echo "== the connect command names the installed version"
node -e 'import("./node_modules/squad/dist/web/connect.js").then(m=>{const v=m.squadVersion(),want=require("./node_modules/squad/package.json").version;console.log("version",v);if(v!==want){console.error("version mismatch");process.exit(1)}})'
echo "== squad connect: a wrong use is exit 2 and makes no home"
set +e; out=$(cd "$work" && npx --prefix "$work/app" squad connect --url http://example.com --pair x 2>&1); rc=$?; set -e
echo "$out" | head -1; [ "$rc" = 2 ] || { echo "exit $rc, want 2"; exit 1; }; [ ! -e "$work/.squad" ] || { echo "connect made a home"; exit 1; }
echo "== npx of the tarball URL runs connect, as the web page tells people to (a wrong use: exit 2)"
# The page gives an https URL; a local http server stands in for the release. (npx runs a bare file path as a program, so a path would not test the same thing.)
node -e 'const h=require("http"),f=require("fs");const s=h.createServer((q,r)=>{r.end(f.readFileSync(process.argv[1]))}).listen(0,"127.0.0.1",()=>{f.writeFileSync(process.argv[2],String(s.address().port))})' "$work/$tgz" "$work/port" & srv=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
mkdir "$work/npx"
set +e; out=$(cd "$work/npx" && npx -y "http://127.0.0.1:$(cat "$work/port")/$tgz" connect --url http://example.com --pair x 2>&1); rc=$?; set -e
kill "$srv"
echo "$out" | grep "squad connect" | head -1; [ "$rc" = 2 ] || { echo "exit $rc, want 2"; exit 1; }
echo "== squad serve from the installed package: listens on a socket, SIGTERM exits 0"
SQUAD_HOME="$home" node node_modules/squad/dist/cli/squad.js serve --socket "$home/s.sock" > "$work/serve.out" 2>/dev/null & srv=$!
for _ in $(seq 50); do grep -q "listening on" "$work/serve.out" 2>/dev/null && break; sleep 0.1; done
cat "$work/serve.out"; [ -S "$home/s.sock" ] || { echo "no socket"; exit 1; }
kill -TERM "$srv"; set +e; wait "$srv"; rc=$?; set -e
[ "$rc" = 0 ] || { echo "serve exit $rc, want 0"; exit 1; }; [ ! -e "$home/s.sock" ] || { echo "socket left"; exit 1; }
echo "serve ok"
echo "== files exist"; ls node_modules/squad/dist/webapp/index.html node_modules/squad/dist/images/entry.sh node_modules/squad/dist/assets/codex-config.toml
echo "== types"; echo 'import type { PassRequest, PassResult, RunDeps, Failure, FailureKind, Usage, AccountRow, Log, Effort, SkillRef, ExtraMount, TurnOptions, Conversation, OpenRequest, TurnResult, AccountInfo, ServedProvider } from "squad"; export const x: [PassRequest, PassResult, RunDeps, Failure, FailureKind, Usage, AccountRow, Log, Effort, SkillRef, ExtraMount, TurnOptions, Conversation, OpenRequest, TurnResult, AccountInfo, ServedProvider] | undefined = undefined;' > t.ts
"$repo/node_modules/.bin/tsc" --noEmit --module nodenext --moduleResolution nodenext --strict --skipLibCheck --types node --typeRoots "$repo/node_modules/@types" t.ts && echo "types ok"
echo "== webapp holds the built app only"
test -f node_modules/squad/dist/webapp/index.html
stray=$(cd node_modules/squad/dist/webapp && find . \( -name '*.d.ts' -o -name '*.ts' -o -name '*.js.map' -o \( -name '*.js' -a -not -path './_astro/*' \) \) | head)
if [ -n "$stray" ]; then echo "code in dist/webapp:"; echo "$stray"; exit 1; fi
echo "webapp ok"
