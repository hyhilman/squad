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
echo "== exports"; node -e 'import("squad").then(m=>console.log(Object.keys(m).sort().join(",")))'
echo "== squad --help"; npx squad --help 2>&1 | head -5 || true
echo "== squad list"; SQUAD_HOME="$home" npx squad list; echo "exit $?"
echo "== image build pi (dry run)"; SQUAD_DRY_RUN=1 SQUAD_HOME="$home" npx squad image build pi
echo "== image build runs from the installed package (fake docker prints its cwd and the context)"
printf '#!/bin/sh\npwd; ls -d images/pi/Dockerfile\n' > "$work/fake-docker"; chmod +x "$work/fake-docker"
SQUAD_DOCKER="$work/fake-docker" SQUAD_HOME="$home" npx squad image build pi 2>&1 | grep -v Warning | grep -v trace-warnings
echo "== bundled paths from the installed dist"
node -e 'import("./node_modules/squad/dist/paths.js").then(m=>{for (const r of ["webapp","images","assets/codex-config.toml"]) console.log(r, "->", m.bundledPath(r))})'
echo "== files exist"; ls node_modules/squad/dist/webapp/index.html node_modules/squad/dist/images/entry.sh node_modules/squad/dist/assets/codex-config.toml
echo "== types"; echo 'import type { PassRequest, PassResult, RunDeps, Failure, FailureKind, Usage, AccountRow, Log, Effort, SkillRef, ExtraMount, TurnOptions } from "squad"; export const x: [PassRequest, PassResult, RunDeps, Failure, FailureKind, Usage, AccountRow, Log, Effort, SkillRef, ExtraMount, TurnOptions] | undefined = undefined;' > t.ts
"$repo/node_modules/.bin/tsc" --noEmit --module nodenext --moduleResolution nodenext --strict --skipLibCheck --types node --typeRoots "$repo/node_modules/@types" t.ts && echo "types ok"
echo "== webapp holds the built app only"
test -f node_modules/squad/dist/webapp/index.html
stray=$(cd node_modules/squad/dist/webapp && find . \( -name '*.d.ts' -o -name '*.ts' -o -name '*.js.map' -o \( -name '*.js' -a -not -path './_astro/*' \) \) | head)
if [ -n "$stray" ]; then echo "code in dist/webapp:"; echo "$stray"; exit 1; fi
echo "webapp ok"
