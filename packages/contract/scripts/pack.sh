#!/usr/bin/env bash
# Packs the contract as the SDK tarball `squad-contract-<version>.tgz` into <dest dir> and prints its name.
set -euo pipefail
dest=${1:?usage: pack.sh <dest dir>}
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
mkdir -p "$dest"
dest=$(cd "$dest" && pwd)
cd "$here"
# A stale file from an older build must not ship.
rm -rf dist
"$repo/node_modules/.bin/tsc" -p tsconfig.publish.json
# The version is squad's, so one release number names every tarball. The licence is the repo's (MIT).
node -e '
const fs = require("node:fs");
const v = JSON.parse(fs.readFileSync("../squad/package.json", "utf8")).version;
const pkg = {
  name: "@squad/contract",
  version: v,
  type: "module",
  description: "Typed client and shapes for the squad HTTP API",
  license: "MIT",
  exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
  files: ["*.js", "*.d.ts", "README.md", "LICENSE"],
};
fs.writeFileSync("dist/package.json", JSON.stringify(pkg, null, 2) + "\n");
'
cp "$repo/LICENSE" dist/LICENSE
cat > dist/README.md <<'EOT'
# @squad/contract

A typed client for the squad HTTP API. It has no dependency and needs no DOM or Node types.

## Install

Use the tarball from a squad release:

    npm install https://github.com/OWNER/squad/releases/download/vVERSION/squad-contract-VERSION.tgz

## Use

    import { call, ApiFailure } from "@squad/contract";

    // The browser sends the squad session cookie because of credentials: "include".
    const accounts = await call(fetch, "https://squad.example.com", "listAccounts", {}, { credentials: "include" });
    try {
      await call(fetch, "https://squad.example.com", "setEnabled", { params: { runner: "codex", name: "a" }, body: { enabled: false } }, { credentials: "include" });
    } catch (e) {
      if (e instanceof ApiFailure) console.log(e.status, e.body.error);
    }

## Same site only

The session cookie is `SameSite=Lax`. Your app must be on the same site as squad
(for example app.example.com and squad.example.com). A different site will not work.

The squad server must list your origin, exactly and over https:

    SQUAD_WEB_API_ORIGINS=https://app.example.com

The user must be signed in to squad first (open `/auth/login` on the squad URL). A call without a
session answers 401.
EOT
cd dist && name=$(npm pack --pack-destination "$dest" --silent | tail -1)
echo "$name"
