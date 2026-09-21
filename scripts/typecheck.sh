#!/usr/bin/env bash
# Typecheck the extension against the locally installed pi package.
# Creates throwaway symlinks into the global pi install (node_modules is gitignored),
# then runs tsc with tsconfig.check.json.
set -euo pipefail

cd "$(dirname "$0")/.."

PI_BIN="$(command -v pi || true)"
PI_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$PI_BIN" 2>/dev/null || true)"
# the bin resolves into <pkg>/dist/... — cut everything from /dist/ onward
PI_PKG="${PI_REAL%/dist/*}"
if [ -z "${PI_PKG:-}" ] || [ ! -d "$PI_PKG/dist" ]; then
  echo "could not resolve the pi package dir — install @earendil-works/pi-coding-agent first" >&2
  exit 1
fi

mkdir -p node_modules/@earendil-works
ln -sfn "$PI_PKG" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_PKG/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -sfn "$PI_PKG/node_modules/typebox" node_modules/typebox
ln -sfn "$PI_PKG/node_modules/@types" node_modules/@types

tsc -p tsconfig.check.json
echo "typecheck OK (against $PI_PKG)"
