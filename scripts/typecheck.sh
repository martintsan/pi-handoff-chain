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
  # Locate an installed pi release that ships the types. Candidates:
  #   1. $PI_PKG_DIR (explicit override)
  #   2. the realpath of the `pi` binary, if it lives inside the package (…/dist/…)
  #   3. ~/.pi/agent/install/releases/<latest>/node_modules/@earendil-works/pi-coding-agent
  PI_PKG="${PI_PKG_DIR:-}"
  if [ -z "$PI_PKG" ]; then
    PI_BIN="$(command -v pi || true)"
    PI_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${PI_BIN:-/nonexistent}" 2>/dev/null || true)"
    case "$PI_REAL" in */dist/*) PI_PKG="${PI_REAL%/dist/*}" ;; esac
  fi
  if [ -z "$PI_PKG" ] || [ ! -d "$PI_PKG/dist" ]; then
    PI_PKG="$(ls -d "${HOME}"/.pi/agent/install/releases/*/node_modules/@earendil-works/pi-coding-agent 2>/dev/null | sort -V | tail -1)"
  fi
  if [ -z "${PI_PKG:-}" ] || [ ! -d "$PI_PKG/dist" ]; then
    echo "no pi types: run 'npm install' (peer dep) or install pi globally so they can be symlinked" >&2
    exit 1
  fi
  ROOT="$(cd "$PI_PKG/../.." && pwd)"   # releases/<v>/node_modules
  mkdir -p node_modules/@earendil-works
  ln -sfn "$PI_PKG" "$PKG"
  for dep in pi-ai pi-tui pi-agent-core; do
    [ -e "$ROOT/@earendil-works/$dep" ] && ln -sfn "$ROOT/@earendil-works/$dep" "node_modules/@earendil-works/$dep"
  done
  [ -e "$ROOT/typebox" ] && ln -sfn "$ROOT/typebox" node_modules/typebox
  [ -e "$ROOT/@types" ] && ln -sfn "$ROOT/@types" node_modules/@types
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
