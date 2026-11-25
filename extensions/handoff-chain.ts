/**
 * handoff-chain.ts — Kill & Handoff relay protocol for pi
 *
 * Workflow:
 *   1. The agent works and calls `finish` when its contract is met (promptGuidelines enforce it)
 *   2. finish writes the handoff document to disk (one lane document per work thread), renders a
 *      brief card in the transcript (progress + issues + next step), then returns terminate:true
 *      -> pi stops as soon as the tool batch ends and never appends more LLM output (no victory lap)
 *   3. A human reviews the handoff (the human gate) and runs /next (picking a lane, optionally a model)
 *   4. /next reads that lane's document -> ctx.newSession() starts a brand-new session
 *      -> seeded with the handoff document -> sends the kickoff prompt that continues the next task
 *
 * ── The four things v1.3 fixes ─────────────────────────────────────────
 *
 * 1) Sessions used to overwrite one another's HANDOFF.md
 *    Now one session = one lane (one work thread) with its document at `.pi/handoff/<lane>.md`.
 *    The root HANDOFF.md becomes an **auto-generated index plus the body of the most recently
 *    active lane**, so old scripts (agent-chain.sh) and "## Next task" parsing keep working.
 *    Lane resolution order: explicit lane parameter > HANDOFF_LANE env > lane already bound to this
 *    session > the `session:` line inside a lane document (survives a restart) > the `handoff-lane:`
 *    marker /next injects > session name > first user message. Bindings are also stored with
 *    pi.appendEntry, so a fork or resume still recognises its own lane.
 *
 * 2) Nothing was summarised in the chat after a handoff landed
 *    terminate:true kills the victory lap, and the side effect was that the human saw one toast only.
 *    finish/checkpoint now render a brief card in the transcript themselves with pi.appendEntry +
 *    registerEntryRenderer (progress / issues / next step / artifacts):
 *      - custom entries never enter the LLM context, so the card costs zero tokens
 *      - entries are persisted in the session file, so they survive a resume
 *      - in headless mode (pi -p) entries do not render, so the same text also goes to the tool result
 *
 * 3) A short, careless checkpoint used to interrupt the session
 *    v1.2 defaulted to reset=compact: every checkpoint wiped the context (observed at 11% context)
 *    with a note-thin document, so the agent had to rediscover what it already knew — which reads to
 *    the human exactly like "the session got interrupted". v1.3 defaults to reset=auto: a reset
 *    happens only when ① the context is loaded (>= HANDOFF_RESET_MIN, default 35%) and ② the
 *    document is thick enough to serve as the whole context; otherwise it writes the file and says why.
 *
 * 4) /next always fell back to the default model
 *    ctx.newSession() goes through createRuntime, which takes the settings default, so a /model
 *    switch in the current session was lost. chainToFreshSession now **inherits the current model**
 *    by default and accepts an explicit one: `/next -m <provider/id|fuzzy name|list|default|inherit>`.
 *    (measured on pi: pi.setModel inside withSession does apply to the new session — session
 *     replacement runs apply() -> rebindSession() -> bindCore(), which rebinds the runtime actions to
 *     the new session; sm.appendModelChange() during setup only writes the file, it cannot pick a model.)
 *
 * ── Context reset engine (v1.2's core; v1.3 adds the auto gate) ────────
 *
 *   Checkpointing to disk is **not enough** — the same session keeps growing, the document is never
 *   the source of the context, and when the agent later "re-reads the doc" the fresh document has to
 *   compete with a screenful of stale context. A real milestone checkpoint must be a reset point.
 *
 *   Four reset modes (the checkpoint `reset` parameter, default auto):
 *     auto     resets only when it pays off (see item 3 above)
 *     none     writes the file and leaves the context alone
 *     compact  clears in place: once this turn's tools are done (turn_end, results persisted) it
 *              triggers compaction and, through session_before_compact, replaces the summary with the
 *              lane document just written. A reset at zero LLM cost: the document *is* the new context;
 *              after session_compact a "continue from the document" nudge keeps the work unbroken.
 *     session  hard cut: after settle, /cut starts a brand-new session (like /next, same task)
 *
 *   Timing constraints (why the context cannot be cleared inside the tool's execute):
 *     - a tool's ctx is an ExtensionContext: it has compact() but no newSession();
 *       newSession() only exists on the command context (ExtensionCommandContext).
 *     - ctx.compact() aborts the current run first. Called from execute it takes the running tool
 *       batch down with it and the result may never reach the session, so it is deferred to turn_end.
 *     - session replacement is likewise deferred to agent_settled (when _isAgentRunActive is false)
 *       and dispatched through the command channel with sendUserMessage("/cut", {expandPromptTemplates:true}).
 *
 * Install as .pi/extensions/handoff-chain.ts (project level, needs the project trusted)
 * or ~/.pi/agent/extensions/handoff-chain.ts (global).
 *
 * Master switch: `enable_handoff` in settings.json (see the switch section below).
 *   Priority: HANDOFF_ENABLED env > .pi/settings.json > ~/.pi/agent/settings.json > true
 *   Off does not mean "registered but refusing", it means invisible to the model: finish/checkpoint are
 *   removed from the active tools (taking their promptSnippet / promptGuidelines with them), every event
 *   handler early-returns, and /next /cut refuse to chain. Control plane: /handoff [status | on | off].
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Root index file (the old path is kept so scripts still parse "## Next task") */
const INDEX_FILE = "HANDOFF.md";
const INDEX_MARK = "<!-- handoff-chain:index -->";
/** One document per lane: <cwd>/.pi/handoff/<lane>.md */
const LANE_DIR = ".pi/handoff";
const LEGACY_LANE = "legacy";
/** In-chat brief card (custom entry, never enters the LLM context) */
const BRIEF_TYPE = "handoff-brief";
/** Lane bindings for this session (persisted per session, never in the LLM context) */
const LANE_ENTRY_TYPE = "handoff-lane";
/** Only these pi built-in levels, so a thinking suffix is never guessed */
const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// ── Master switch: `enable_handoff` in settings.json ──────────────────
//
// pi exposes no settings API to plain extension contexts, but settings.json passes unknown top-level
// keys through, so the extension reads and writes those files itself.
// Priority (high -> low):
//   env HANDOFF_ENABLED (single run: headless / tests)
//   project  <cwd>/.pi/settings.json           ->  "enable_handoff": true|false
//   global   ~/.pi/agent/settings.json          ->  "enable_handoff": true|false
//   default  true (the plugin's long-standing behaviour; write false to switch it off)
//
// Off is not "registered but refusing", it is "invisible to the model":
//   - finish / checkpoint are removed from the active tool set, so the model never sees them and
//     their promptSnippet / promptGuidelines disappear from the system prompt with them
//   - every event handler early-returns (no context resets, no watermark steering)
//   - /next /cut refuse to chain; /handoff stays as the control plane (on / off / status)
const SETTINGS_KEY = "enable_handoff";
const HANDOFF_TOOLS = ["finish", "checkpoint"];
type Scope = "global" | "project";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
function settingsPath(scope: Scope, cwd: string): string {
  return scope === "global" ? join(agentDir(), "settings.json") : join(cwd, ".pi", "settings.json");
}

function readSettings(scope: Scope, cwd: string): Record<string, unknown> | null {
  const p = settingsPath(scope, cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null; // unreadable file: do not block, let the defaults win
  }
}

/** Lenient parse: booleans or "true|false|on|off|yes|no|1|0"; undefined when unrecognised */
function parseBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "on", "yes", "1"].includes(s)) return true;
    if (["false", "off", "no", "0"].includes(s)) return false;
  }
  return undefined;
}

function resolveEnabled(cwd: string): { enabled: boolean; source: string } {
  const env = parseBool(process.env.HANDOFF_ENABLED);
  if (env !== undefined) return { enabled: env, source: `env HANDOFF_ENABLED=${process.env.HANDOFF_ENABLED}` };
  const proj = parseBool(readSettings("project", cwd)?.[SETTINGS_KEY]);
  if (proj !== undefined) return { enabled: proj, source: `project ${settingsPath("project", cwd)}` };
  const glob = parseBool(readSettings("global", cwd)?.[SETTINGS_KEY]);
  if (glob !== undefined) return { enabled: glob, source: `global ${settingsPath("global", cwd)}` };
  return { enabled: true, source: "default (key absent)" };
}

