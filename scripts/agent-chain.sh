#!/usr/bin/env bash
# agent-chain.sh — unattended "kill the process, hand off through documents" driver
# (pairs with the handoff-chain.ts pi extension)
#
# Usage:
#   ./scripts/agent-chain.sh TASK.md            # start the chain from TASK.md's first task
#   LANE=i18n-fix ./scripts/agent-chain.sh TASK.md
#
# Every turn:
#   1. start a brand-new `pi -p` process with the kickoff (clean context, no baggage)
#   2. the agent must call the finish tool → its lane document lands
#      (.pi/handoff/<lane>.md) + terminate:true → the process exits cleanly
#      (the victory lap is killed, no tokens wasted)
#   3. the driver reads that lane's "Next task": non-empty → next process; empty → chain ends
#   4. exiting without writing the lane document is a protocol violation: the chain stops
#      and warns (never blindly continues) after one recovery attempt
#
# The whole run is pinned to one lane via HANDOFF_LANE so parallel drivers in the same
# checkout cannot overwrite each other's handoff.

set -euo pipefail

TASK_FILE="${1:-TASK.md}"
LANE="${LANE:-$(basename "$TASK_FILE" .md | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//;s/-*$//')}"
LANE_FILE=".pi/handoff/${LANE}.md"
INDEX_FILE="HANDOFF.md"
export HANDOFF_LANE="$LANE"
MAX_TURNS="${MAX_TURNS:-10}"     # circuit breaker, stops a runaway chain
LOG_DIR="${LOG_DIR:-.chain-logs}"
mkdir -p "$LOG_DIR"

[[ -f "$TASK_FILE" ]] || { echo "missing start task file: $TASK_FILE" >&2; exit 1; }

# The extension writes the lane file; a missing one means the turn never landed.
lane_mtime() { [[ -f "$LANE_FILE" ]] && stat -f %m "$LANE_FILE" 2>/dev/null || stat -c %Y "$LANE_FILE" 2>/dev/null || echo 0; }

kickoff="$(cat "$TASK_FILE")"
turn=0

while [[ -n "$kickoff" ]]; do
  turn=$((turn + 1))
  if (( turn > MAX_TURNS )); then
    echo "⚠️  hit the MAX_TURNS=$MAX_TURNS cap, chain stopped." >&2
    exit 2
  fi

  echo "═══════ Turn $turn · lane $LANE ═══════"
  before="$(lane_mtime)"

  # A fresh process = a fresh session = clean context. --name makes it resumable later.
  pi --name "chain-T${turn}" -p "$kickoff" 2>&1 | tee "$LOG_DIR/turn-${turn}.log"

  if [[ "$(lane_mtime)" == "$before" ]]; then
    echo "⚠️  Turn $turn wrote no lane document — trying the recovery spell (resume and rebuild the handoff)..." >&2
    pi --name "chain-T${turn}-recover" -c -p "Your previous run was interrupted and wrote no handoff document. From what is already in this session (it may have been compacted): rebuild ${LANE_FILE} right now — Status, what was done, artifact paths, and the unfinished remainder as 'Next task' (assume the agent taking over has zero memory of this session). Finish by calling the finish tool with lane: \"${LANE}\". Do not start new work; you only rebuild the handoff." 2>&1 | tee -a "$LOG_DIR/turn-${turn}-recover.log" || true
  fi

  DOC="$LANE_FILE"
  [[ -f "$DOC" ]] || DOC="$INDEX_FILE"   # pre-lane installs wrote a single HANDOFF.md
  if [[ ! -f "$DOC" ]]; then
    echo "🛑 recovery failed: still no handoff document — chain stopped, needs a human." >&2
    exit 3
  fi

  status="$(awk '/^## Status$/{getline; print; exit}' "$DOC")"
  if [[ "$status" == "blocked" ]]; then
    echo "🛑 Turn $turn is marked blocked — chain stopped, needs a human." >&2
    exit 4
  fi

  # extract the "## Next task" section
  kickoff="$(awk '/^## Next task/{flag=1;next}/^## /{flag=0}flag' "$DOC" | sed '/(none/d;/^$/d')"

  if [[ -z "$kickoff" ]]; then
    echo "✅ chain finished after $turn turn(s), no next task in lane $LANE."
  else
    echo "→ next task: ${kickoff:0:80}..."
  fi
done
