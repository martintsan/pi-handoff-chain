# pi-handoff-chain

**Kill & Handoff protocol for [pi](https://github.com/badlogic/pi-mono)** — checkpointed handoffs, watermark-enforced landing, and fresh-session task chaining for solo developers running multi-agent workflows.

## The problem

LLM context windows are finite, expensive, and degrade as they fill up. Long-lived agent sessions rot: you pay to re-send stale noise, and when the window finally fills, the session dies mid-task with nothing written down.

## The protocol

The unit of work is one *session-sized task*, not a whole project. Each agent:

1. **Saves at milestones — and resets** — `checkpoint` writes an in-progress `HANDOFF.md` **and clears the context that produced it** (a save *and* a restart, not a log line)
2. **Gets force-landed at the watermark** — a watchdog monitors context usage every turn; past the threshold it injects a mandatory "stop new work, land the plane" directive
3. **Ends on a commit, not a conversation** — `finish` writes the final handoff document and returns `terminate: true`, so the session stops immediately with zero "victory lap" tokens
4. **Chains to a fresh brain** — `/next` starts a brand-new session seeded with the handoff document, with zero memory of the predecessor

> Files are the only reliable memory. Context is disposable.

## Context reset engine

A checkpoint that only writes a file is a checkpoint that never gets used. If the context survives the write, the agent keeps dragging every dead end, stale file read, and abandoned plan into the next mile of the task — and when it eventually re-reads `HANDOFF.md`, the fresh document has to compete with a screenful of contradicting noise. So `checkpoint` is a **context reset point**: the snapshot must actually *replace* the context.

`checkpoint` takes `reset`:

| reset | what happens | when it happens |
|---|---|---|
| `"compact"` (default) | This session's context is cleared and **replaced by the document you just wrote**. Then the agent is nudged to keep working from it. | at `turn_end`, after the tool result is persisted |
| `"session"` | Hard cut: a brand-new session (`ctx.newSession()`) seeded with the document; the same task continues there with zero inherited context. | at `agent_settled`, via `/cut` |
| `"none"` | Only the file is written — the old behaviour. | never |

The `compact` reset is **free**: instead of paying an LLM to summarize the old context, the extension answers pi's `session_before_compact` event with the handoff document itself as the compaction summary. Nothing is summarized, nothing is invented — the document *is* the new context, with pi's recent-entry boundary kept on top of it so the immediate working set survives.

`reset: "session"` exists for when even the kept tail is too dirty: same task, brand-new brain, `parentSession` recorded for traceability. Same machinery as `/next`, different intent — `/next` chains to the *next* task, `/cut` wipes and *continues* this one.

### Timing (measured, not assumed)

Getting the reset to actually land took three fixes worth knowing about:

- **Never reset from inside the tool's `execute`.** `ctx.compact()` aborts the current run first; calling it while the tool batch is still live takes the tool's own result down with it. The reset is armed in `execute` and fired at `turn_end`, when results are already on disk.
- **The compaction pipeline runs *after* `agent_settled`.** A reset that reads its document out of the same state that the settle handler clears arrives at `session_before_compact` with nothing to inject — silently falling back to pi's default lossy summary. The document is parked in its own variable (`resetSummary`) that only the compaction handlers consume.
- **You cannot send a message while compaction is in flight.** `sendUserMessage` throws `Cannot submit a prompt while compaction is in progress`, so the post-reset resume (and the auto-`/cut` dispatch) waits on a `whenIdle()` poll instead of a `setTimeout(0)`.

A circuit breaker (`HANDOFF_MAX_RESETS`, default 12) stops an agent that checkpoints every turn from ping-ponging reset → resume → reset forever.

In headless mode (`pi -p`) the reset is skipped by design: one process per turn already *is* a context boundary.

## The switch: `enable_handoff`

One key in pi's settings turns the whole protocol off without uninstalling anything.

| priority | source | example |
|---|---|---|
| 1 (highest) | `HANDOFF_ENABLED` env var | `HANDOFF_ENABLED=false pi -p "..."` — one run |
| 2 | project `.pi/settings.json` | `{ "enable_handoff": false }` |
| 3 | global `~/.pi/agent/settings.json` | `{ "enable_handoff": true }` |
| 4 | default | `true` (key absent) |

Values are tolerant of hand-editing: `true`/`false`, `"on"`/`"off"`, `"yes"`/`"no"`, `"1"`/`"0"`.

pi exposes no settings API to extensions, so the extension reads and merges those files itself, and writes with a read-modify-write that leaves every other key in the file intact.

**Off means absent, not "registered but refusing":**

- `finish` and `checkpoint` are dropped from the active tool set — the model never sees them, and their `promptSnippet` / `promptGuidelines` text disappears from the system prompt with them
- every event handler early-returns: no context resets, no watermark steering, no auto-`/cut`
- `/next` and `/cut` refuse to chain

Drive it from inside pi:

```
/handoff              # show HANDOFF.md (unchanged)
/handoff status       # resolved value + which layer is winning, per source
/handoff off          # write enable_handoff:false → global settings
/handoff on project   # write it to ./.pi/settings.json instead
```

Verified behaviour: with the key `false`, the model lists only `read, bash, edit, write` — no handoff tools — and `/handoff off` → `/handoff on project` flips it live while preserving unrelated keys such as `theme`.

The switch is re-read at `session_start`, at `agent_start`, and immediately after `/handoff on|off`. Editing the file by hand takes effect on the next run; `/handoff status` tells you which layer won.

## Install

```bash
pi install npm:pi-handoff-chain
```

Or straight from git:

```bash
pi install git:github.com/martintsan/pi-handoff-chain
```

Verify: start a new pi session — `finish`, `checkpoint` tools and `/next`, `/cut`, `/handoff` commands are available in every project. `/handoff status` confirms the resolved switch value and its source.

Kill switch without uninstalling: `"enable_handoff": false` — see [The switch](#the-switch-enable_handoff).

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

### `checkpoint` tool (non-terminal, context-resetting)

Same document format, no termination. Call after every meaningful milestone on long tasks, before and after risky operations. If the session dies at any instant, the on-disk handoff is at most one step stale — and if it survives, the context that produced the milestone gets replaced by it. `reset: "compact" | "session" | "none"`, default `compact` (see [Context reset engine](#context-reset-engine)).

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

### `/cut` command

Hard context reset for the *same* task: wipes the context, starts a fresh session seeded with `HANDOFF.md`, and continues from the checkpoint instead of moving to a next task. Ask for it with `/cut`, or get it automatically from `checkpoint(reset: "session")` — the automatic path skips the confirmation prompt because you already asked for it.

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
| `HANDOFF_ENABLED` | *(unset)* | override `enable_handoff` for this process (`true`/`false`) |
| `HANDOFF_WATERMARK` | `0.6` | context usage fraction that triggers forced landing |
| `HANDOFF_CHECKPOINT_RESET` | `compact` | default `reset` mode for `checkpoint` (`compact` / `session` / `none`) |
| `HANDOFF_MAX_RESETS` | `12` | per-session cap on automatic resets (anti ping-pong breaker) |
| `MAX_TURNS` | `10` | (driver script) circuit-breaker cap |
| `LOG_DIR` | `.chain-logs` | (driver script) per-turn log directory |

## Hacking

```bash
./scripts/typecheck.sh   # symlink the globally installed pi package (or use the npm peer dep) + tsc --noEmit
```

The reset engine's behaviour depends on pi event ordering (`turn_end` → `agent_settled` → compaction), which is documented above and in the source comments; change it with a sandbox RPC session before trusting it.

## Publishing

The package already carries what the pi ecosystem needs: the `pi-package` keyword (which is what the [gallery](https://pi.dev/packages) indexes) and a `pi.extensions` manifest. `publishConfig.access` is `public` and `prepublishOnly` runs the typecheck, so a publish is one command:

```bash
npm login          # interactive, one-time
npm publish        # runs ./scripts/typecheck.sh first, then publishes pi-handoff-chain@<version>
```

Verified prerequisites: the name `pi-handoff-chain` is unclaimed on the registry, all three peer deps resolve publicly (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`), and the tarball ships only `extensions/`, `scripts/`, `tsconfig.check.json`, `README.md`, `LICENSE`.

Gallery listing is automatic — pi.dev/packages displays npm packages tagged `pi-package`, so there is nothing to submit separately. For a preview in the gallery card, add `pi.image` (PNG/JPEG/GIF/WebP) or `pi.video` (MP4) to the `pi` block in `package.json`; both need a hosted URL.

### Provenance (CI only)

npm provenance cannot be generated from a local machine — per npm's docs it requires a supported cloud CI provider on a cloud-hosted runner (GitHub Actions or GitLab CI/CD). For that route, publish from GitHub Actions with `permissions: { id-token: write }` and `npm publish --provenance --access public` (or npm trusted publishing, which adds provenance without the flag). Deliberately **not** set in `publishConfig`: `provenance: true` there would make every local `npm publish` fail.

## Credits

Protocol pattern inspired by the solo-founder multi-agent workflow behind [HAN•GL](https://hangl.app) (kill the session after the artifact lands; hand off through documents; the human keeps the approval gates).

## License

MIT
