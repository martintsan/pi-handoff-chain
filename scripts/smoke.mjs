/**
 * smoke.mjs — dependency-free behavioural gate for the handoff-chain extension.
 *
 * Loads the real extension file (Node type-stripping, no build step, no LLM)
 * against a mock ExtensionAPI and asserts the protocol behaviour a typecheck
 * cannot prove:
 *
 *   1. lanes       — parallel sessions get their own lane docs
 *   2. migration   — a legacy single HANDOFF.md is moved into .pi/handoff/legacy.md
 *   3. index       — root HANDOFF.md becomes a generated index (still parseable)
 *   4. no clobber  — one session's checkpoint never rewrites another lane
 *   5. broadcast   — finish/checkpoint append a brief entry; finish terminates
 *   6. reset gate  — thin checkpoint does not reset context
 *   7. reset gate  — substantial checkpoint below the floor does not reset
 *   8. reset gate  — substantial checkpoint above the floor arms the reset and
 *                    dispatches ctx.compact(), then resumes the agent
 *   9. commands    — /handoff list + status, /next and /cut registered
 *
 * Run: node scripts/smoke.mjs   (or: npm run smoke)
 * Exit 0 = all checks passed; any failure prints FAIL lines and exits 1.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOD = new URL("../extensions/handoff-chain.ts", import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
    failures.push(name);
  }
}

const notifyLog = [];
const handlerRegistry = new WeakMap();

/** Minimal stand-in for pi's ExtensionAPI. */
function makePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const sent = [];
  const active = { tools: ["finish", "checkpoint"] };
  const calls = { setModel: [], setThinkingLevel: [] };
  const pi = {
    tools,
    commands,
    handlers,
    entries,
    sent,
    active,
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (n, o) => commands.set(n, o),
    registerEntryRenderer: (t, fn) => handlers.set(`renderer:${t}`, [fn]),
    on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
    appendEntry: (t, d) => entries.push({ type: t, data: d }),
    getActiveTools: () => active.tools,
    setActiveTools: (t) => (active.tools = t),
    sendMessage: (m) => sent.push(m),
    sendUserMessage: (m) => sent.push(m),
    setModel: async (m) => {
      calls.setModel.push(m);
      return true;
    },
    setThinkingLevel: (l) => void calls.setThinkingLevel.push(l),
    getSessionName: () => undefined,
    calls,
  };
  handlerRegistry.set(pi, handlers);
  return pi;
}

/** Minimal stand-in for ExtensionContext (tool/command handler context). */
/** ctx.sendUserMessage lands in the pi mock's `sent` list of the active test */
let sentSink = { push: () => {} };
const sentPush = (m) => sentSink.push(m);

function makeCtx(cwd, { sessionFile = "/tmp/sess-a.jsonl", tokens = 5_000, contextWindow = 128_000 } = {}) {
  const compactCalls = { n: 0 };
  const models = [
    { id: "test-model", provider: "test", contextWindow },
    { id: "big-model", provider: "other", contextWindow: 200_000 },
  ];
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: false,
    model: models[0],
    scopedModels: models.map((model) => ({ model })),
    modelRegistry: {
      find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
      getAvailable: () => models,
    },
    getContextUsage: () => ({ tokens, contextWindow }),
    isIdle: () => true,
    async waitForIdle() {},
    sendUserMessage: (m) => void sentPush(m),
    compact: () => void compactCalls.n++,
    compactCalls,
    newSessionCalls: [],
    setupSm: null,
    async newSession(opts) {
      this.newSessionCalls.push(opts);
      const sm = {
        messages: [],
        modelChanges: [],
        appendMessage: (m) => sm.messages.push(m),
        appendModelChange: (provider, id) => sm.modelChanges.push(`${provider}/${id}`),
        getSessionFile: () => "/tmp/sess-child.jsonl",
      };
      this.setupSm = sm;
      if (opts?.setup) await opts.setup(sm);
      if (opts?.withSession) await opts.withSession(this);
      return { cancelled: false };
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionName: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
    },
    ui: {
      notify: (m) => void notifyLog.push(m),
      select: async () => null,
      confirm: async () => true,
    },
  };
  return ctx;
}

