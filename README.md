# pi-handoff-chain

**Kill & Handoff protocol for [pi](https://github.com/badlogic/pi-mono)** — checkpointed handoffs, watermark-enforced landing, and fresh-session task chaining for solo developers running multi-agent workflows.

## The problem

LLM context windows are finite, expensive, and degrade as they fill up. Long-lived agent sessions rot: you pay to re-send stale noise, and when the window finally fills, the session dies mid-task with nothing written down.

## The protocol

The unit of work is one *session-sized task*, not a whole project. Each agent:

1. **Works with an off-disk diary** — `checkpoint` saves an in-progress `HANDOFF.md` after every milestone (a save file, not an end-of-exam name field)
2. **Gets force-landed at the watermark** — a watchdog monitors context usage every turn; past the threshold it injects a mandatory "stop new work, land the plane" directive
3. **Ends on a commit, not a conversation** — `finish` writes the final handoff document and returns `terminate: true`, so the session stops immediately with zero "victory lap" tokens
4. **Chains to a fresh brain** — `/next` starts a brand-new session seeded with the handoff document, with zero memory of the predecessor

> Files are the only reliable memory. Context is disposable.

## Install

```bash
pi install git:github.com/martintsan/pi-handoff-chain
```

Verify: start a new pi session — `finish`, `checkpoint` tools and `/next`, `/handoff` commands are available in every project.

Remove:

```bash
pi remove git:github.com/martintsan/pi-handoff-chain
```

## What you get

### `finish` tool (terminal)

Call as the **final action** of a task. Writes a structured `HANDOFF.md` (status / summary / decisions / artifacts / next task / blockers) to the project root, then terminates the session immediately via `terminate: true`.

Three legal ways to land:

| status | meaning |
|---|---|
| `done` | task contract fulfilled |
| `partial` | watermark hit or time's up — remainder fully described in `next_task` |
| `blocked` | needs a human — the chain stops and waits |

### `checkpoint` tool (non-terminal)

Same document format, no termination. Call after every meaningful milestone on long tasks, before and after risky operations. If the session dies at any instant, the on-disk handoff is at most one step stale.

### Watermark watchdog

On every `turn_end`, current context usage is checked (`ctx.getContextUsage()`). At or above **60%** of the model's window, the extension steers a directive into the conversation:

> STOP starting new work. Commit finished artifacts. Call `finish` with `partial` and a self-contained `next_task`. Do not ask questions; land the plane.

Tune with `HANDOFF_WATERMARK` (e.g. `0.7`). Fires once per agent run.

### `/next` command

Reads `HANDOFF.md`, asks for human approval, then `ctx.newSession()`:
- records the previous session as parent (traceability)
- injects the handoff document as the new session's initial context
- sends a kickoff prompt ("you are a fresh agent with zero memory; verify artifacts; execute Next task; end with `finish`")

Pass custom kickoff text: `/next focus on the failing tests first`

### `/handoff` command

Preview the current `HANDOFF.md`.

## Headless mode (optional driver)

`scripts/agent-chain.sh` runs the whole chain unattended:

```bash
./scripts/agent-chain.sh TASK.md
```

Each turn is a fresh `pi -p` process (clean context). The agent must `finish` → process exits → driver extracts the next task → next process. Protections:

- **Recovery spell**: if a turn exits without a handoff, the driver resumes (`pi -c`) and instructs the agent to reconstruct the handoff from the (possibly compacted) session before stopping
- **Circuit breaker**: `MAX_TURNS` (default 10) caps runaway chains
- **Blocked detection**: `blocked` status halts the chain for human review

## Task-writing discipline (the actual skill)

This plugin makes handoffs mechanical; it cannot make tasks small enough. Before starting a task, ensure:

1. **Single artifact** — one identifiable deliverable per session
2. **Machine-verifiable** — a validator can judge it (tests pass, schema passes, count met)
3. **Context budget ≤ 50%** — leave headroom

"Complete the project" is not a task. A project is a DAG of session-sized tickets whose state lives on disk. Decompose first, or the chain will stall.

## Configuration

| env var | default | meaning |
|---|---|---|
| `HANDOFF_WATERMARK` | `0.6` | context usage fraction that triggers forced landing |
| `MAX_TURNS` | `10` | (driver script) circuit-breaker cap |
| `LOG_DIR` | `.chain-logs` | (driver script) per-turn log directory |

## Credits

Protocol pattern inspired by the solo-founder multi-agent workflow behind [HAN•GL](https://hangl.app) (kill the session after the artifact lands; hand off through documents; the human keeps the approval gates).

## License

MIT
