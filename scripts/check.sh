#!/usr/bin/env bash
set -eu
task_root=$(cd "$(dirname "$0")/.." && pwd)
if command -v cygpath >/dev/null 2>&1; then task_root=$(cygpath -am "$task_root"); fi
docker info >/dev/null
export MSYS_NO_PATHCONV=1
docker run --rm --mount "type=bind,source=$task_root,target=/source,readonly" \
  node:24-bookworm-slim sh -c '
    mkdir /work
    cp /source/package.json /source/tsconfig.json /work/
    cp -r /source/src /source/test /work/
    cd /work
    npm install --ignore-scripts --no-audit --no-fund --package-lock=false &&
    npx --no-install tsc --noEmit && npm test
  '