async function fire(pi, event, payload, ctx) {
  for (const fn of handlerRegistry.get(pi).get(event) ?? []) await fn(payload, ctx);
}

const laneFile = (cwd, lane) => join(cwd, ".pi/handoff", `${lane}.md`);
const listLanes = (cwd) => {
  const dir = join(cwd, ".pi/handoff");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : [];
};

function oldStyleHandoff(task, ts) {
  return `# HANDOFF — ${ts}

## Status
in-progress

## What was done
${task}

## Key decisions
- (none)

## Artifacts
- (none)

## Next task
finish ${task}

## Open issues / risks
(none)

---
previous-session: /tmp/old-session.jsonl
produced-by: pi / handoff-chain
validator: handoff written via finish tool with terminate:true
`;
}

/** A checkpoint document complete enough to work from blind. */
const SUBSTANTIAL = {
  status: "in-progress",
  summary:
    "Implemented scripts/export_daily.py which parses pi session logs into per-day markdown, wired the " +
    "Anytype sync client (scripts/anytype_sync.py) against the Local API v1, and verified idempotency twice " +
    "against the live space: re-running the sync archives the previous object and creates exactly one new one. " +
    "Decided to key entries by date+time+slug so re-runs never duplicate anything, and to keep the day index " +
    "object id in .state/anytype.json keyed by date rather than scraping the space for it. Remaining work is " +
    "the archive/maintenance helper plus README/AGENTS documentation; both were specced in the ticket and the " +
    "API endpoints they need (DELETE /v1/spaces/{id}/objects/{id}) were probed and confirmed working.",
  next_task:
    "Write scripts/anytype_archive.py to move stale objects to the Bin via DELETE, add a --prune-defaults " +
    "mode that archives the template objects a fresh space ships with, then document the whole loop in " +
    "README.md (export -> sync -> archive) and run scripts/daily.sh from a clean checkout and diff the output " +
    "against the objects currently live in the space before committing.",
  artifacts: ["scripts/export_daily.py", "scripts/anytype_sync.py"],
};

