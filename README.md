# pi-handoff-chain

**Kill & Handoff protocol for [pi](https://github.com/badlogic/pi-mono)** — per-task handoff lanes, checkpointed context resets, in-chat briefs, watermark-enforced landing, and fresh-session task chaining (with model choice) for solo developers running multi-agent workflows.

## The problem

LLM context windows are finite, expensive, and degrade as they fill up. Long-lived agent sessions rot: you pay to re-send stale noise, and when the window finally fills, the session dies mid-task with nothing written down.

And when you run several agents at once, they collide: two sessions — one on task A, one fixing a bug — overwrite each other's single `HANDOFF.md`, and whoever wrote last silently wins.

## Lanes: one handoff per work thread

Every session owns a **lane** — a named work thread with its own document at `.pi/handoff/<lane>.md`. Parallel sessions can no longer clobber each other, and the root `HANDOFF.md` becomes an **auto-generated index**: a status table of every lane plus the full body of the most recently active one, so anything that used to parse `HANDOFF.md` (`/next`, `scripts/agent-chain.sh`, you) keeps working.

How a session picks its lane, in order:

1. the `lane` argument passed to `checkpoint` / `finish` (only when the human names a thread)
2. `HANDOFF_LANE` env var (what the headless driver sets)
3. the lane already bound to this session — remembered in-process, recovered from the lane document's `session:` line after a restart, and from a `handoff-lane:` marker that `/next` injects into the new session
4. otherwise derived: session name, else a slug of the first user message (with a session fingerprint appended if that name is already taken by another live lane)

A legacy single `HANDOFF.md` is moved to `.pi/handoff/legacy.md` on the first write and appears in the index like any other lane.

```
/handoff                # list lanes: status, context, next task (* = this session's lane)
/handoff fix-i18n       # read one lane document
/handoff all            # every lane: path + summary
/next                   # chain the most recently open lane (picker if several are open)
/next fix-i18n          # chain a specific lane
```

## The in-chat brief

`finish` terminates the session on purpose — no victory lap, no wasted tokens. The cost used to be that the human saw nothing but a toast. Now `finish` and `checkpoint` render a **brief card in the transcript** themselves (progress, open issues, next step, artifacts) via `pi.appendEntry` + `pi.registerEntryRenderer`:

- custom entries never enter the LLM context — the card costs zero tokens
- it is persisted in the session file, so it is still there when you resume
- in headless mode (`pi -p`) entries do not render, so the same text is also in the tool result for the driver log

The text comes from the tool's `broadcast` field (2-4 lines: what moved forward, what is still open), derived from `summary` when omitted.

## The protocol

The unit of work is one *session-sized task*, not a whole project. Each agent:

1. **Saves at milestones — and resets when it pays off** — `checkpoint` writes an in-progress lane document, and with the default `reset: "auto"` it clears the context that produced it, replacing it with the document (a save *and* a restart, not a log line) — but only when the context is actually loaded and the document is thick enough to work from blind
2. **Gets force-landed at the watermark** — a watchdog monitors context usage every turn; past the threshold it injects a mandatory "stop new work, land the plane" directive
3. **Ends on a commit, not a conversation** — `finish` writes the final handoff document, prints the in-chat brief, and returns `terminate: true`, so the session stops immediately with zero "victory lap" tokens
4. **Chains to a fresh brain** — `/next` starts a brand-new session seeded with the handoff document (on the model you choose), with zero memory of the predecessor

> Files are the only reliable memory. Context is disposable.

## Context reset engine

A checkpoint that only writes a file is a checkpoint that never gets used. If the context survives the write, the agent keeps dragging every dead end, stale file read, and abandoned plan into the next mile of the task — and when it eventually re-reads the handoff, the fresh document has to compete with a screenful of contradicting noise. So a real milestone checkpoint is a **context reset point**: the snapshot must actually *replace* the context.

But resetting is not free, and v1.2 reset unconditionally: a two-line "quick note" checkpoint wiped the whole session (observed at 11% context) and left the agent re-discovering things it already knew — which reads to the human exactly like "the session got interrupted". So `reset` now has four modes:

| reset | what happens | when it happens |
|---|---|---|
| `"auto"` (default) | Resets only when it pays off — see the gate below. Otherwise it just writes the file and says why. | at `turn_end`, after the tool result is persisted |
| `"compact"` | This session's context is cleared and **replaced by the document you just wrote**. Then the agent is nudged to keep working from it. | at `turn_end` |
| `"session"` | Hard cut: a brand-new session (`ctx.newSession()`) seeded with the document; the same task continues there with zero inherited context. | at `agent_settled`, via `/cut` |
| `"none"` | Only the file is written — the old behaviour. | never |

### The auto gate

An `auto` checkpoint only resets when **both** hold:

- **context is loaded** — at least `HANDOFF_RESET_MIN` (default `0.35`) of the window; below that, wiping costs more than it saves
- **the document can carry the whole context** — `summary` + `next_task` ≥ `HANDOFF_RESET_MIN_DOC_CHARS` (default 700) chars, `next_task` ≥ `HANDOFF_RESET_MIN_NEXT_CHARS` (default 60) unless the status is terminal, and at least one `artifact` listed

Either check failing → snapshot is written, context is left alone, and the tool result says exactly which bar was missed, so the agent can either write a real checkpoint or keep working. The document bar also applies to an explicit `reset: "compact" | "session"` — a thin document must never become an agent's entire memory.

The `compact` reset is **free**: instead of paying an LLM to summarize the old context, the extension answers pi's `session_before_compact` event with the handoff document itself as the compaction summary. Nothing is summarized, nothing is invented — the document *is* the new context, with pi's recent-entry boundary kept on top of it so the immediate working set survives.

`reset: "session"` exists for when even the kept tail is too dirty: same task, brand-new brain, `parentSession` recorded for traceability. Same machinery as `/next`, different intent — `/next` chains to the *next* task, `/cut` wipes and *continues* this one.

In headless mode (`pi -p`) every reset is skipped by design: one process per turn already *is* a context boundary.

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
/handoff                    # list lanes (status / ctx / next task)
/handoff <lane>             # read one lane document
/handoff all                # every lane: path + summary
/handoff status             # resolved switch value + which layer is winning, per source
/handoff off                # write enable_handoff:false → global settings
/handoff on project         # write it to ./.pi/settings.json instead
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

Verify: start a new pi session — `finish`, `checkpoint` tools and `/next`, `/cut`, `/handoff` commands are available in every project. `/handoff status` confirms the resolved switch value and its source. The first write moves any existing single `HANDOFF.md` into `.pi/handoff/legacy.md` and replaces the root file with a generated index.

Kill switch without uninstalling: `"enable_handoff": false` — see [The switch](#the-switch-enable_handoff).

Remove:

```bash
pi remove git:github.com/martintsan/pi-handoff-chain
```

## What you get

### `finish` tool (terminal)

Call as the **final action** of a task. Writes a structured handoff document for your lane (status / summary / decisions / artifacts / next task / blockers), renders the in-chat brief, then terminates the session immediately via `terminate: true`.

Fields: `status`, `summary`, `broadcast` (the in-chat brief), `lane`, `artifacts`, `decisions`, `next_task`, `blocked`.

Three legal ways to land:

| status | meaning |
|---|---|
| `done` | task contract fulfilled |
| `partial` | watermark hit or time's up — remainder fully described in `next_task` |
| `blocked` | needs a human — the chain stops and waits |

### `checkpoint` tool (non-terminal, context-resetting)

Same document format, no termination. Call after every meaningful milestone on long tasks, before and after risky operations. If the session dies at any instant, the on-disk handoff is at most one step stale — and if the document is complete enough, the context that produced the milestone gets replaced by it. `reset: "auto" | "compact" | "session" | "none"`, default `auto` (see [Context reset engine](#context-reset-engine)).

### Watermark watchdog

On every `turn_end`, current context usage is checked (`ctx.getContextUsage()`). At or above **60%** of the model's window, the extension steers a directive into the conversation:

> STOP starting new work. Commit finished artifacts. Call `finish` with `partial` and a self-contained `next_task`. Do not ask questions; land the plane.

Tune with `HANDOFF_WATERMARK` (e.g. `0.7`). Fires once per agent run.

### `/next` command

Reads a lane's handoff document, asks for human approval, then `ctx.newSession()`:
- records the previous session as parent (traceability)
- injects the handoff document as the new session's initial context, plus a `handoff-lane:` marker so the fresh session keeps writing the same lane
- sends a kickoff prompt ("you are a fresh agent with zero memory; verify artifacts; execute Next task; end with `finish`")

```
/next                                   # pick the lane (selector when several are open)
/next fix-i18n                          # chain a specific lane
/next fix-i18n focus on the failing tests first   # custom kickoff text
/next -m anthropic/claude-sonnet-4-5    # chain on that model
/next -m list                           # pick the model from the available catalogue
/next --default-model                   # use the configured default model instead
```

**Model selection.** `ctx.newSession()` always builds the new session from the configured `defaultProvider`/`defaultModel` — a `/model` switch in the current session would simply be lost. So the chain now carries a model over: by default it **inherits the model of the session you are chaining from**, and `-m`/`--model`/`@provider/id`/`model=provider/id` (optional `:high` thinking suffix) picks one explicitly. Resolution is fuzzy (`-m sonnet` matches `anthropic/claude-sonnet-4-5`, ambiguity is reported instead of guessed), the spec is validated *before* any session switch, and the model is applied with `pi.setModel()` inside `withSession()`. Set `HANDOFF_CHAIN_MODEL=default` to restore the old "always the settings default" behaviour.

### `/cut` command

Hard context reset for the *same* task: wipes the context, starts a fresh session seeded with your lane's document, and continues from the checkpoint instead of moving to a next task. Ask for it with `/cut [lane] [-m model]`, or get it automatically from `checkpoint(reset: "session")` — the automatic path skips the confirmation prompt because you already asked for it.

### `/handoff` command

`/handoff` lists lanes, `/handoff <lane>` prints one document, `/handoff all` prints every lane's path and summary, `/handoff status` shows the switch and its sources.

## Headless mode (optional driver)

`scripts/agent-chain.sh` runs the whole chain unattended:

```bash
./scripts/agent-chain.sh TASK.md
```

Each turn is a fresh `pi -p` process (clean context). The driver pins one lane for the whole run (`HANDOFF_LANE`), the agent must `finish` → process exits → driver extracts the next task from `.pi/handoff/<lane>.md` → next process. Protections:

- **Recovery spell**: if a turn exits without a handoff, the driver resumes (`pi -c`) and instructs the agent to reconstruct the handoff from the (possibly compacted) session before stopping
- **Circuit breaker**: `MAX_TURNS` (default 10) caps runaway chains
- **Blocked detection**: `blocked` status halts the chain for human review

## Task-writing discipline (the actual skill)

This plugin makes handoffs mechanical; it cannot make tasks small enough. Before starting a task, ensure:

1. **Single artifact** — one identifiable deliverable per session
2. **Machine-verifiable** — a validator can judge it (tests pass, schema passes, count met)
3. **Context budget ≤ 50%** — leave headroom
4. **One lane per thread** — if two agents work on unrelated things, they land in different lane files automatically; naming them is only needed when the human wants a specific name

"Complete the project" is not a task. A project is a DAG of session-sized tickets whose state lives on disk. Decompose first, or the chain will stall.

## Configuration

| env var | default | meaning |
|---|---|---|
| `HANDOFF_ENABLED` | *(unset)* | override `enable_handoff` for this process (`true`/`false`) |
| `HANDOFF_LANE` | *(unset)* | force the lane name this process writes (used by the driver) |
| `HANDOFF_WATERMARK` | `0.6` | context usage fraction that triggers forced landing |
| `HANDOFF_CHECKPOINT_RESET` | `auto` | default `reset` mode for `checkpoint` (`auto` / `compact` / `session` / `none`) |
| `HANDOFF_RESET_MIN` | `0.35` | minimum context usage before an `auto` reset is worth doing |
| `HANDOFF_RESET_MIN_DOC_CHARS` | `700` | minimum `summary` + `next_task` length before a reset is allowed |
| `HANDOFF_RESET_MIN_NEXT_CHARS` | `60` | minimum `next_task` length for a non-terminal reset |
| `HANDOFF_MAX_RESETS` | `12` | per-session cap on automatic resets (anti ping-pong breaker) |
| `HANDOFF_CHAIN_MODEL` | `inherit` | `/next` `/cut` model when no `-m` is given (`inherit` or `default`) |
| `HANDOFF_IDLE_BUDGET_MS` | `90000` | how long the post-reset resume waits for the session to go idle |
| `MAX_TURNS` | `10` | (driver script) circuit-breaker cap |
| `LANE` | `chain` | (driver script) lane the unattended run writes |
| `LOG_DIR` | `.chain-logs` | (driver script) per-turn log directory |

## Hacking

```bash
npm run typecheck   # symlink the installed pi types (or use the npm peer dep) + tsc --noEmit
npm run smoke       # behavioural gate: mock-driven, no build, no LLM, 30+ checks
npm run check       # both
```

`scripts/smoke.mjs` is the real safety net: it loads the extension against a mock `ExtensionAPI` and asserts the protocol — lanes do not clobber each other, a legacy `HANDOFF.md` migrates, the root index regenerates, a thin checkpoint does **not** reset context, a substantial one above the floor arms the reset and dispatches `ctx.compact()`, the compaction summary is replaced by the lane document, the agent is resumed afterwards, and `/next` applies/rejects model specs before switching sessions. A gate that can rot silently is worse than no gate, so keep new behaviour covered there.

The reset engine's behaviour depends on pi event ordering (`turn_end` → `agent_settled` → compaction), which is documented above and in the source comments; change it with a sandbox RPC session before trusting it.

## Publishing

`publishConfig.access` is `public` and `prepublishOnly` runs the typecheck plus the smoke gate, so a release is one command:

```bash
npm version patch|minor|major   # bumps package.json and commits + tags locally
npm publish                     # prepublishOnly typechecks, then ships
git push && git push --tags     # the tag must land, see below
```

Tag every published version. `pi install git:...@vX` resolves git tags, so a version that exists on npm but not in git is a dead end for anyone pinning the git source — keep `v<version>` tags pointing at the exact commit whose tarball was published.

Gallery listing is automatic: [pi.dev/packages](https://pi.dev/packages) indexes npm packages carrying the `pi-package` keyword, which this package already has — there is nothing to submit separately. The detail page renders the package README, so README edits show up there on the next publish. For a preview in the gallery card, add `pi.image` (PNG/JPEG/GIF/WebP) or `pi.video` (MP4) to the `pi` block in `package.json`; both need a hosted URL.

The catalog page sorts by download volume, so a freshly published package sits far down the list until it accumulates downloads — deep-link to `pi.dev/packages/pi-handoff-chain` rather than expecting the front page.

### Provenance (CI only)

npm provenance cannot be generated from a local machine — per npm's docs it requires a supported cloud CI provider on a cloud-hosted runner (GitHub Actions or GitLab CI/CD). For that route, publish from GitHub Actions with `permissions: { id-token: write }` and `npm publish --provenance --access public` (or npm trusted publishing, which adds provenance without the flag). Deliberately **not** set in `publishConfig`: `provenance: true` there would make every local `npm publish` fail. Until provenance is set up, `npm audit signatures` verifies the registry signature but finds no attestation for this package.

## Credits

Protocol pattern inspired by the solo-founder multi-agent workflow behind [HAN•GL](https://hangl.app) (kill the session after the artifact lands; hand off through documents; the human keeps the approval gates).

## License

MIT
