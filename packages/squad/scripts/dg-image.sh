#!/usr/bin/env bash
# Builds a doppelganger supervisor image that runs this checkout's squad, for development.
# doppelganger's `dg` runs it with DG_IMAGE=<name> (its own hook for a local build); the tag must be the
# `version` in that project's doppelganger.toml, which is `rc` by default.
#   packages/squad/scripts/dg-image.sh [name:tag] [base image]
# Run it again after every change: the image holds a packed copy, not a link to this folder.
set -euo pipefail
tag=${1:-squad-local/doppelganger-supervisor:rc}
base=${2:-ghcr.io/hyhilman/doppelganger-supervisor:rc}
repo=$(cd "$(dirname "$0")/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$repo"
tgz=$(npm pack -w squad --pack-destination "$work" --silent | tail -1)
mv "$work/$tgz" "$work/squad.tgz"
# The base image runs as `node`; only the copy of squad in it changes, then it drops back to `node`.
docker build -q -t "$tag" --build-arg BASE="$base" -f - "$work" <<'EOF'
ARG BASE
FROM ${BASE}
USER root
COPY squad.tgz /tmp/squad.tgz
RUN rm -rf /opt/doppelganger/node_modules/squad \
 && mkdir /opt/doppelganger/node_modules/squad \
 && tar -xzf /tmp/squad.tgz -C /opt/doppelganger/node_modules/squad --strip-components=1 --no-same-owner \
 && rm /tmp/squad.tgz
USER node
EOF
echo "built $tag from $base with squad $(node -p 'require("./packages/squad/package.json").version') at $(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo ' plus local edits')"
