#!/usr/bin/env bash
# Typecheck the extension against a pi package that provides the types.
#
# Two ways the pi types get there:
#   - CI: `npm install` resolves the @earendil-works/pi-coding-agent peerDependency into node_modules/
#   - local dev without an install: symlink the globally installed pi package (node_modules/ is gitignored)
#
# Skip entirely with HANDOFF_SKIP_TYPECHECK=1 (offline, or a publish that already checked).
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${HANDOFF_SKIP_TYPECHECK:-0}" = "1" ]; then
  echo "typecheck skipped (HANDOFF_SKIP_TYPECHECK=1)"
  exit 0
fi

PKG="node_modules/@earendil-works/pi-coding-agent"

if [ ! -e "$PKG" ]; then
  PI_BIN="$(command -v pi || true)"
  PI_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${PI_BIN:-/nonexistent}" 2>/dev/null || true)"
  PI_PKG="${PI_REAL%/dist/*}"
  if [ -z "${PI_PKG:-}" ] || [ ! -d "$PI_PKG/dist" ]; then
    echo "no pi types: run 'npm install' (peer dep) or install pi globally so they can be symlinked" >&2
    exit 1
  fi
  mkdir -p node_modules/@earendil-works
  ln -sfn "$PI_PKG" "$PKG"
  ln -sfn "$PI_PKG/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
  ln -sfn "$PI_PKG/node_modules/typebox" node_modules/typebox
  ln -sfn "$PI_PKG/node_modules/@types" node_modules/@types
  echo "linked pi types from $PI_PKG"
fi

if [ -x node_modules/.bin/tsc ]; then
  TSC=(node_modules/.bin/tsc)
elif command -v tsc >/dev/null 2>&1; then
  TSC=(tsc)
elif command -v npx >/dev/null 2>&1; then
  TSC=(npx --yes -p typescript@5 tsc)
else
  echo "no typescript compiler found (tried node_modules/.bin/tsc, tsc, npx)" >&2
  exit 1
fi

"${TSC[@]}" -p tsconfig.check.json
echo "typecheck OK"