async function main() {
  const mod = await import(`${MOD}?t=${Math.random()}`);

  // ── 1-5: lanes, migration, index, no clobber, broadcast ──────────
  console.log("lanes / migration / finish broadcast");
  const cwd = mkdtempSync(join(tmpdir(), "hc-lanes-"));
  writeFileSync(join(cwd, "HANDOFF.md"), oldStyleHandoff("task A", "2026-11-01T00:00:00.000Z"));

  const pi = makePi();
  mod.default(pi);
  sentSink = pi.sent;
  check("finish + checkpoint tools registered", !!pi.tools.get("finish") && !!pi.tools.get("checkpoint"));

  const finish = pi.tools.get("finish");
  const checkpoint = pi.tools.get("checkpoint");
  const ctxA = makeCtx(cwd, { sessionFile: "/tmp/sess-a.jsonl" });
  await fire(pi, "session_start", {}, ctxA);

  const resA = await finish.execute(
    "t1",
    { status: "done", summary: "Task A shipped end to end.", broadcast: "A shipped\nIssues: none", next_task: "" },
    undefined,
    undefined,
    ctxA,
  );
  check("finish terminates the session", resA?.terminate === true);
  check("finish result carries the brief", /A shipped/.test(resA.content[0].text), resA.content[0].text);
  check("legacy HANDOFF.md migrated into a lane", existsSync(laneFile(cwd, "legacy")));
  const index1 = readFileSync(join(cwd, "HANDOFF.md"), "utf8");
  check("root HANDOFF.md became an index", index1.includes("handoff-chain:index"));
  check("index keeps the legacy next task parseable", /^## Next task$/m.test(index1));

  // a second session on a different task must not touch the first lane
  const ctxB = makeCtx(cwd, { sessionFile: "/tmp/sess-b.jsonl" });
  await fire(pi, "session_start", {}, ctxB);
  await checkpoint.execute(
    "t2",
    { ...SUBSTANTIAL, summary: `${SUBSTANTIAL.summary} Session B owns the bugfix thread.` },
    undefined,
    undefined,
    ctxB,
  );
  check("first lane untouched by the second session", readFileSync(laneFile(cwd, "legacy"), "utf8").includes("task A"));
  const lanesB = listLanes(cwd);
  check("second session got its own lane", lanesB.length >= 2, `lanes: ${lanesB.join(", ")}`);
  const index2 = readFileSync(join(cwd, "HANDOFF.md"), "utf8");
  check("index lists every lane", lanesB.every((l) => index2.includes(l)));
  check(
    "brief entries appended",
    pi.entries.filter((e) => e.type === "handoff-brief").length >= 2,
    JSON.stringify(pi.entries.map((e) => e.type)),
  );
  check("lane binding persisted", pi.entries.some((e) => e.type === "handoff-lane"));
  check("brief renderer registered", handlerRegistry.get(pi).has("renderer:handoff-brief"));

  // explicit lane param wins and stays sticky for that session
  await checkpoint.execute("t3", { ...SUBSTANTIAL, lane: "bug-i18n" }, undefined, undefined, ctxB);
  check("explicit lane param honoured", existsSync(laneFile(cwd, "bug-i18n")));
  await checkpoint.execute("t4", SUBSTANTIAL, undefined, undefined, ctxB);
  check("lane stays sticky within a session", readFileSync(laneFile(cwd, "bug-i18n"), "utf8").includes("bug-i18n"));

  // ── 6-8: reset gate ──────────────────────────────────────────────
  console.log("checkpoint reset gate");
  const cwd2 = mkdtempSync(join(tmpdir(), "hc-reset-"));
  mkdirSync(join(cwd2, ".pi/handoff"), { recursive: true });
  const pi2 = makePi();
  mod.default(pi2);
  sentSink = pi2.sent;
  const low = makeCtx(cwd2, { sessionFile: "/tmp/sess-low.jsonl", tokens: 8_000 });
  await fire(pi2, "session_start", {}, low);

  const noneRes = await checkpoint.execute(
    "c1",
    { status: "in-progress", summary: "quick note", reset: "none" },
    undefined,
    undefined,
    low,
  );
  check("reset=none keeps context", /Context untouched \(reset=none\)/.test(noneRes.content[0].text));

  const thinRes = await checkpoint.execute("c2", { status: "in-progress", summary: "quick note" }, undefined, undefined, low);
  check("thin document blocks the reset", /too thin/.test(thinRes.content[0].text), thinRes.content[0].text);

  const floorRes = await checkpoint.execute("c3", SUBSTANTIAL, undefined, undefined, low);
  check("substantial doc under the floor does not reset", /reset floor/.test(floorRes.content[0].text), floorRes.content[0].text);
  check("no compaction requested yet", low.compactCalls.n === 0);

  const high = makeCtx(cwd2, { sessionFile: "/tmp/sess-high.jsonl", tokens: 60_000 });
  await fire(pi2, "session_start", {}, high);
  const armedRes = await checkpoint.execute("c4", SUBSTANTIAL, undefined, undefined, high);
  check("substantial doc above the floor arms the reset", /context will be wiped/.test(armedRes.content[0].text), armedRes.content[0].text);
  await fire(pi2, "turn_end", {}, high);
  check("turn_end dispatched ctx.compact()", high.compactCalls.n === 1);

  const before = await fireResult(pi2, "session_before_compact", {
    reason: "manual",
    preparation: { firstKeptEntryId: "e1", tokensBefore: 60_000 },
  }, high);
  check(
    "compaction summary is replaced by the lane document",
    !!before?.compaction && String(before.compaction.summary).includes("checkpoint-handoff"),
  );
  await fire(pi2, "session_compact", {
    reason: "manual",
    fromExtension: true,
    compactionEntry: { tokensBefore: 60_000 },
  }, high);
  await sleep(150);
  check("agent resumed after the reset", pi2.sent.some((m) => String(m).includes("Context was just reset")));

  // ── 9: commands ──────────────────────────────────────────────────
  console.log("commands");
  const handoff = pi.commands.get("handoff");
  const ctxList = makeCtx(cwd, { sessionFile: "/tmp/sess-a.jsonl" });
  await fire(pi, "session_start", {}, ctxList);
  await handoff.handler("", ctxList);
  check("/handoff lists lanes", notifyLog.some((m) => m.includes("lanes in .pi/handoff")));
  await handoff.handler("status", ctxList);
  check("/handoff status answers", notifyLog.some((m) => m.includes("enable_handoff")));
  await handoff.handler("legacy", ctxList);
  check("/handoff <lane> reads one lane", notifyLog.some((m) => m.includes("legacy.md")));
  check("/next registered", !!pi.commands.get("next"));
  check("/cut registered", !!pi.commands.get("cut"));

  // ── 10: chain model selection ────────────────────────────────────
  console.log("chain model selection (/next -m)");
  const cwd3 = mkdtempSync(join(tmpdir(), "hc-model-"));
  mkdirSync(join(cwd3, ".pi/handoff"), { recursive: true });
  writeFileSync(
    join(cwd3, ".pi/handoff/demo.md"),
    "# HANDOFF — 2026-11-25T00:00:00.000Z\n\n## Status\nin-progress\n\n## What was done\ndid things\n\n## Next task\nkeep going\n\n## Open issues / risks\n(none)\n\n---\nlane: demo\nstatus: in-progress\n",
  );
  const pi3 = makePi();
  mod.default(pi3);
  const cmdCtx = makeCtx(cwd3, { sessionFile: "/tmp/sess-cmd.jsonl" });
  await fire(pi3, "session_start", {}, cmdCtx);

  await pi3.commands.get("next").handler("demo -m other/big-model", cmdCtx);
  check("/next chained a fresh session", cmdCtx.newSessionCalls.length === 1);
  check(
    "requested model set on the chained session",
    pi3.calls.setModel.some((m) => m?.id === "big-model"),
    JSON.stringify(pi3.calls.setModel.map((m) => m?.id)),
  );
  const injected = String(cmdCtx.setupSm?.messages?.[0]?.content?.[0]?.text ?? "");
  check("lane document injected into the new session", injected.includes("keep going"));
  check("lane marker injected for the child session", injected.includes("handoff-lane: demo"));
  check("model change recorded on the new session", (cmdCtx.setupSm?.modelChanges ?? []).includes("other/big-model"));

  pi3.calls.setModel.length = 0;
  cmdCtx.newSessionCalls.length = 0;
  await pi3.commands.get("next").handler("demo", cmdCtx);
  check(
    "no -m inherits the current model",
    pi3.calls.setModel.some((m) => m?.id === "test-model"),
    JSON.stringify(pi3.calls.setModel.map((m) => m?.id)),
  );

  pi3.calls.setModel.length = 0;
  cmdCtx.newSessionCalls.length = 0;
  notifyLog.length = 0;
  await pi3.commands.get("next").handler("demo -m nope/no-such-model", cmdCtx);
  check("unknown model refused before any session switch", cmdCtx.newSessionCalls.length === 0);
  check("unknown model spec explains itself", notifyLog.some((m) => /not available|no model matching/.test(m)));

  pi3.calls.setModel.length = 0;
  cmdCtx.newSessionCalls.length = 0;
  await pi3.commands.get("next").handler("demo --default-model", cmdCtx);
  check(
    "--default-model chains without touching the model",
    cmdCtx.newSessionCalls.length === 1 && pi3.calls.setModel.length === 0,
  );

  pi3.calls.setModel.length = 0;
  cmdCtx.newSessionCalls.length = 0;
  await pi3.commands.get("next").handler("demo other:high", cmdCtx);
  check("bare `provider:thinking` style spec still chains", cmdCtx.newSessionCalls.length === 1);

  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}

async function fireResult(pi, event, payload, ctx) {
  let out;
  for (const fn of handlerRegistry.get(pi).get(event) ?? []) out = await fn(payload, ctx);
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