/** Read-modify-write: touches only this one key and preserves every other setting */
function writeEnabled(scope: Scope, cwd: string, value: boolean): { path: string; error?: string } {
  const p = settingsPath(scope, cwd);
  try {
    const obj = readSettings(scope, cwd) ?? {};
    obj[SETTINGS_KEY] = value;
    if (scope === "project") mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
    return { path: p };
  } catch (err) {
    return { path: p, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Thresholds ─────────────────────────────────────────────────────────
// Watermark: force landing at 60% of the window (leaves room to write the handoff + slack)
const WATERMARK = Number(process.env.HANDOFF_WATERMARK ?? 0.6);

// Default checkpoint reset mode: auto | none | compact | session
type ResetKind = "none" | "compact" | "session";
type ResetChoice = ResetKind | "auto";
const DEFAULT_RESET: ResetChoice = pickReset(process.env.HANDOFF_CHECKPOINT_RESET, "auto");

// Circuit breaker: max automatic resets per session (stops a reset/resume ping-pong)
const MAX_RESETS = Number(process.env.HANDOFF_MAX_RESETS ?? 12);

// Reset floor: below this share of the window a reset is self-harm (it drops more than it keeps)
const RESET_MIN = Number(process.env.HANDOFF_RESET_MIN ?? 0.35);
// Document thickness floor: after a reset this document IS the whole context, so a thin one
// would drop the agent back to square one (v1.2's failure mode)
const RESET_MIN_DOC_CHARS = Number(process.env.HANDOFF_RESET_MIN_DOC_CHARS ?? 700);
const RESET_MIN_NEXT_CHARS = Number(process.env.HANDOFF_RESET_MIN_NEXT_CHARS ?? 60);

// /next /cut inherit the current session model ("inherit"); "default" restores the settings default
const CHAIN_MODEL = (process.env.HANDOFF_CHAIN_MODEL ?? "inherit").trim().toLowerCase();

function pickReset(v: string | undefined, fallback: ResetChoice): ResetChoice {
  return v === "none" || v === "compact" || v === "session" || v === "auto" ? v : fallback;
}

// ── Lanes: one work thread per session ───────────────────────────────
//
// The trailer of a lane document (the key: value lines after the last `---`) is the machine-readable
// block the root index is generated from.
interface LaneMeta {
  lane: string;
  file: string;
  status: string;
  updated: string;
  session: string;
  contextPct: string;
  next: string;
  summary: string;
  mtime: number;
  doc: string;
}

/** Lane bound to this session; key = session file path (cwd as fallback) */
const laneBindings = new Map<string, string>();
/** `handoff-lane:` markers injected by /next (cross-process fallback: the lane's session: line) */
const injectedLanes = new Map<string, string>();
let migrationsDone = false;
/** Last known cwd, only used for /next and /handoff argument completion */
let lastCwd = process.cwd();
/** Lane computed in setup() for the chained session, handed to withSession to record */
let pendingLaneForChild: string | null = null;

function laneDir(cwd: string): string {
  return join(cwd, LANE_DIR);
}
function lanePath(cwd: string, lane: string): string {
  return join(laneDir(cwd), `${lane}.md`);
}
function sessionKey(ctx: ExtensionContext | ExtensionCommandContext): string {
  return ctx.sessionManager.getSessionFile?.() ?? `cwd:${ctx.cwd}`;
}

/** ASCII slug: a lane name has to work as a file name and be easy to type after /next */
function slugify(raw: string): string {
  const s = (raw || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s;
}

function hash4(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 4);
}

const LANE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LANE_MARKER_RE = /^handoff-lane:\s*([a-z0-9][a-z0-9._-]{0,63})\s*$/im;

/** Parse the key: value trailer of a lane document (empty object when there is none) */
function parseTrailer(doc: string): Record<string, string> {
  const i = doc.lastIndexOf("\n---\n");
  if (i < 0) return {};
  const out: Record<string, string> = {};
  for (const line of doc.slice(i + 5).split("\n")) {
    const m = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function sectionOf(doc: string, title: string): string {
  return (
    doc
      .split(new RegExp(`^## ${title}$`, "m"))[1]
      ?.split(/^## /m)[0]
      ?.trim() ?? ""
  );
}

function oneLine(s: string, n: number): string {
  const one = (s || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function escCell(s: string): string {
  return (s || "").replace(/\|/g, "\\|");
}

function readLane(cwd: string, lane: string): LaneMeta | null {
  const file = lanePath(cwd, lane);
  if (!existsSync(file)) return null;
  let doc = "";
  let mtime = 0;
  try {
    doc = readFileSync(file, "utf8");
    mtime = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const t = parseTrailer(doc);
  return {
    lane,
    file,
    status: t.status ?? "?",
    updated: t.updated ?? new Date(mtime).toISOString(),
    session: t.session ?? t["previous-session"] ?? "",
    contextPct: t["context-at-write"] ?? "",
    next: oneLine(sectionOf(doc, "Next task"), 110),
    summary: oneLine(sectionOf(doc, "What was done"), 200),
    mtime,
    doc,
  };
}

/** Every lane, most recently active first */
function listLanes(cwd: string): LaneMeta[] {
  const dir = laneDir(cwd);
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const lanes = names
    .map((f) => readLane(cwd, f.replace(/\.md$/, "")))
    .filter((l): l is LaneMeta => !!l);
  return lanes.sort((a, b) => b.mtime - a.mtime);
}

const DONE_STATUSES = ["done", "complete", "completed"];

function isChainEnd(nextSection: string): boolean {
  return !nextSection || nextSection.startsWith("(none") || /chain ends here/i.test(nextSection);
}

function isLaneOpen(l: LaneMeta): boolean {
  if (!isChainEnd(sectionOf(l.doc, "Next task"))) return true;
  return !DONE_STATUSES.includes(l.status.toLowerCase());
}

/**
 * Generates the root HANDOFF.md: a table index plus the body of the most recently active lane.
 * The "## Status" / "## Next task" shape is preserved so old scripts (agent-chain.sh) still parse it.
 */
function renderIndex(cwd: string, lanes: LaneMeta[]): string {
  const now = new Date().toISOString();
  const head = [
    INDEX_MARK,
    `# HANDOFF index — ${basename(cwd)}`,
    ``,
    `Auto-generated by pi-handoff-chain at ${now}. Do not edit by hand.`,
    `One lane = one work thread; the real documents live in \`${LANE_DIR}/<lane>.md\`.`,
    ``,
  ];
  if (!lanes.length) {
    head.push("_No lanes yet — `checkpoint` or `finish` creates the first one._", "");
    return head.join("\n");
  }
  const table = [
    `| lane | status | updated | ctx | next task |`,
    `|---|---|---|---|---|`,
    ...lanes.map(
      (l, i) =>
        `| ${i === 0 ? `**${l.lane}**` : l.lane} | ${l.status} | ${l.updated
          .replace("T", " ")
          .replace(/\.\d+Z$/, "")} | ${l.contextPct || "-"} | ${escCell(l.next || "-")} |`,
    ),
    ``,
    `Use \`/handoff <lane>\` to read one, \`/next <lane>\` to chain one into a fresh session.`,
    ``,
  ];
  const active = lanes[0];
  const body = active.doc.replace(/^#.*$\n/m, "").trim();
  const others = lanes
    .slice(1)
    .map((l) => `- \`${l.lane}\` (${l.status}, ${l.updated}) → \`${LANE_DIR}/${l.lane}.md\``)
    .join("\n");
  return [
    ...head,
    ...table,
    `## Active lane: ${active.lane}`,
    ``,
    `_Full document: \`${LANE_DIR}/${active.lane}.md\`_`,
    ``,
    body,
    ``,
    others ? `## Other lanes\n\n${others}\n` : "",
  ].join("\n");
}

/** Is this an index this extension generated (as opposed to a hand-written or legacy single file)? */
function looksLikeIndex(doc: string): boolean {
  return doc.includes(INDEX_MARK) || /^#\s*HANDOFF index\b/m.test(doc);
}

function isLaneDocText(doc: string): boolean {
  return /^#\s*HANDOFF\b/m.test(doc) && !looksLikeIndex(doc);
}

function trailerOf(doc: string, key: string): string {
  return parseTrailer(doc)[key] ?? "";
}

/** Move a legacy single HANDOFF.md into .pi/handoff/legacy.md (once per process) */
function migrateLegacy(cwd: string, ctx: ExtensionContext | ExtensionCommandContext): void {
  if (migrationsDone) return;
  migrationsDone = true;
  const root = join(cwd, INDEX_FILE);
  const dir = laneDir(cwd);
  if (!existsSync(root) || existsSync(dir)) return;
  let doc = "";
  try {
    doc = readFileSync(root, "utf8");
  } catch {
    return;
  }
  if (!isLaneDocText(doc)) return; // hand-written or empty: leave it alone
  try {
    mkdirSync(dir, { recursive: true });
    const session = trailerOf(doc, "previous-session") || "unknown";
    const updated = /^#\s*HANDOFF\s*[—-]\s*(.+)$/m.exec(doc)?.[1]?.trim() ?? new Date().toISOString();
    const status = trailerOf(doc, "status") || sectionOf(doc, "Status").split("\n")[0] || "unknown";
    const migrated = `${doc.trimEnd()}\n\nlane: ${LEGACY_LANE}\nstatus: ${status}\nupdated: ${updated}\nsession: ${session}\n`;
    writeFileSync(lanePath(cwd, LEGACY_LANE), migrated, "utf8");
    writeFileSync(join(cwd, INDEX_FILE), renderIndex(cwd, listLanes(cwd)), "utf8");
    ctx.ui.notify(
      `handoff-chain: moved the single ${INDEX_FILE} into \`${LANE_DIR}/${LEGACY_LANE}.md\` — parallel sessions no longer overwrite each other.`,
      "info",
    );
  } catch {
    /* a failed migration must never block the main path */
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const block = b as { type?: string; text?: string };
      return block.type === "text" ? (block.text ?? "") : "";
    })
    .join("\n");
}

/** Derive a lane name from session content: injected marker > session name > first user message */
function deriveLane(ctx: ExtensionContext | ExtensionCommandContext): string {
  const key = sessionKey(ctx);
  const injected = injectedLanes.get(key);
  if (injected) return injected;

  let readable = "";
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type !== "message") continue;
      const msg = e.message as { role?: string; content?: unknown };
      if (msg?.role !== "user") continue;
      const text = extractText(msg.content);
      if (!text.trim()) continue;
      const marker = LANE_MARKER_RE.exec(text);
      if (marker) return marker[1];
      // chained handoff / checkpoint-reset injections are not a task description
      if (/^<(handoff-from-previous-session|checkpoint-handoff)\b/i.test(text.trim())) continue;
      readable = slugify(text.slice(0, 160));
      break;
    }
  } catch {
    /* if getBranch is unavailable, fall through to the defaults */
  }

  try {
    const name = slugify(ctx.sessionManager.getSessionName?.() ?? "");
    if (name) readable = name;
  } catch {
    /* ignore */
  }

  const own = ctx.sessionManager.getSessionFile?.() ?? key;
  if (!readable) return `lane-${hash4(own)}`;
  const existing = readLane(ctx.cwd, readable);
  if (!existing) return readable;
  if (existing.session && existing.session === own) return readable;
  const recent = Date.now() - existing.mtime < 24 * 3600 * 1000;
  // the readable name is taken by another live thread -> add a session fingerprint, no clobbering
  return recent ? `${readable}-${hash4(own)}` : readable;
}

/** Decide this session's lane (and bind it) */
function resolveLane(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  explicit?: string,
): { lane: string; file: string; source: string } {
  const cwd = ctx.cwd;
  migrateLegacy(cwd, ctx);
  const key = sessionKey(ctx);
  const own = ctx.sessionManager.getSessionFile?.() ?? key;

  let lane = slugify(explicit ?? "");
  let source = explicit ? "param" : "";
  if (!lane && process.env.HANDOFF_LANE) {
    lane = slugify(process.env.HANDOFF_LANE);
    source = "env";
  }
  if (!lane) {
    lane = laneBindings.get(key) ?? "";
    if (lane) source = "bound";
  }
  if (!lane) {
    // cross-process resume: each lane document records which session wrote it
    const mine = listLanes(cwd).find((l) => l.session && l.session === own);
    if (mine) {
      lane = mine.lane;
      source = "resume";
    }
  }
  if (!lane) {
    lane = deriveLane(ctx);
    source = "derived";
  }
  if (!LANE_NAME_RE.test(lane)) lane = `lane-${hash4(lane || own)}`;
  void source;

  const known = laneBindings.get(key);
  laneBindings.set(key, lane);
  if (known !== lane) {
    // record the binding only when it changes, so the session file is not spammed
    try {
      pi.appendEntry(LANE_ENTRY_TYPE, { lane, source, at: Date.now() });
    } catch {
      /* if entries cannot be written, keep the in-memory binding only */
    }
  }
  return { lane, file: lanePath(cwd, lane), source };
}

/** Write the lane document and rebuild the root index */
function writeLaneDoc(cwd: string, lane: string, doc: string): string {
  mkdirSync(laneDir(cwd), { recursive: true });
  const file = lanePath(cwd, lane);
  writeFileSync(file, doc, "utf8");
  try {
    writeFileSync(join(cwd, INDEX_FILE), renderIndex(cwd, listLanes(cwd)), "utf8");
  } catch {
    /* a failing index write must not affect the lane document itself */
  }
  return file;
}

/** Keep the lane document's original creation time (the title line's timestamp) */
function createdOf(file: string, fallback: string): string {
  try {
    const first = readFileSync(file, "utf8").split("\n")[0] ?? "";
    return /^#\s*HANDOFF\s*[—-]\s*(.+)$/.exec(first)?.[1]?.trim() || fallback;
  } catch {
    return fallback;
  }
}

// ── In-chat brief ────────────────────────────────────────────────────

interface BriefData {
  kind: "finish" | "checkpoint";
  lane: string;
  status: string;
  head: string;
  lines: string[];
  path: string;
  contextPct?: string;
}

function briefText(b: BriefData): string {
  return `[${b.kind === "finish" ? "handoff" : "checkpoint"}] ${b.lane} · ${b.status}\n${b.lines.join("\n")}`;
}

function statusColor(status: string): "success" | "warning" | "accent" {
  const s = (status || "").toLowerCase();
  if (["blocked", "failed", "error"].includes(s)) return "warning";
  if (DONE_STATUSES.includes(s)) return "success";
  return "accent";
}

function broadcast(pi: ExtensionAPI, ctx: ExtensionContext, b: BriefData): void {
  try {
    pi.appendEntry(BRIEF_TYPE, b);
  } catch {
    /* headless or unwritable entry: the text is still in the tool result */
  }
  ctx.ui.notify(b.head || briefText(b), b.status === "blocked" ? "warning" : "info");
}

// ── Watchdog / reset engine state (in-process, all cleared on session_start) ──
//
// State machine (every ordering below was measured on pi, not assumed):
//   checkpoint.execute   → armed = { kind, doc, file, lane }
//   turn_end             -> compact: park resetSummary + ourCompactInFlight=true + ctx.compact()
//   session_before_compact-> replace the default summary with resetSummary (zero LLM cost)
//   session_compact/_failed -> clear the flags, then wait for idle before the RESUME message
//   agent_settled         -> a compact abort settles first (measured), so this is only a backstop;
//                          the session mode dispatches /cut here
//
// ⚠ Two measured traps (they used to make resets look like they never happened):
//   1) ctx.compact() is fire-and-forget and session_before_compact runs **after** agent_settled, so the
//      document fed to compaction is parked in its own resetSummary variable that settle cannot clear.
//   2) while compaction is in flight pi.sendUserMessage() throws:
//      "Cannot submit a prompt while compaction is in progress",
//      so every restart message has to go through whenIdle(), never a bare setTimeout(0).
let watchdogFired = false;

/** Current value of the switch (refreshed on session_start / agent_start / /handoff) */
let enabled = true;
let enabledSource = "default (key absent)";
/** Tools this extension removed from the active set while switched off; only those get restored */
let hiddenBySwitch: string[] = [];

/**
 * Re-reads the switch and keeps tool visibility in sync.
 * Called from session_start / agent_start / a manual /handoff only:
 * never from before_agent_start, where that turn's tool loadout is being computed and it races.
 * After editing settings.json it takes effect on the next run/session, or right away via /handoff on|off.
 */
function syncEnabled(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const r = resolveEnabled(ctx.cwd);
  const was = enabled;
  enabled = r.enabled;
  enabledSource = r.source;

  try {
    const active = pi.getActiveTools();
    if (!enabled) {
      const present = HANDOFF_TOOLS.filter((t) => active.includes(t));
      if (present.length) {
        pi.setActiveTools(active.filter((t) => !HANDOFF_TOOLS.includes(t)));
        hiddenBySwitch = Array.from(new Set([...hiddenBySwitch, ...present]));
      }
    } else if (hiddenBySwitch.length) {
      const missing = hiddenBySwitch.filter((t) => !active.includes(t));
      if (missing.length) pi.setActiveTools([...active, ...missing]);
      hiddenBySwitch = [];
    }
  } catch {
    // failing to read the tool list must not corrupt the switch state
  }

  if (was && !enabled) {
    // switch off: drop anything still in flight (resets, watchdog)
    disarm();
    ourCompactInFlight = false;
    watchdogFired = false;
  }
}

function disabledMessage(scopeHint = true): string {
  return (
    `handoff-chain is disabled (${SETTINGS_KEY}: false, from ${enabledSource}). ` +
    (scopeHint
      ? `Nothing was written. Re-enable with \`/handoff on\` (or remove the key / set it true in ~/.pi/agent/settings.json or .pi/settings.json).`
      : `Nothing was written.`)
  );
}

/** Landed snapshot with a reset waiting to run (consumed at turn_end) */
let armed: { kind: "compact" | "session"; doc: string; file: string; lane: string } | null = null;
/** The document handed to compaction; kept separate so settle cannot clear it along with armed */
let resetSummary: string | null = null;
/** true = a compaction we started ourselves is running (its summary is replaced by the handoff doc) */
let ourCompactInFlight = false;
/** after compaction the agent has to be pushed back into work */
let awaitingResume = false;
/** a /cut (brand-new session) is due once the run settles */
let awaitingCut = false;
/** /cut was armed by the checkpoint tool, so the human confirmation is skipped */
let cutArmedByTool = false;
/** automatic resets done in this session (circuit breaker) */
let resetCount = 0;
let activeLaneFile: string | null = null;
let activeLaneName = "";

function disarm(): void {
  armed = null;
  resetSummary = null;
  awaitingResume = false;
  awaitingCut = false;
}

/**
 * Wait until the session is completely idle (no run, no compaction, no retry) before acting.
 * Compaction is asynchronous inside the session and outlives agent_settled, so this must poll.
 */
function whenIdle(
  ctx: ExtensionContext,
  fn: () => void,
  what = "dispatch",
  budgetMs = Number(process.env.HANDOFF_IDLE_BUDGET_MS ?? 90_000),
): void {
  const started = Date.now();
  const tick = () => {
    if (ctx.isIdle()) {
      try {
        fn();
      } catch (err) {
        ctx.ui.notify(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
      return;
    }
    if (Date.now() - started > budgetMs) {
      ctx.ui.notify(
        `${what} skipped: session never went idle (${budgetMs}ms). Context is intact — keep working or run /cut.`,
        "warning",
      );
      return;
    }
    setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}

function interactive(mode: string): boolean {
  return mode === "tui" || mode === "rpc";
}

function pct(tokens: number, win: number): string {
  return `${((tokens / win) * 100).toFixed(0)}%`;
}

interface HandoffInput {
  lane: string;
  created: string;
  status: string;
  summary: string;
  artifacts?: string[];
  decisions?: string[];
  nextTask?: string;
  blocked?: string;
  sessionFile: string | null;
  contextPct?: string;
}

function renderHandoff(p: HandoffInput): string {
  const ts = new Date().toISOString();
  const bullets = (arr?: string[]) =>
    arr && arr.length ? arr.map((s) => `- ${s}`).join("\n") : "- (none)";
  return `# HANDOFF — ${p.created}

## Status
${p.status}

## What was done
${p.summary}

## Key decisions
${bullets(p.decisions)}

## Artifacts
${bullets(p.artifacts)}

## Next task
${p.nextTask ? p.nextTask.trim() : "(none — chain ends here)"}

## Open issues / risks
${p.blocked ? p.blocked.trim() : "(none)"}

---
lane: ${p.lane}
status: ${p.status}
updated: ${ts}
previous-session: ${p.sessionFile ?? "ephemeral"}
session: ${p.sessionFile ?? "ephemeral"}
${p.contextPct ? `context-at-write: ${p.contextPct}\n` : ""}produced-by: pi / handoff-chain
validator: handoff written via finish/checkpoint tool
`;
}

/**
 * Turns the handoff document into "the context body after a reset".
 * Injected as the compaction summary: the old conversation is dropped and the document becomes the
 * only trustworthy record. We wrote the summary ourselves, so this costs zero LLM tokens.
 */
function handoffAsContext(doc: string, file: string): string {
  return [
    `<checkpoint-handoff authoritative="true" lane-file="${file}">`,
    doc.trim(),
    `</checkpoint-handoff>`,
    ``,
    `CONTEXT RESET: every turn before this checkpoint has been dropped from the conversation.`,
    `The document above is the ONLY trustworthy record of prior work. Anything you seem to`,
    `remember that contradicts it is wrong — re-read the files listed under "Artifacts" when`,
    `you need detail. Recent turns kept after the reset boundary are still visible.`,
    `You are on lane \`${basename(file)}\`: keep writing checkpoints and \`finish\` into that lane.`,
  ].join("\n");
}

function resumeMessage(file: string): string {
  return [
    `Context was just reset to the checkpoint in ${file}.`,
    `Your prior conversation is gone; the checkpoint document is now the only record of what was done.`,
    `Continue: re-read ${file} from disk, verify the "Artifacts" still exist, then keep working`,
    `on the remaining task. Call \`checkpoint\` at the next milestone and \`finish\` when the contract is met.`,
  ].join(" ");
}

// ── Model selection (/next /cut) ─────────────────────────────────────
//
// ctx.newSession() builds the new session from the settings default model, so a /model switch in the
// current session used to be lost (v1.2's complaint). The chain now carries a model over:
//   - setup()'s sm.appendModelChange() only records it in the session file and does not change the
//     runtime, so it is bookkeeping only
//   - pi.setModel(realModelObject) in withSession() is what actually applies to the new session
//     (session replacement rebinds the runtime actions via apply() -> rebindSession())
//   - the Model object must come from ctx.modelRegistry.find(provider, id) (the documented way);
//     a hand-rolled {provider, id} is not enough: pi.setModel also needs api / baseUrl / capabilities
/** Real Model type, taken from pi's own signature instead of being invented here */
type ModelHandle = Parameters<ExtensionAPI["setModel"]>[0];
type ThinkingHandle = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

interface ModelSpec {
  provider: string;
  id: string;
  thinking?: string;
}

function parseModelSpec(raw: string): ModelSpec | null {
  let text = raw.trim();
  if (!text) return null;
  let thinking: string | undefined;
  const colon = text.lastIndexOf(":");
  if (colon > 0) {
    const tail = text.slice(colon + 1).toLowerCase();
    if (THINKING_LEVELS.includes(tail)) {
      thinking = tail;
      text = text.slice(0, colon);
    }
  }
  if (!text) return null;
  const slash = text.indexOf("/");
  return slash > 0
    ? { provider: text.slice(0, slash), id: text.slice(slash + 1), thinking }
    : { provider: "", id: text, thinking };
}

interface ModelRef {
  provider: string;
  id: string;
}

/** Candidate list: current model + scopedModels + whatever the registry has auth configured for */
function modelRefs(ctx: ExtensionContext | ExtensionCommandContext): ModelRef[] {
  const out: ModelRef[] = [];
  const push = (m: { provider?: string; id?: string } | undefined | null) => {
    if (m?.provider && m.id) out.push({ provider: m.provider, id: m.id });
  };
  try {
    push(ctx.model as ModelRef | undefined);
  } catch {
    /* ignore */
  }
  try {
    for (const s of ctx.scopedModels ?? []) push(s.model as ModelRef);
  } catch {
    /* ignore */
  }
  try {
    for (const m of ctx.modelRegistry.getAvailable()) push(m as ModelRef);
  } catch {
    /* ignore */
  }
  const seen = new Set<string>();
  return out.filter((m) => {
    const k = `${m.provider}/${m.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Fetch the real Model object from the official registry (undefined when it is not there) */
function lookupModel(
  ctx: ExtensionContext | ExtensionCommandContext,
  provider: string,
  id: string,
): ModelHandle | undefined {
  try {
    return ctx.modelRegistry.find(provider, id) as ModelHandle | undefined;
  } catch {
    return undefined;
  }
}

interface ModelTarget {
  ref?: ModelRef;
  handle?: ModelHandle;
  thinking?: ThinkingHandle;
  error?: string;
  candidates?: string[];
}

/** Resolve a spec: "default"/"settings" -> use the settings default, "inherit" -> the current model */
function findModel(
  ctx: ExtensionContext | ExtensionCommandContext,
  spec: string,
): ModelTarget {
  const s = spec.trim();
  if (!s || s === "default" || s === "settings") return {};
  if (s === "inherit" || s === "current") {
    if (!ctx.model) return {};
    const cur = ctx.model as ModelHandle & ModelRef;
    // ctx.model already IS a real Model from the registry, so use it directly as the handle;
    // the extra registry lookup only tries to get the fuller object (better if found).
    return { ref: { provider: cur.provider, id: cur.id }, handle: lookupModel(ctx, cur.provider, cur.id) ?? cur };
  }
  const parsed = parseModelSpec(s);
  if (!parsed) return { error: `empty model spec` };
  const thinking = parsed.thinking as ThinkingHandle | undefined;

  const refs = modelRefs(ctx);
  const exact = refs.filter(
    (m) =>
      (parsed.provider ? m.provider === parsed.provider.toLowerCase() : true) &&
      m.id.toLowerCase() === parsed.id.toLowerCase(),
  );
  const lower = s.toLowerCase();
  const fuzzy = exact.length
    ? exact
    : refs.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(lower));
  if (fuzzy.length > 1 && !exact.length) {
    return {
      error: `"${s}" is ambiguous`,
      candidates: fuzzy.slice(0, 12).map((m) => `${m.provider}/${m.id}`),
    };
  }
  const ref = fuzzy[0] ?? (parsed.provider ? { provider: parsed.provider, id: parsed.id } : undefined);
  if (!ref) return { error: `no model matching "${s}"`, candidates: refs.slice(0, 8).map((m) => `${m.provider}/${m.id}`) };
  // when the registry is reachable it must resolve the Model; a miss means an unknown id or no auth
  const handle = lookupModel(ctx, ref.provider, ref.id);
  if (!handle && ctx.modelRegistry) {
    return {
      error: `model ${ref.provider}/${ref.id} is not available (unknown id or no API key configured)`,
      candidates: refs.slice(0, 8).map((m) => `${m.provider}/${m.id}`),
    };
  }
  return { ref, handle, thinking };
}

/** Shared "chain into a fresh session" logic: both /next and /cut go through here */
async function chainToFreshSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  opts: {
    doc: string;
    kickoff: string;
    confirmTitle: string;
    confirmBody: string;
    skipConfirm: boolean;
    lane: string;
    modelSpec?: string;
  },
): Promise<void> {
  // resolve the model first: a bad spec must not switch sessions
  const spec = (opts.modelSpec ?? CHAIN_MODEL).trim();
  let target: ModelTarget = {};
  if (spec && spec !== "default" && spec !== "settings") {
    target = findModel(ctx, spec);
    if (target.error) {
      const tries = [...new Set(target.candidates ?? [])].join(", ");
      ctx.ui.notify(`${target.error}${tries ? `. Try: ${tries}` : ""}`, "error");
      return;
    }
  }
  const ref = target.ref;
  const thinking = target.thinking;

  if (!opts.skipConfirm) {
    const ok = await ctx.ui.confirm(
      opts.confirmTitle,
      `${opts.confirmBody}\nmodel: ${ref ? `${ref.provider}/${ref.id}` : "settings default"}${
        thinking ? ` · thinking ${thinking}` : ""
      }`,
    );
    if (!ok) return;
  }

  // if the command arrived while the agent was running, settle first to avoid a replacement conflict
  await ctx.waitForIdle();

  const parentSession = ctx.sessionManager.getSessionFile?.() ?? undefined;
  const inject = [
    `<handoff-from-previous-session>`,
    opts.doc,
    `</handoff-from-previous-session>`,
    `handoff-lane: ${opts.lane}`,
    ``,
    `This document is the authoritative record of prior work. Trust it over any assumption.`,
    `You are continuing lane \`${opts.lane}\`: pass lane: "${opts.lane}" to checkpoint/finish if you`,
    `need to keep writing that lane, and a different lane name only if you deliberately switch threads.`,
    `Chain protocol: verify artifacts on disk → execute the task → end with \`finish\`.`,
  ].join("\n");

  const lane = opts.lane;
  let childKey: string | undefined;

  const result = await ctx.newSession({
    parentSession,
    setup: async (sm) => {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: inject }],
        timestamp: Date.now(),
      });
      // bookkeeping only: the real runtime switch happens in withSession via pi.setModel
      if (ref) {
        try {
          sm.appendModelChange(ref.provider, ref.id);
        } catch {
          /* the new session's sm may not expose appendModelChange; ignore */
        }
      }
      try {
        childKey = sm.getSessionFile?.() ?? undefined;
      } catch {
        childKey = undefined;
      }
      if (childKey) injectedLanes.set(childKey, lane);
      pendingLaneForChild = lane;
    },
    withSession: async (freshCtx) => {
      if (!childKey) {
        try {
          childKey = freshCtx.sessionManager.getSessionFile?.() ?? undefined;
        } catch {
          /* ignore */
        }
      }
      if (childKey) injectedLanes.set(childKey, lane);
      else pendingLaneForChild = lane;

      // Model: session replacement already rebound the runtime actions, so pi.setModel lands on the
      // new session. The object must be the one ctx.modelRegistry.find() returned.
      if (ref && target.handle) {
        try {
          const ok = await pi.setModel(target.handle);
          ctx.ui.notify(
            ok === false
              ? `Chain started, but model ${ref.provider}/${ref.id} was not accepted (auth?).`
              : `Chain session model: ${ref.provider}/${ref.id}`,
            ok === false ? "warning" : "info",
          );
        } catch (err) {
          ctx.ui.notify(
            `Could not set model ${ref.provider}/${ref.id}: ${
              err instanceof Error ? err.message : String(err)
            }. The chain continues on whatever model the new session picked.`,
            "warning",
          );
        }
      }
      if (thinking) {
        try {
          pi.setThinkingLevel(thinking);
        } catch {
          /* the model may not support that level; fine */
        }
      }
      pendingLaneForChild = null;
      await freshCtx.sendUserMessage(opts.kickoff);
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("New session was cancelled by an extension.", "warning");
  }
}

function readNextTask(doc: string): string {
  return sectionOf(doc, "Next task");
}

function makeKickoff(doc: string, file: string, override?: string, resumeNote?: string): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  const nextSection = readNextTask(doc);
  const what = isChainEnd(nextSection)
    ? `reconstruct the remaining work from the "What was done" and "Open issues / risks" sections and continue toward the original goal`
    : `execute the "Next task" section of the handoff`;
  return (
    `You are continuing a task chain as a FRESH agent with no memory of previous sessions. ` +
    `Read ${file} (already provided above), verify the listed artifacts on disk, ` +
    `then ${what}${resumeNote ? ` — ${resumeNote}` : ""}. ` +
    `When done, call the \`finish\` tool as your final action.`
  );
}

/**
 * Pulls the model option out of args like `/next [lane] [-m <model>] ...`.
 * Supported: `--model x` / `--model=x` / `-m x` / `@x` / `model=x` / bare `--model` (opens the picker)
 */
async function takeModelArg(
  ctx: ExtensionContext | ExtensionCommandContext,
  tokens: string[],
): Promise<{ modelArg?: string; rest: string[]; error?: string }> {
  const rest: string[] = [];
  let modelArg: string | undefined;
  let mode: "default" | "inherit" | "spec" | "pick" = "spec";

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eq = /^--model=(.+)$/i.exec(t);
    if (eq) {
      modelArg = eq[1];
      continue;
    }
    const at = t.startsWith("@") && t.length > 1 ? t.slice(1) : "";
    if (t === "--model" || t === "-m") {
      const next = tokens[i + 1] ?? "";
      if (!next || next.startsWith("-")) {
        mode = "pick";
      } else {
        modelArg = next;
        i++;
      }
      continue;
    }
    if (/^model=(.+)$/i.test(t)) {
      modelArg = t.split("=").slice(1).join("=");
      continue;
    }
    if (at) {
      modelArg = at;
      continue;
    }
    if (t === "--default-model" || t === "--settings-model") {
      mode = "default";
      continue;
    }
    if (t === "--current-model" || t === "--inherit-model") {
      mode = "inherit";
      continue;
    }
    rest.push(t);
  }

  if (mode === "default") return { modelArg: "default", rest };
  if (mode === "inherit") return { modelArg: "inherit", rest };
  if (mode === "pick") {
    const refs = modelRefs(ctx);
    if (!ctx.hasUI)
      return { error: "bare `--model` needs an interactive session; pass `--model <provider/id>`", rest };
    if (!refs.length) return { error: "no models available to choose from", rest };
    const labels = refs.map((m) => `${m.provider}/${m.id}`);
    const pick = await ctx.ui.select("Model for the chained session?", labels);
    if (!pick) return { error: "no model chosen — nothing was chained", rest };
    return { modelArg: pick, rest };
  }
  return { modelArg, rest };
}

/** Builds the human-readable brief out of the tool arguments (progress + issues + next step) */
function buildBrief(p: {
  kind: "finish" | "checkpoint";
  lane: string;
  status: string;
  summary: string;
  blocked?: string;
  nextTask?: string;
  broadcast?: string;
  artifacts?: string[];
  file: string;
  contextPct?: string;
  note?: string;
}): BriefData {
  const custom = p.broadcast?.trim();
  const lines = custom
    ? custom
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [
        `Progress: ${oneLine(p.summary, 320)}`,
        p.status === "blocked" || p.blocked ? `Issues: ${oneLine(p.blocked || "see the document", 240)}` : `Issues: none`,
        p.nextTask && !isChainEnd(p.nextTask)
          ? `Next: ${oneLine(p.nextTask, 240)}`
          : `Next: (chain ends here)`,
      ].filter(Boolean);
  if (p.artifacts?.length) lines.push(`Artifacts: ${p.artifacts.slice(0, 6).join(", ")}`);
  if (p.note) lines.push(p.note);
  const head = `${p.kind === "finish" ? "landed" : "snapshot"} · ${p.lane} · ${p.status}${
    p.contextPct ? ` · ctx ${p.contextPct}` : ""
  }`;
  return {
    kind: p.kind,
    lane: p.lane,
    status: p.status,
    head,
    lines,
    path: p.file,
    contextPct: p.contextPct,
  };
}

/** Is this checkpoint thick enough to serve as the whole context? If not, do not reset with it */
function thinDocument(p: {
  summary: string;
  nextTask?: string;
  artifacts?: string[];
  status: string;
}): string | null {
  const summary = (p.summary ?? "").trim();
  const next = (p.nextTask ?? "").trim();
  const chars = summary.length + next.length;
  const terminal = ["done", "partial", "blocked"].includes(p.status.toLowerCase());
  if (chars < RESET_MIN_DOC_CHARS) {
    return `document too thin to be your whole context (summary + next_task = ${chars} chars, need ≥${RESET_MIN_DOC_CHARS})`;
  }
  if (!terminal && next.length < RESET_MIN_NEXT_CHARS) {
    return `next_task too thin (${next.length} chars, need ≥${RESET_MIN_NEXT_CHARS}) — a reset must leave exact remaining steps`;
  }
  if (!terminal && !(p.artifacts?.length ?? 0)) {
    return `no artifacts listed — after a reset the next agent has nothing to re-read`;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  // the brief card: what the human sees in the transcript after finish / checkpoint
  pi.registerEntryRenderer<BriefData>(BRIEF_TYPE, (entry, { expanded }, theme) => {
    const d = entry.data;
    if (!d) return new Text(theme.fg("dim", "[handoff] no data"), 0, 0);
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const tone = statusColor(d.status);
    box.addChild(
      new Text(
        `${theme.fg(tone, d.kind === "finish" ? "▣ handoff" : "▤ checkpoint")} ${theme.bold(d.lane)} · ` +
          `${theme.fg(tone, d.status)}` +
          (d.contextPct ? theme.fg("dim", ` · ctx ${d.contextPct}`) : ""),
        0,
        0,
      ),
    );
    const shown = expanded ? d.lines : d.lines.slice(0, 3);
    for (const line of shown) box.addChild(new Text(theme.fg("dim", line), 0, 0));
    if (!expanded && d.lines.length > 3) {
      box.addChild(new Text(theme.fg("dim", `… ${d.lines.length - 3} more line(s) — expand to view`), 0, 0));
    }
    if (expanded) box.addChild(new Text(theme.fg("dim", `→ ${d.path}`), 0, 0));
    return box;
  });

  // each run re-arms the warning (the post-reset resume is a new run too) and refreshes the switch
  pi.on("agent_start", async (_event, ctx) => {
    watchdogFired = false;
    lastCwd = ctx.cwd;
    syncEnabled(pi, ctx);
  });

  // every session_start (/new, /resume, /cut, and the session /next just created): read the switch first,
  // then drop leftover in-process state — an armed reset from the previous session would compact the new one.
  pi.on("session_start", async (_event, ctx) => {
    syncEnabled(pi, ctx);
    lastCwd = ctx.cwd;
    watchdogFired = false;
    disarm();
    ourCompactInFlight = false;
    resetCount = 0;
    activeLaneFile = null;
    activeLaneName = "";
    const key = sessionKey(ctx);
    if (pendingLaneForChild) {
      injectedLanes.set(key, pendingLaneForChild);
      pendingLaneForChild = null;
    }
    // restore this session's lane binding from our own handoff-lane entries (survives fork / resume)
    try {
      for (const e of ctx.sessionManager.getEntries()) {
        if (e.type === "custom" && (e as { customType?: string }).customType === LANE_ENTRY_TYPE) {
          const data = (e as { data?: { lane?: string } }).data;
          if (data?.lane) laneBindings.set(key, data.lane);
        }
      }
    } catch {
      /* if entries are unreadable, the write path re-derives the lane anyway */
    }
    // the handoff-lane marker /next injected (fallback when the process changed)
    if (!laneBindings.has(key)) {
      try {
        for (const e of ctx.sessionManager.getBranch()) {
          if (e.type !== "message") continue;
          const msg = e.message as { role?: string; content?: unknown };
          if (msg?.role !== "user") continue;
          const m = LANE_MARKER_RE.exec(extractText(msg.content));
          if (m) {
            injectedLanes.set(key, m[1]);
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (!enabled) {
      ctx.ui.notify(`${SETTINGS_KEY}: false (${enabledSource}) — handoff-chain off. Back with /handoff on`, "info");
    }
  });

  // ── 1. finish tool: land the handoff, broadcast the brief, terminate the session ──
  pi.registerTool({
    name: "finish",
    label: "Finish & Handoff",
    description:
      "End your task. Writes the handoff document for your lane, prints a short progress/issues card in the session, and stops this agent immediately. Call this as your FINAL action when your task's artifacts are already saved to disk. Do NOT write a victory-lap message — fill `broadcast` instead; the extension renders it for you.",
    promptSnippet:
      "finish: write your lane's handoff doc, broadcast a short progress/issues brief in chat, and stop",
    promptGuidelines: [
      "When your assigned task is complete (all artifacts written to disk), call `finish` as your final action instead of writing a long summary message.",
      "Always fill `broadcast`: 2-4 short lines the human reads in the chat — what moved forward and what is still open or broken. The session terminates right after `finish`, so the broadcast is the only in-chat summary there will be.",
      "Before calling `finish`, verify your artifacts exist. `finish` marks the end of your session; you cannot continue afterwards.",
      "Fill `next_task` with a self-contained task description a fresh agent (with NO memory of this session) can execute alone.",
      "If blocked, set status='blocked' and explain in `blocked`. Do not claim completion when blocked.",
      "Each session writes its own lane (`.pi/handoff/<lane>.md`) so parallel sessions cannot overwrite each other. Pass `lane` only when the human names a thread or you are deliberately continuing another one.",
    ],
    parameters: Type.Object({
      status: StringEnum(["done", "partial", "blocked"] as const),
      summary: Type.String({ description: "What was accomplished, 2-5 sentences" }),
      broadcast: Type.Optional(
        Type.String({
          description:
            "2-4 short lines shown to the human in chat after landing: progress + open issues. Derived from `summary` when omitted.",
        }),
      ),
      lane: Type.Optional(
        Type.String({ description: "Work thread to write. Omit to keep this session's own lane." }),
      ),
      artifacts: Type.Optional(Type.Array(Type.String(), { description: "Paths of files created/modified" })),
      decisions: Type.Optional(
        Type.Array(Type.String(), {
          description: "Key decisions made and why (one line each)",
        }),
      ),
      next_task: Type.Optional(
        Type.String({
          description: "Self-contained next task for the next fresh agent. Empty if chain is complete.",
        }),
      ),
      blocked: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      // StringEnum fields come through as `unknown` from Static<TParams> in this
      // pi/typebox combination; the schema constrains them, so the cast is the annotation.
      const status = p.status as "done" | "partial" | "blocked";
      if (!enabled) {
        return { content: [{ type: "text", text: disabledMessage() }], details: { disabled: true } };
      }
      const { lane, file } = resolveLane(pi, ctx, p.lane);
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
      const usage = ctx.getContextUsage();
      const win = usage?.contextWindow ?? (ctx.model as { contextWindow?: number })?.contextWindow ?? 128_000;
      const contextPct = usage?.tokens != null ? pct(usage.tokens, win) : undefined;

      const md = renderHandoff({
        lane,
        created: createdOf(file, new Date().toISOString()),
        status: status,
        summary: p.summary,
        artifacts: p.artifacts,
        decisions: p.decisions,
        nextTask: p.next_task,
        blocked: p.blocked,
        sessionFile,
        contextPct,
      });
      writeLaneDoc(ctx.cwd, lane, md);
      activeLaneFile = file;
      activeLaneName = lane;

      // finish = terminate. Clear anything pending, otherwise the turn_end after terminate
      // would drag this session into a compaction for nothing.
      disarm();
      ourCompactInFlight = false;

      const hasNext = !!(p.next_task && p.next_task.trim());
      const brief = buildBrief({
        kind: "finish",
        lane,
        status: status,
        summary: p.summary,
        blocked: p.blocked,
        nextTask: p.next_task,
        broadcast: p.broadcast,
        artifacts: p.artifacts,
        file,
        contextPct,
        note: `lane doc: ${file}`,
      });
      broadcast(pi, ctx, brief);

      return {
        content: [
          {
            type: "text",
            text:
              `${briefText(brief)}\n\nHandoff written to ${file} (lane \`${lane}\`; index refreshed in ${INDEX_FILE}). ` +
              `This session is terminating now. ` +
              (hasNext
                ? `Human must review the handoff, then run /next ${lane}.`
                : "No next task; chain ends."),
          },
        ],
        details: { path: file, lane, status: status, hasNext },
        // ★ the core: terminate -> no extra LLM output after this tool batch ends.
        //   this is pi's native equivalent of "kill the process, do not wait for the victory lap".
        terminate: true,
      };
    },
  });

  // ── 1b. checkpoint tool: land a snapshot = context reset point (non-terminal) ──
  pi.registerTool({
    name: "checkpoint",
    label: "Checkpoint Handoff",
    description:
      "Save an in-progress snapshot of the work to your lane's handoff document. With the default `reset: \"auto\"` a checkpoint is also a CONTEXT RESET POINT: once the turn ends your context is replaced by the document you just wrote (zero summarization cost) — but only when the context is actually loaded (≥35% of the window) and the document is complete enough to work from blind. A thin snapshot just writes the file and leaves your context alone. Use `reset: \"session\"` for a hard cut into a brand-new session, or `reset: \"none\"` to only write the file.",
    promptSnippet:
      "checkpoint: save progress to your lane's handoff doc; at a real milestone it resets context to that document (non-terminal)",
    promptGuidelines: [
      "For any task expected to take more than ~10 tool calls, call `checkpoint` after each milestone, before and after risky operations. Treat the lane document as your save file, not as an end-of-exam name field.",
      "A checkpoint that is meant to reset context must be complete enough to work from blind: full state in `summary`, listed `artifacts`, exact remaining steps in `next_task`. Thin one-liners are fine as notes but will not reset context.",
      "Use `reset: \"none\"` on purpose for a quick note mid-thought when you do not want the context touched yet.",
      "`checkpoint` does NOT end your task: after a reset the same work continues, but only the checkpoint document survives.",
      "After a reset, do not trust remembered detail: re-read the lane document and the artifact files it lists.",
      "Each session writes its own lane (`.pi/handoff/<lane>.md`); pass `lane` only to continue a thread the human named.",
    ],
    parameters: Type.Object({
      status: StringEnum(["in-progress", "done", "partial", "blocked"] as const),
      summary: Type.String({ description: "Progress so far, 2-5 sentences" }),
      broadcast: Type.Optional(
        Type.String({ description: "One or two lines shown to the human in chat: state + what is open." }),
      ),
      lane: Type.Optional(
        Type.String({ description: "Work thread to write. Omit to keep this session's own lane." }),
      ),
      artifacts: Type.Optional(Type.Array(Type.String())),
      decisions: Type.Optional(Type.Array(Type.String())),
      next_task: Type.Optional(
        Type.String({ description: "If the session died right now, what should the next agent do?" }),
      ),
      blocked: Type.Optional(Type.String()),
      reset: Type.Optional(
        StringEnum(["auto", "none", "compact", "session"] as const, {
          description:
            "'auto' (default) resets only when context is loaded and the document is substantial; 'none' writes the file only; 'compact' clears this session's context and replaces it with the document; 'session' hard-cuts to a brand-new session.",
        }),
      ),
    }),
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      const status = p.status as "in-progress" | "done" | "partial" | "blocked";
      if (!enabled) {
        return { content: [{ type: "text", text: disabledMessage() }], details: { disabled: true } };
      }
      const { lane, file } = resolveLane(pi, ctx, p.lane);
      activeLaneFile = file;
      activeLaneName = lane;
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
      const usage = ctx.getContextUsage();
      const win = usage?.contextWindow ?? (ctx.model as { contextWindow?: number })?.contextWindow ?? 128_000;
      const ratio = usage?.tokens != null ? usage.tokens / win : undefined;
      const contextPct = ratio != null ? pct(usage!.tokens!, win) : undefined;

      const md = renderHandoff({
        lane,
        created: createdOf(file, new Date().toISOString()),
        status: status,
        summary: p.summary,
        artifacts: p.artifacts,
        decisions: p.decisions,
        nextTask: p.next_task,
        blocked: p.blocked,
        sessionFile,
        contextPct,
      });
      writeLaneDoc(ctx.cwd, lane, md);

      // ── should this checkpoint really reset the context (v1.3: default auto, never blanket) ──
      const requested = pickReset(p.reset as string | undefined, DEFAULT_RESET);
      const headless = !interactive(ctx.mode);
      let kind: ResetKind = requested === "auto" ? "compact" : requested;
      let skipReason = "";

      if (requested === "none") {
        kind = "none";
        skipReason = "reset=none";
      } else if (headless) {
        kind = "none";
        skipReason =
          "headless session — the process itself is the context boundary; the driver starts a clean one each turn";
      } else {
        const thin = thinDocument({
          summary: p.summary,
          nextTask: p.next_task,
          artifacts: p.artifacts,
          status: status,
        });
        if (thin) {
          kind = "none";
          skipReason = `${thin} — snapshot written, context untouched. Rewrite this checkpoint with the full state and exact remaining steps if you really want a reset, otherwise keep working.`;
        } else if (ratio != null && ratio < RESET_MIN) {
          kind = "none";
          skipReason =
            `context at ${pct(usage!.tokens!, win)} is under the ${(RESET_MIN * 100).toFixed(0)}% reset floor ` +
            `(HANDOFF_RESET_MIN) — wiping it now costs more than it saves. Snapshot kept; keep working`;
        } else if (resetCount >= MAX_RESETS) {
          kind = "none";
          skipReason = `reset budget exhausted (${resetCount}/${MAX_RESETS}) — snapshot kept; run /cut manually if you still want a hard reset`;
        }
      }

      const brief = buildBrief({
        kind: "checkpoint",
        lane,
        status: status,
        summary: p.summary,
        blocked: p.blocked,
        nextTask: p.next_task,
        broadcast: p.broadcast,
        artifacts: p.artifacts,
        file,
        contextPct,
        note: kind === "none" && skipReason ? `note: ${skipReason}` : undefined,
      });
      broadcast(pi, ctx, brief);
      const savedLine = `Checkpoint saved to ${file}${contextPct ? ` (context ${contextPct})` : ""}.`;

      if (kind === "none") {
        return {
          content: [
            {
              type: "text",
              text: `${savedLine} Context untouched (${skipReason || "reset=none"}). Keep working — you are NOT done until you call finish.`,
            },
          ],
          details: { path: file, lane, status: status, reset: "none" as const, headless },
        };
      }

      armed = { kind, doc: md, file, lane };
      const note =
        kind === "compact"
          ? `At the end of THIS turn your context will be wiped and replaced by this document (no summarization cost — the document is the new context), then you will be nudged to continue from it. Do not rely on remembered detail afterwards.`
          : `When this run settles, /cut will start a brand-new session seeded with this document; the work continues there with zero inherited context.`;
      ctx.ui.notify(
        kind === "compact"
          ? `Checkpoint saved — context reset armed (compact). Finishing this turn clears it.`
          : `Checkpoint saved — hard session cut armed (/cut).`,
        "info",
      );

      return {
        content: [{ type: "text", text: `${savedLine} ${note} Keep working — you are NOT done until you call finish.` }],
        details: { path: file, lane, status: status, reset: kind },
      };
    },
  });

  // ── 1c. reset engine: feed the lane document to compaction as the summary ──
  pi.on("session_before_compact", async (event) => {
    if (!enabled) return;
    // only take over the one manual compaction we started ourselves;
    // a human /compact (with custom instructions) keeps pi's default logic.
    if (!ourCompactInFlight || !resetSummary) return;
    if (event.reason !== "manual") return;

    return {
      compaction: {
        summary: resetSummary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { handoffChainReset: true, source: activeLaneFile ?? INDEX_FILE },
      },
    };
  });

  // ── 1d. watermark watchdog + reset dispatch (both at turn_end: results are on disk) ──
  pi.on("turn_end", async (_event, ctx) => {
    if (!enabled) return;
    // 1) a snapshot is waiting to reset -> do that first, and skip the watermark nag this turn
    if (armed && !ourCompactInFlight && resetCount < MAX_RESETS) {
      const kind = armed.kind;
      if (kind === "session") {
        awaitingCut = true; // agent_settled performs the session replacement
        return;
      }
      // compact: clear in place. ctx.compact() aborts the current run first, so it may only fire at
      // turn_end (results already persisted) and never inside the tool's execute.
      // the body is parked in resetSummary first: measured, session_before_compact runs later than
      // agent_settled, so anything that clears armed in settle loses the document fed to compaction.
      resetSummary = handoffAsContext(armed.doc, armed.file);
      ourCompactInFlight = true;
      awaitingResume = true;
      resetCount += 1;
      ctx.ui.notify(
        `Checkpoint reset: clearing context and replacing it with ${armed.file} (reset ${resetCount}/${MAX_RESETS})`,
        "info",
      );
      ctx.compact({
        customInstructions: "Context reset to the checkpoint handoff document.",
        onError: (error: Error) => {
          if (!ourCompactInFlight) return; // session_compact_failed may have handled it already
          ourCompactInFlight = false;
          awaitingResume = false;
          armed = null;
          resetSummary = null;
          ctx.ui.notify(
            `Checkpoint reset failed: ${error.message}. Context left as-is; keep working or use /cut.`,
            "warning",
          );
        },
      });
      return;
    }

    // 2) watermark: past the line, force the landing directive
    if (watchdogFired) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null) return;
    const win = usage.contextWindow || (ctx.model as { contextWindow?: number })?.contextWindow || 128_000;
    const ratio = usage.tokens / win;
    if (ratio < WATERMARK) return;

    watchdogFired = true;
    ctx.ui.notify(
      `Context at ${(ratio * 100).toFixed(0)}% — forcing landing (watermark ${(WATERMARK * 100).toFixed(0)}%)`,
      "warning",
    );
    // steer: injected after this turn's tools and before the next LLM call, which breaks the
    // "one more small thing" habit
    pi.sendMessage(
      {
        customType: "handoff-chain",
        content:
          `⚠️ WATERMARK: context usage is ${(ratio * 100).toFixed(0)}% of the window. ` +
          `STOP starting new work. Right now: (1) commit any finished artifacts to disk, ` +
          `(2) call \`finish\` with status 'partial' and a fully self-contained next_task ` +
          `describing exactly what remains (assume the next agent has zero memory of this session), ` +
          `or 'done' if you are actually finished. If the task is long and only partly done, ` +
          `call \`checkpoint\` instead (reset 'auto' or 'compact') so this context is replaced by the document. ` +
          `Do not ask questions; land the plane.`,
        display: true,
      },
      { deliverAs: "steer" },
    );
  });

  // ── 1e. reset aftermath: push the agent back to work / dispatch the hard cut ──
  //
  // Why session_compact and not agent_settled for the resume:
  //   measured: compact()'s abort settles the agent first and the compaction itself comes later;
  //   and at session_compact the _compactionAbortController is still set, so pi rejects a message.
  //   session_compact/_failed is the only reliable signal that the reset really ran; then whenIdle
  //   polls until the state is clean. Never resume from settle: it would jump the gun.
  pi.on("session_compact", async (event, ctx) => {
    if (!ourCompactInFlight || event.reason !== "manual") return;
    ourCompactInFlight = false;
    const usedDoc = event.fromExtension;
    const resumeFile = armed?.file ?? activeLaneFile ?? join(ctx.cwd, INDEX_FILE);
    armed = null;
    resetSummary = null;
    if (!awaitingResume) return;
    awaitingResume = false;

    const before = event.compactionEntry.tokensBefore;
    ctx.ui.notify(
      usedDoc
        ? `Context reset to ${resumeFile}. Dropped ~${before.toLocaleString()} tokens of stale context.`
        : `Context reset ran, but pi's default summary won (another extension overrode it). Resuming anyway.`,
      usedDoc ? "info" : "warning",
    );
    whenIdle(
      ctx,
      () => pi.sendUserMessage(resumeMessage(resumeFile)),
      "resume after reset",
    );
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    if (!ourCompactInFlight) return;
    ourCompactInFlight = false;
    armed = null;
    resetSummary = null;
    awaitingResume = false;
    ctx.ui.notify(
      `Context reset failed (${event.errorMessage ?? "aborted"}). Context left as-is — keep working, or run /cut for a hard reset.`,
      "warning",
    );
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!enabled) return;
    if (!awaitingCut) return;
    awaitingCut = false;
    armed = null;
    if (!interactive(ctx.mode)) {
      ctx.ui.notify(
        `reset: 'session' needs an interactive session (headless uses one process per turn). Snapshot kept on disk.`,
        "warning",
      );
      return;
    }
    if (resetCount >= MAX_RESETS) {
      ctx.ui.notify(`Reset budget exhausted (${MAX_RESETS}). Skipping /cut.`, "warning");
      return;
    }
    resetCount += 1;
    cutArmedByTool = true; // /cut skips the human confirmation: the tool already asked for it
    // a tool context has no newSession(), so go through the command channel for a ctx that can
    // replace sessions. whenIdle is mandatory: a rejection such as "compaction in progress"
    // would simply swallow the /cut.
    whenIdle(ctx, () => {
      pi.sendUserMessage("/cut", { expandPromptTemplates: true });
    }, "auto /cut");
  });

  // ── 2. /next: chain a FRESH session from one lane's handoff ──────────
  //
  // usage: /next [lane] [-m <provider/id>|@model|model=x] [--default-model] [kickoff...]
  //   - lane: defaults to the most recent lane with an open next task; when several are open and
  //     the session is interactive, a picker is shown
  //   - model: the chained session inherits the current model by default (HANDOFF_CHAIN_MODEL=
  //     default` restores the old behaviour); `-m list` opens the model picker
  pi.registerCommand("next", {
    description: "Chain a FRESH session from a lane's handoff: /next [lane] [-m model] [kickoff]",
    getArgumentCompletions: (prefix: string) => {
      const words = (prefix ?? "").split(/\s+/);
      const last = words[words.length - 1] ?? "";
      const names = listLanes(lastCwd)
        .map((l) => l.lane)
        .filter((n) => n.startsWith(last.toLowerCase()));
      return names.length ? names.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      migrateLegacy(ctx.cwd, ctx);

      let tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const model = await takeModelArg(ctx, tokens);
      if (model.error) {
        ctx.ui.notify(`handoff-chain: ${model.error}`, "error");
        return;
      }
      tokens = model.rest;

      const lanes = listLanes(ctx.cwd);
      let legacyDoc: string | null = null;
      const rootPath = join(ctx.cwd, INDEX_FILE);
      if (!lanes.length && existsSync(rootPath)) {
        const rootDoc = readFileSync(rootPath, "utf8");
        if (isLaneDocText(rootDoc)) legacyDoc = rootDoc;
      }

      // a first token that names a known lane selects it; everything else is the kickoff text
      let laneName = "";
      if (tokens[0] && LANE_NAME_RE.test(tokens[0].toLowerCase())) {
        const cand = tokens[0].toLowerCase();
        if (lanes.some((l) => l.lane === cand) || (cand === LEGACY_LANE && legacyDoc)) {
          laneName = cand;
          tokens = tokens.slice(1);
        }
      }
      const kickoffArg = tokens.join(" ").trim();

      if (!lanes.length && !legacyDoc) {
        ctx.ui.notify(
          `No handoff found — nothing under \`${LANE_DIR}/\` and no ${INDEX_FILE}. Run \`checkpoint\` first.`,
          "error",
        );
        return;
      }

      if (!laneName && !legacyDoc) {
        const open = lanes.filter(isLaneOpen);
        const pool = open.length ? open : lanes;
        if (pool.length === 1) {
          laneName = pool[0].lane;
        } else if (ctx.hasUI) {
          const choices = pool.map(
            (l) => `${l.lane} — ${l.status} — ${l.next || l.summary || "(no next task)"}`,
          );
          const pick = await ctx.ui.select("Chain which lane?", choices);
          if (!pick) return;
          const idx = choices.indexOf(pick);
          laneName = idx >= 0 ? pool[idx].lane : pick.split(" — ")[0];
        } else {
          laneName = pool[0].lane;
        }
      }

      let doc: string;
      let file: string;
      let lane: string;
      if (legacyDoc) {
        doc = legacyDoc;
        file = rootPath;
        lane = LEGACY_LANE;
      } else {
        const meta = readLane(ctx.cwd, laneName || lanes[0].lane);
        if (!meta) {
          ctx.ui.notify(`No lane named \`${laneName}\`. /handoff lists them.`, "error");
          return;
        }
        doc = meta.doc;
        file = meta.file;
        lane = meta.lane;
      }

      const nextSection = readNextTask(doc);
      if (isChainEnd(nextSection) && !kickoffArg) {
        ctx.ui.notify(`Lane \`${lane}\` has no next task. Chain complete for it. 🎉`, "info");
        return;
      }

      // human gate: chain only after approval (drop the confirm for a fully automatic chain)
      await chainToFreshSession(pi, ctx, {
        doc,
        lane,
        kickoff: makeKickoff(doc, file, kickoffArg),
        confirmTitle: "Chain to a fresh session?",
        confirmBody: `Lane \`${lane}\` — next: ${oneLine(nextSection || doc, 140)}`,
        skipConfirm: false,
        modelSpec: model.modelArg,
      });
    },
  });

  // ── 2b. /cut: same task, a brand-new clean brain ─────────────────────
  // The difference from /next is intent only: /next chains to the NEXT task;
  // /cut zeroes the context and continues THIS task from the checkpoint.
  // checkpoint(reset:"session") dispatches /cut automatically once the run settles.
  pi.registerCommand("cut", {
    description: "Hard context reset: fresh session from your lane's handoff, same task continues",
    handler: async (args, ctx) => {
      migrateLegacy(ctx.cwd, ctx);
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const model = await takeModelArg(ctx, tokens);
      if (model.error) {
        ctx.ui.notify(`handoff-chain: ${model.error}`, "error");
        return;
      }
      const rest = model.rest;
      const argLane = slugify(rest[0] ?? "");

      let laneName = activeLaneName || laneBindings.get(sessionKey(ctx)) || "";
      if (argLane) laneName = argLane;
      let meta = laneName ? readLane(ctx.cwd, laneName) : null;
      if (!meta) meta = listLanes(ctx.cwd)[0] ?? null;

      let doc = meta?.doc ?? "";
      const file = meta?.file ?? join(ctx.cwd, INDEX_FILE);
      const lane = meta?.lane ?? LEGACY_LANE;
      if (!doc) {
        const rootDoc = existsSync(file) ? readFileSync(file, "utf8") : "";
        if (!isLaneDocText(rootDoc)) {
          ctx.ui.notify(`No handoff found — call \`checkpoint\` first.`, "error");
          cutArmedByTool = false;
          return;
        }
        doc = rootDoc;
      }
      const skipConfirm = cutArmedByTool;
      cutArmedByTool = false;
      const kickoffOverride = rest.length && slugify(rest[0] ?? "") === lane ? rest.slice(1).join(" ") : rest.join(" ");

      await chainToFreshSession(pi, ctx, {
        doc,
        lane,
        kickoff: makeKickoff(
          doc,
          file,
          kickoffOverride.trim() || undefined,
          "the previous context was hard-reset, so nothing but this document survived",
        ),
        confirmTitle: "Cut the context and continue in a fresh session?",
        confirmBody: `Lane \`${lane}\` — resuming: ${oneLine(readNextTask(doc) || doc, 140)}`,
        skipConfirm,
        modelSpec: model.modelArg,
      });
    },
  });

  // ── 3. /handoff: human view of the handoff state + the switch control plane ──
  //
  // /handoff                 list every lane (* = this session's lane)
  // /handoff <lane>          print one lane document
  // /handoff all             every lane: summary + path
  // /handoff status          resolved switch value + every source + lane list
  // /handoff on|off [scope]  write enable_handoff
  pi.registerCommand("handoff", {
    description: "List/show lanes: /handoff [lane|all] · switch: /handoff [status|on|off] [global|project]",
    getArgumentCompletions: (prefix: string) => {
      const last = (prefix ?? "").trim().split(/\s+/).pop() ?? "";
      const names = ["status", "all", "on", "off", ...listLanes(lastCwd).map((l) => l.lane)].filter((n) =>
        n.startsWith(last.toLowerCase()),
      );
      return names.length ? names.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "").toLowerCase();
      const scopeArg = (tokens[1] ?? "").toLowerCase();
      const reserved = ["status", "state", "config", "on", "off", "enable", "disable", "all"];

      // /handoff with no argument: list the lanes
      if (!sub) {
        migrateLegacy(ctx.cwd, ctx);
        const lanes = listLanes(ctx.cwd);
        if (!lanes.length) {
          const p = join(ctx.cwd, INDEX_FILE);
          if (!existsSync(p)) {
            ctx.ui.notify("No HANDOFF.md yet.", "info");
            return;
          }
          ctx.ui.notify(readFileSync(p, "utf8").split("\n").slice(0, 14).join("\n"), "info");
          return;
        }
        const here = laneBindings.get(sessionKey(ctx));
        ctx.ui.notify(
          [
            `lanes in ${LANE_DIR}/ (${lanes.length}) — * = this session's lane`,
            ...lanes.map(
              (l) =>
                `${l.lane === here ? "*" : " "} ${l.lane.padEnd(20)} ${l.status.padEnd(12)} ${(l.contextPct || "-").padEnd(
                  5,
                )} ${oneLine(l.next || l.summary, 66)}`,
            ),
            `/handoff <lane> to read one · /next <lane> to chain one`,
          ].join("\n"),
          "info",
        );
        return;
      }

      // /handoff <lane>: print that one lane document
      if (!reserved.includes(sub)) {
        migrateLegacy(ctx.cwd, ctx);
        const meta = readLane(ctx.cwd, sub);
        if (!meta) {
          ctx.ui.notify(`No lane \`${sub}\`. /handoff lists them.`, "error");
          return;
        }
        ctx.ui.notify(`${meta.file}\n\n${meta.doc.split("\n").slice(0, 60).join("\n")}`, "info");
        return;
      }

      // /handoff status: resolved switch value and which layer wins — that is what tuning reads
      if (["status", "state", "config"].includes(sub)) {
        const show = (v: unknown) => (v === undefined ? "(absent)" : JSON.stringify(v));
        const visible = HANDOFF_TOOLS.filter((t) => pi.getActiveTools().includes(t));
        ctx.ui.notify(
          [
            `${SETTINGS_KEY} = ${enabled}  (source: ${enabledSource})`,
            `  project  ${settingsPath("project", ctx.cwd)}: ${show(readSettings("project", ctx.cwd)?.[SETTINGS_KEY])}`,
            `  global   ${settingsPath("global", ctx.cwd)}: ${show(readSettings("global", ctx.cwd)?.[SETTINGS_KEY])}`,
            `  env HANDOFF_ENABLED: ${show(process.env.HANDOFF_ENABLED)}`,
            `tools visible to the model: ${visible.join(", ") || "(none)"}`,
            `this session's lane: ${activeLaneName || laneBindings.get(sessionKey(ctx)) || "(not bound yet)"}`,
            `lanes: ${
              listLanes(ctx.cwd)
                .map((l) => `${l.lane}(${l.status})`)
                .join(", ") || "(none)"
            }`,
            `reset floor ${(RESET_MIN * 100).toFixed(0)}% · min doc ${RESET_MIN_DOC_CHARS} chars · default reset ${DEFAULT_RESET}`,
            `on/off takes effect in this session immediately and in others on their next run.`,
          ].join("\n"),
          enabled ? "info" : "warning",
        );
        return;
      }

      // /handoff all: every lane's summary plus path
      if (sub === "all") {
        const lanes = listLanes(ctx.cwd);
        ctx.ui.notify(
          lanes.length
            ? lanes.map((l) => `${l.file}\n  ${l.status} · ${oneLine(l.summary, 110)}`).join("\n")
            : `no lanes under ${LANE_DIR}/`,
          "info",
        );
        return;
      }

      // /handoff on|off [global|project]
      const value = ["on", "enable", "true", "1"].includes(sub)
        ? true
        : ["off", "disable", "false", "0"].includes(sub)
          ? false
          : undefined;
      if (value === undefined) {
        ctx.ui.notify(
          `Unknown \`/handoff ${sub}\`. Use: /handoff (list) | <lane> | all | status | on | off [global|project]`,
          "error",
        );
        return;
      }

      let scope: Scope = "global";
      if (["project", "proj", "local"].includes(scopeArg)) scope = "project";
      else if (scopeArg && !["global", "user"].includes(scopeArg)) {
        ctx.ui.notify(`Unknown scope \`${scopeArg}\` (global or project). Using global.`, "warning");
      }

      const p = settingsPath(scope, ctx.cwd);
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          value ? "Enable handoff-chain?" : "Disable handoff-chain?",
          `Write "${SETTINGS_KEY}": ${value} to ${p} — other settings in that file are preserved.`,
        );
        if (!ok) return;
      }

      const res = writeEnabled(scope, ctx.cwd, value);
      if (res.error) {
        ctx.ui.notify(`Could not write ${p}: ${res.error}`, "error");
        return;
      }
      syncEnabled(pi, ctx);
      ctx.ui.notify(
        `${SETTINGS_KEY}: ${value} → ${p}. handoff-chain ${
          value ? "ON — finish/checkpoint visible again" : "OFF — tools hidden, watchdog + context resets paused"
        }.`,
        value ? "info" : "warning",
      );
    },
  });
}
