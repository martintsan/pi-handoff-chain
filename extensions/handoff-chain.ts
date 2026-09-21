/**
 * handoff-chain.ts — Kill & Handoff 接力协议 for pi
 *
 * 工作流：
 *   1. Agent 干活，任务完成时调用 `finish`（由 promptGuidelines 约束）
 *   2. finish 把交接文档写入磁盘 HANDOFF.md，然后返回 terminate:true
 *      → pi 在工具批次结束后立即停止，不再追加 LLM 输出（杀胜利巡游）
 *   3. 人审查 HANDOFF.md（人类闸门），满意后输入 /next
 *   4. /next 读取 HANDOFF.md → ctx.newSession() 开全新会话
 *      → 以 handoff 文档为初始上下文 → 自动发送 kickoff 指令继续下一个任务
 *
 * 上下文重置引擎（本文件的核心）：
 *   checkpoint 只落盘是**不够**的 —— 同一会话越写越长，文档永远不是上下文的
 *   来源，后面再"重新读一遍文档"时，新的文档要和一整屏陈旧上下文竞争话语权，
 *   接力形同虚设。所以 checkpoint 必须是**上下文重置点**，而不只是日志点。
 *
 *   三档重置（checkpoint 的 reset 参数，默认 compact）：
 *     none     只落盘，不动上下文（旧行为，需要显式指定）
 *     compact  就地清空：本轮工具跑完（turn_end，结果已持久化）后触发 compaction，
 *              并用 session_before_compact 把 summary 直接替换成刚写好的 HANDOFF.md。
 *              → 零 LLM 成本的重置：文档本身就是新上下文；
 *                随后 agent_settled 时自动推一条"从文档继续"的消息，工作不断线。
 *     session  硬切换：本轮 settle 后以 /cut 拉起全新会话（同 /next，但沿用同一任务），
 *              上下文 100% 归零，只剩注入的 handoff 文档。
 *
 *   时序约束（为什么不能在 checkpoint 的 execute 里直接清上下文）：
 *     - 工具的 ctx 是 ExtensionContext，只有 compact()，没有 newSession()；
 *       newSession() 只在命令上下文（ExtensionCommandContext）里可用。
 *     - ctx.compact() 内部会先 abort 当前 run。在 execute 里调用会把正在执行的
 *       工具批次一起打掉，结果可能落不进会话。所以一律延后到 turn_end。
 *     - 会话替换同理延后到 agent_settled（此时 _isAgentRunActive 已为 false），
 *       再通过 sendUserMessage("/cut", {expandPromptTemplates:true}) 走命令通道，
 *       拿到带 newSession() 的命令上下文。
 *
 * 放在 .pi/extensions/handoff-chain.ts（项目级，需项目被信任后加载）
 * 或 ~/.pi/agent/extensions/handoff-chain.ts（全局）
 *
 * 总开关：settings.json 里的 `enable_handoff`（见下方开关一节）。
 *   优先级：HANDOFF_ENABLED 环境变量 > .pi/settings.json > ~/.pi/agent/settings.json > true
 *   关掉后不是“注册但罢工”，而是对模型不存在：finish/checkpoint 从 active tools
 *   移除（连 promptSnippet / promptGuidelines 一起消失），所有事件处理器 early-return，
 *   /next /cut 拒绝接力。控制面：/handoff [status | on | off] [global|project]。
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HANDOFF_FILE = "HANDOFF.md";

// ── 总开关：settings.json 里的 enable_handoff ──────────────────────
//
// pi 没有给扩展暴露读 settings 的 API（ExtensionContext / ExtensionAPI 里都没有），
// 但 settings.json 对未知顶层键是透传的，所以扩展自己读自己写。
// 优先级（高 → 低）：
//   环境变量 HANDOFF_ENABLED（单次运行覆盖，headless / 测试用）
//   项目  <cwd>/.pi/settings.json           →  "enable_handoff": true|false
//   全局  ~/.pi/agent/settings.json          →  "enable_handoff": true|false
//   默认  true（保持插件一贯行为；要关就显式写 false）
//
// 关掉之后不是“注册了但罢工”，而是根本不当存在：
//   - finish / checkpoint 从 active tools 里移除→ 模型看不见，system prompt 里的
//     promptSnippet / promptGuidelines 也跟着消失
//   - 所有事件处理器直接 early-return（不会重置上下文、不会推 watermark）
//   - /next /cut 拒绝接力；/handoff 保留作控制面（on / off / status）
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
    return null; // 坏文件：不拦，让默认值生效
  }
}

/** 宽容解析：布尔 / "true|false|on|off|yes|no|1|0"；认不出就返回 undefined（交给下一级） */
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

/** 读-改-写，只动一个键，其他设置原样保留 */
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


// 水位线：上下文用到窗口的 60% 就强制落盘（留出写完交接+余量）
const WATERMARK = Number(process.env.HANDOFF_WATERMARK ?? 0.6);

// checkpoint 默认重置档位：none | compact | session
type ResetKind = "none" | "compact" | "session";
const DEFAULT_RESET: ResetKind = pickReset(process.env.HANDOFF_CHECKPOINT_RESET, "compact");

// 熔断：单次会话里自动重置的次数上限（防止 agent 每轮都 checkpoint 造成 复位→重启 抖动）
const MAX_RESETS = Number(process.env.HANDOFF_MAX_RESETS ?? 12);

function pickReset(v: string | undefined, fallback: ResetKind): ResetKind {
  return v === "none" || v === "compact" || v === "session" ? v : fallback;
}

// ── 看门狗 / 重置引擎状态（进程内，session_start 时全部清零）──────
//
// 状态机（时序全是实测出来的，不是猜的）：
//   checkpoint.execute   → armed = { kind, doc }
//   turn_end             → compact: resetSummary 定弹 + ourCompactInFlight=true + ctx.compact()
//   session_before_compact→ 用 resetSummary 顶替默认 summary（零 LLM 成本）
//   session_compact/_failed → 清旗，然后等 idle 推 RESUME
//   agent_settled         → compact 的 abort 会先 settle（实测），所以这里只做兑底；
//                          session 档在这里派发 /cut
//
// ⚠ 实测的两个坑（曾导致重置“看起来没生效”）：
//   1) ctx.compact() 是 fire-and-forget，session_before_compact 在 agent_settled **之后**才跑。
//      所以喂给 compaction 的文档必须单独存在 resetSummary 里，不能被 settle 处理器清掉。
//   2) compaction 进行中 `pi.sendUserMessage()` 会直接报错：
//      "Cannot submit a prompt while compaction is in progress"。
//      所有重启消息必须先 whenIdle()，不能 setTimeout(0) 就发。
let watchdogFired = false;

/** 总开关的当前生效值（session_start / agent_start / /handoff 时刷新） */
let enabled = true;
let enabledSource = "default (key absent)";
/** 开关关掉时我们主动从 active tools 里摸掉的工具，开关打开时只送回这些 */
let hiddenBySwitch: string[] = [];

/**
 * 重读开关，并同步工具可见性。
 * 只在 session_start / agent_start / 手动 /handoff 时调：
 * 不在 before_agent_start 里改——那一轮的工具 loadout 正在算，容易抢跑。
 * 改完 settings.json 后，下一轮 run / 下一个会话生效，或者直接 /handoff on|off。
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
    // 拿不到工具列表也不能让开关并置错
  }

  if (was && !enabled) {
    // 关闸：把还在飞的重置/看门狗全抹掉
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

/** 已落盘、等待执行的 reset（在 turn_end 消费） */
let armed: { kind: "compact" | "session"; doc: string } | null = null;
/** 本轮重置的上下文正文；单独保存，不能跟着 armed 一起被 settle 清掉 */
let resetSummary: string | null = null;
/** true = 正在跑我们自己发起的 compaction（用来把 summary 换成 handoff 文档） */
let ourCompactInFlight = false;
/** compact 完成后需要把 agent 重新推起来 */
let awaitingResume = false;
/** settle 后需要发起 /cut（全新会话） */
let awaitingCut = false;
/** /cut 是由 checkpoint 自动触发的，跳过人工确认 */
let cutArmedByTool = false;
/** 本会话已自动重置次数（熔断用） */
let resetCount = 0;

function disarm(): void {
  armed = null;
  resetSummary = null;
  awaitingResume = false;
  awaitingCut = false;
}

/**
 * 等到完全空闲（无 run、无 compaction、无重试）再执行。
 * compaction 会话内是异步的，比 agent_settled 更晚结束，必须轮询。
 */
function whenIdle(ctx: ExtensionContext, fn: () => void, what = "dispatch", budgetMs = 20_000): void {
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
      ctx.ui.notify(`${what} skipped: session never went idle (${budgetMs}ms).`, "warning");
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

function renderHandoff(p: {
  status: string;
  summary: string;
  artifacts?: string[];
  decisions?: string[];
  nextTask?: string;
  blocked?: string;
  sessionFile: string | null;
  contextPct?: string;
}): string {
  const ts = new Date().toISOString();
  const bullets = (arr?: string[]) =>
    arr && arr.length ? arr.map((s) => `- ${s}`).join("\n") : "- (none)";
  return `# HANDOFF — ${ts}

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
previous-session: ${p.sessionFile ?? "ephemeral"}
${p.contextPct ? `context-at-write: ${p.contextPct}\n` : ""}produced-by: pi / handoff-chain
validator: handoff written via finish tool with terminate:true
`;
}

/**
 * 把 handoff 文档变成"重置后的上下文正文"。
 * 作为 compaction 的 summary 注入 → 旧对话被丢弃，文档成为唯一可信记录。
 * 因为 summary 是我们自己写的，这一步不花任何 LLM token。
 */
function handoffAsContext(doc: string): string {
  return [
    `<checkpoint-handoff authoritative="true">`,
    doc.trim(),
    `</checkpoint-handoff>`,
    ``,
    `CONTEXT RESET: every turn before this checkpoint has been dropped from the conversation.`,
    `The document above is the ONLY trustworthy record of prior work. Anything you seem to`,
    `remember that contradicts it is wrong — re-read the files listed under "Artifacts" when`,
    `you need detail. Recent turns kept after the reset boundary are still visible.`,
  ].join("\n");
}

const RESUME_MESSAGE = [
  `Context was just reset to the checkpoint in ${HANDOFF_FILE}.`,
  `Your prior conversation is gone; the checkpoint document is now the only record of what was done.`,
  `Continue: re-read ${HANDOFF_FILE} from disk, verify the "Artifacts" still exist, then keep working`,
  `on the remaining task. Call \`checkpoint\` at the next milestone and \`finish\` when the contract is met.`,
].join(" ");

/** 共享的"开新会话接力"逻辑：/next 与 /cut 都走这里 */
async function chainToFreshSession(
  ctx: ExtensionCommandContext,
  opts: { doc: string; kickoff: string; confirmTitle: string; confirmBody: string; skipConfirm: boolean }
): Promise<void> {
  if (!opts.skipConfirm) {
    const ok = await ctx.ui.confirm(opts.confirmTitle, opts.confirmBody);
    if (!ok) return;
  }

  // 若在 agent 还在跑时下达指令，先等它 settle，避免会话替换冲突
  await ctx.waitForIdle();

  const parentSession = ctx.sessionManager.getSessionFile?.() ?? undefined;
  const inject = [
    `<handoff-from-previous-session>`,
    opts.doc,
    `</handoff-from-previous-session>`,
    ``,
    `This document is the authoritative record of prior work. Trust it over any assumption.`,
    `Chain protocol: verify artifacts on disk → execute the task → end with \`finish\`.`,
  ].join("\n");

  const result = await ctx.newSession({
    parentSession,
    setup: async (sm) => {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: inject }],
        timestamp: Date.now(),
      });
    },
    withSession: async (freshCtx) => {
      await freshCtx.sendUserMessage(opts.kickoff);
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("New session was cancelled by an extension.", "warning");
  }
}

function readNextTask(doc: string): string {
  return (
    doc
      .split(/^## Next task$/m)[1]
      ?.split(/^## /m)[0]
      ?.trim() ?? ""
  );
}

function isChainEnd(nextSection: string): boolean {
  return !nextSection || nextSection.startsWith("(none") || /chain ends here/i.test(nextSection);
}

function makeKickoff(doc: string, override?: string, resumeNote?: string): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  const nextSection = readNextTask(doc);
  const what = isChainEnd(nextSection)
    ? `reconstruct the remaining work from the "What was done" and "Open issues / risks" sections and continue toward the original goal`
    : `execute the "Next task" section of the handoff`;
  return (
    `You are continuing a task chain as a FRESH agent with no memory of previous sessions. ` +
    `Read ${HANDOFF_FILE} at the project root (already provided above), verify the listed artifacts on disk, ` +
    `then ${what}${resumeNote ? ` — ${resumeNote}` : ""}. ` +
    `When done, call the \`finish\` tool as your final action.`
  );
}

export default function (pi: ExtensionAPI) {
  // 每一轮 run 重新开始计警告（重置后的 resume 也是一轮新 run），并刷新开关
  pi.on("agent_start", async (_event, ctx) => {
    watchdogFired = false;
    syncEnabled(pi, ctx);
  });

  // 每次会话开始（含 /new、/resume、/cut 之后的新会话）先读开关，
  // 再清空进程内残留状态——否则上一个会话遗留的 armed reset 会把新会话立刻打去 compaction。
  pi.on("session_start", async (_event, ctx) => {
    syncEnabled(pi, ctx);
    watchdogFired = false;
    armed = null;
    resetSummary = null;
    ourCompactInFlight = false;
    awaitingResume = false;
    awaitingCut = false;
    cutArmedByTool = false;
    resetCount = 0;
    if (!enabled) {
      ctx.ui.notify(
        `${SETTINGS_KEY}: false (${enabledSource}) — handoff-chain 已关闭。恢复：/handoff on`,
        "info"
      );
    }
  });

  // ── 1. finish 工具：交接落盘 + 立刻终止本会话 ──────────────────
  pi.registerTool({
    name: "finish",
    label: "Finish & Handoff",
    description:
      "End your task. Writes the handoff document to HANDOFF.md and stops this agent immediately. Call this as your FINAL action when your task's artifacts are already saved to disk. Do NOT return long summaries in chat — put everything into this tool's arguments.",
    promptSnippet:
      "finish: write HANDOFF.md with summary/decisions/artifacts/next task and stop",
    promptGuidelines: [
      "When your assigned task is complete (all artifacts written to disk), call `finish` as your final action instead of writing a long summary message.",
      "Before calling `finish`, verify your artifacts exist. `finish` marks the end of your session; you cannot continue afterwards.",
      "Fill `next_task` with a self-contained task description a fresh agent (with NO memory of this session) can execute alone.",
      "If blocked, set status='blocked' and explain in `blocked`. Do not claim completion when blocked.",
    ],
    parameters: Type.Object({
      status: StringEnum(["done", "partial", "blocked"] as const),
      summary: Type.String({ description: "What was accomplished, 2-5 sentences" }),
      artifacts: Type.Optional(
        Type.Array(Type.String(), { description: "Paths of files created/modified" })
      ),
      decisions: Type.Optional(
        Type.Array(Type.String(), {
          description: "Key decisions made and why (one line each)",
        })
      ),
      next_task: Type.Optional(
        Type.String({
          description:
            "Self-contained next task for the next fresh agent. Empty if chain is complete.",
        })
      ),
      blocked: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      if (!enabled) {
        return { content: [{ type: "text", text: disabledMessage() }], details: { disabled: true } };
      }
      const path = join(ctx.cwd, HANDOFF_FILE);
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;

      const md = renderHandoff({
        status: p.status,
        summary: p.summary,
        artifacts: p.artifacts,
        decisions: p.decisions,
        nextTask: p.next_task,
        blocked: p.blocked,
        sessionFile,
      });
      writeFileSync(path, md, "utf8");

      // finish = 终止。清掉任何待执行的重置，否则 terminate 之后的 turn_end
      // 还会把这一会话拖去 compaction，纯属浪费。
      disarm();
      ourCompactInFlight = false;

      const hasNext = !!(p.next_task && p.next_task.trim());
      ctx.ui.notify(
        `HANDOFF.md written (${p.status}). ${hasNext ? "Run /next to chain on." : "Chain complete."}`,
        p.status === "blocked" ? "warning" : "info"
      );

      return {
        content: [
          {
            type: "text",
            text:
              `Handoff written to ${path}. This session is terminating now. ` +
              (hasNext
                ? "Human must review the handoff, then run /next."
                : "No next task; chain ends."),
          },
        ],
        details: { path, status: p.status, hasNext },
        // ★ 核心：terminate → 本工具批次结束后不再追加 LLM 输出。
        //   这就是 "杀进程不等胜利巡游" 的 pi 原生等价物。
        terminate: true,
      };
    },
  });

  // ── 1b. checkpoint 工具：落盘 = 上下文重置点（非终止）──────────
  pi.registerTool({
    name: "checkpoint",
    label: "Checkpoint Handoff",
    description:
      "Save an in-progress snapshot of the work to HANDOFF.md. This is a CONTEXT RESET POINT, not a log line: by default (`reset: \"compact\"`) your context is cleared as soon as this turn finishes and is replaced by the document you just wrote (zero-summarization-cost — the document *is* the new context), after which you are nudged to keep working from it. Use `reset: \"session\"` for a hard cut into a brand-new session, or `reset: \"none\"` to only write the file. Call after every meaningful milestone (a file finished, a decision made, a test passing), so that if this session dies at any moment, the on-disk handoff is at most one step stale.",
    promptSnippet:
      "checkpoint: save progress to HANDOFF.md and reset the context to that document (non-terminal)",
    promptGuidelines: [
      "For any task expected to take more than ~10 tool calls, call `checkpoint` after each milestone, before and after risky operations. Treat HANDOFF.md as your save file, not as an end-of-exam name field.",
      "`checkpoint` does NOT end your task: after the reset the same work continues, but only the checkpoint document survives. Write the checkpoint so a total amnesia is survivable — artifacts on disk + exact remaining steps in `next_task`.",
      "After a reset, do not trust remembered details: re-read the handoff document and the artifact files it lists.",
      "Use `reset: \"none\"` only when the snapshot is a quick note mid-thought and clearing context right now would cost more than it saves.",
    ],
    parameters: Type.Object({
      status: StringEnum(["in-progress", "done", "partial", "blocked"] as const),
      summary: Type.String({ description: "Progress so far, 2-5 sentences" }),
      artifacts: Type.Optional(Type.Array(Type.String())),
      decisions: Type.Optional(Type.Array(Type.String())),
      next_task: Type.Optional(
        Type.String({ description: "If the session died right now, what should the next agent do?" })
      ),
      blocked: Type.Optional(Type.String()),
      reset: Type.Optional(
        StringEnum(["none", "compact", "session"] as const, {
          description:
            "Context reset after the snapshot lands: 'compact' (default) clears this session's context and replaces it with the handoff document; 'session' hard-cuts to a brand-new session; 'none' only writes the file.",
        })
      ),
    }),
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      if (!enabled) {
        return { content: [{ type: "text", text: disabledMessage() }], details: { disabled: true } };
      }
      const path = join(ctx.cwd, HANDOFF_FILE);
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
      const usage = ctx.getContextUsage();
      const win = usage?.contextWindow ?? (ctx.model as { contextWindow?: number })?.contextWindow ?? 128_000;
      const contextPct = usage?.tokens != null ? pct(usage.tokens, win) : undefined;

      const md = renderHandoff({
        status: p.status,
        summary: p.summary,
        artifacts: p.artifacts,
        decisions: p.decisions,
        nextTask: p.next_task,
        blocked: p.blocked,
        sessionFile,
        contextPct,
      });
      writeFileSync(path, md, "utf8");

      let kind: ResetKind = pickReset(p.reset, DEFAULT_RESET);
      const headless = !interactive(ctx.mode);
      if (headless && kind !== "none") {
        // headless：进程本身就是会话边界，重置交给驱动脚本“每轮一个新进程”天然完成
        kind = "none";
      }
      if (kind === "none" || resetCount >= MAX_RESETS) {
        const why = headless
          ? `headless session — the process itself is the context boundary, so the next turn starts clean anyway`
          : `reset=none`;
        if (resetCount >= MAX_RESETS && !headless) {
          ctx.ui.notify(
            `Reset budget exhausted (${resetCount}/${MAX_RESETS}). Snapshot written, context left as-is — run /cut manually if you still want a hard reset.`,
            "warning"
          );
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Checkpoint saved to ${path}${contextPct ? ` (context ${contextPct})` : ""}. ` +
                `Context untouched (${why}). Keep working — you are NOT done until you call finish.`,
            },
          ],
          details: { path, status: p.status, reset: "none" as const, headless },
        };
      }

      armed = { kind, doc: md };
      const note =
        kind === "compact"
          ? `At the end of THIS turn your context will be wiped and replaced by this document (no summarization cost — the document is the new context), then you will be nudged to continue from it. Do not rely on remembered detail afterwards.`
          : `When this run settles, /cut will start a brand-new session seeded with this document; the work continues there with zero inherited context.`;
      ctx.ui.notify(
        kind === "compact"
          ? `Checkpoint saved — context reset armed (compact). Finishing this turn clears it.`
          : `Checkpoint saved — hard session cut armed (/cut).`,
        "info"
      );

      return {
        content: [
          {
            type: "text",
            text:
              `Checkpoint saved to ${path}${contextPct ? ` (context ${contextPct})` : ""}. ` +
              note +
              ` Keep working — you are NOT done until you call finish.`,
          },
        ],
        details: { path, status: p.status, reset: kind },
      };
    },
  });

  // ── 1c. 重置引擎：把 compaction 的 summary 换成刚写的 handoff 文档 ──
  pi.on("session_before_compact", async (event) => {
    if (!enabled) return;
    // 只接管我们自己发起的那一次 manual compaction，
    // 人类手打 /compact（含自定义指令）走 pi 默认逻辑。
    if (!ourCompactInFlight || !resetSummary) return;
    if (event.reason !== "manual") return;

    return {
      compaction: {
        summary: resetSummary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { handoffChainReset: true, source: HANDOFF_FILE },
      },
    };
  });

  // ── 1d. 水位线看门狗 + 重置派发（都在 turn_end：工具结果已落盘）──
  pi.on("turn_end", async (_event, ctx) => {
    if (!enabled) return;
    // 1) 有存档待重置 → 优先执行重置，这一轮就不再唠叨水位线
    if (armed && !ourCompactInFlight && resetCount < MAX_RESETS) {
      const kind = armed.kind;
      if (kind === "session") {
        awaitingCut = true; // 交给 agent_settled 做会话替换
        return;
      }
      // compact：就地清空。ctx.compact() 内部会先 abort 当前 run，
      // 所以只能在 turn_end（结果已持久化）触发，绝不能在工具 execute 里调。
      // 正文先存到 resetSummary：实测 session_before_compact 比 agent_settled 还晚跑，
      // 任何“在 settle 里清 armed”的写法都会把喂给 compaction 的文档清掉。
      resetSummary = handoffAsContext(armed.doc);
      ourCompactInFlight = true;
      awaitingResume = true;
      resetCount += 1;
      ctx.ui.notify(
        `Checkpoint reset: clearing context and replacing it with ${HANDOFF_FILE} (reset ${resetCount}/${MAX_RESETS})`,
        "info"
      );
      ctx.compact({
        customInstructions: "Context reset to the checkpoint handoff document.",
        onError: (error: Error) => {
          if (!ourCompactInFlight) return; // session_compact_failed 可能已经先处理过了
          ourCompactInFlight = false;
          awaitingResume = false;
          armed = null;
          resetSummary = null;
          ctx.ui.notify(
            `Checkpoint reset failed: ${error.message}. Context left as-is; keep working or use /cut.`,
            "warning"
          );
        },
      });
      return;
    }

    // 2) 水位线：过线即强制落盘指令
    if (watchdogFired) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null) return;
    const win = usage.contextWindow || (ctx.model as { contextWindow?: number })?.contextWindow || 128_000;
    const ratio = usage.tokens / win;
    if (ratio < WATERMARK) return;

    watchdogFired = true;
    ctx.ui.notify(
      `Context at ${(ratio * 100).toFixed(0)}% — forcing landing (watermark ${(WATERMARK * 100).toFixed(0)}%)`,
      "warning"
    );
    // steer：在当前回合工具跑完、下一次 LLM 调用前插入，打断"再干一件小事"的惯性
    pi.sendMessage(
      {
        customType: "handoff-chain",
        content:
          `⚠️ WATERMARK: context usage is ${(ratio * 100).toFixed(0)}% of the window. ` +
          `STOP starting new work. Right now: (1) commit any finished artifacts to disk, ` +
          `(2) call \`finish\` with status 'partial' and a fully self-contained next_task ` +
          `describing exactly what remains (assume the next agent has zero memory of this session), ` +
          `or 'done' if you are actually finished. If the task is long and only partly done, ` +
          `call \`checkpoint\` instead (reset 'compact') so this context is replaced by the document. ` +
          `Do not ask questions; land the plane.`,
        display: true,
      },
      { deliverAs: "steer" }
    );
  });

  // ── 1e. 重置收尾：把 agent 重新推起来 / 触发硬切换 ─────────────
  //
  // 为什么用 session_compact 而不是 agent_settled 推 resume：
  //   实测 compact() 的 abort 会先让 agent settle，compaction 本身还排在后面；
  //   且 session_compact 时 _compactionAbortController 仍未清，此时发消息会被 pi 拒。
  //   session_compact/_failed 是“重置确实已经跑过”的唯一可靠信号，
  //   再用 whenIdle 轮询到状态真正干净才发。settle 里不推 resume，避免抢跑。
  pi.on("session_compact", async (event, ctx) => {
    if (!ourCompactInFlight || event.reason !== "manual") return;
    ourCompactInFlight = false;
    const usedDoc = event.fromExtension;
    armed = null;
    resetSummary = null;
    if (!awaitingResume) return;
    awaitingResume = false;

    const before = event.compactionEntry.tokensBefore;
    ctx.ui.notify(
      usedDoc
        ? `Context reset to ${HANDOFF_FILE}. Dropped ~${before.toLocaleString()} tokens of stale context.`
        : `Context reset ran, but pi's default summary won (another extension overrode it). Resuming anyway.`,
      usedDoc ? "info" : "warning"
    );
    whenIdle(ctx, () => pi.sendUserMessage(RESUME_MESSAGE), "resume after reset");
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    if (!ourCompactInFlight) return;
    ourCompactInFlight = false;
    armed = null;
    resetSummary = null;
    awaitingResume = false;
    ctx.ui.notify(
      `Context reset failed (${event.errorMessage ?? "aborted"}). Context left as-is — keep working, or run /cut for a hard reset.`,
      "warning"
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
        "warning"
      );
      return;
    }
    if (resetCount >= MAX_RESETS) {
      ctx.ui.notify(`Reset budget exhausted (${MAX_RESETS}). Skipping /cut.`, "warning");
      return;
    }
    resetCount += 1;
    cutArmedByTool = true; // /cut 里跳过人工确认
    // 工具上下文里没有 newSession()，走命令通道拿带会话替换权限的 ctx。
    // 必须 whenIdle：否则“compaction in progress”之类的拒接会直接吐掉 /cut。
    whenIdle(ctx, () => {
      pi.sendUserMessage("/cut", { expandPromptTemplates: true });
    }, "auto /cut");
  });

  // ── 2. /next 命令：读交接文档 → 全新会话接力下一个任务 ────────
  pi.registerCommand("next", {
    description: "End this session and chain a FRESH session seeded with HANDOFF.md",
    handler: async (args, ctx) => {
      const path = join(ctx.cwd, HANDOFF_FILE);
      if (!existsSync(path)) {
        ctx.ui.notify(`No ${HANDOFF_FILE} found — nothing to chain from.`, "error");
        return;
      }

      const doc = readFileSync(path, "utf8");
      const nextSection = readNextTask(doc);
      if (isChainEnd(nextSection) && !args?.trim()) {
        ctx.ui.notify("Handoff has no next task. Chain complete. 🎉", "info");
        return;
      }

      // 人类闸门：确认后才接力（可去掉 confirm 做全自动）
      await chainToFreshSession(ctx, {
        doc,
        kickoff: makeKickoff(doc, args),
        confirmTitle: "Chain to a fresh session?",
        confirmBody: `Next task: ${cut(nextSection || doc, 140)}`,
        skipConfirm: false,
      });
    },
  });

  // ── 2b. /cut 命令：同一个任务，换个干净的脑子接着干 ────────────
  // 与 /next 的区别只在语义：/next = 链到下一个任务；
  // /cut = 上下文就地归零，同一个任务从 checkpoint 继续。
  // checkpoint(reset:"session") 会在 settle 后自动派发 /cut（跳过确认）。
  pi.registerCommand("cut", {
    description: "Hard context reset: fresh session seeded with HANDOFF.md, same task continues",
    handler: async (args, ctx) => {
      const path = join(ctx.cwd, HANDOFF_FILE);
      if (!existsSync(path)) {
        ctx.ui.notify(`No ${HANDOFF_FILE} found — call \`checkpoint\` first.`, "error");
        cutArmedByTool = false;
        return;
      }
      const doc = readFileSync(path, "utf8");
      const skipConfirm = cutArmedByTool;
      cutArmedByTool = false;

      await chainToFreshSession(ctx, {
        doc,
        kickoff: makeKickoff(
          doc,
          args,
          "the previous context was hard-reset, so nothing but this document survived"
        ),
        confirmTitle: "Cut the context and continue in a fresh session?",
        confirmBody: `This wipes the current context completely. Resuming: ${cut(readNextTask(doc) || doc, 140)}`,
        skipConfirm,
      });
    },
  });

  // ── 3. /handoff 命令：人工查看当前交接状态 ────────────────────
  pi.registerCommand("handoff", {
    description:
      "Show HANDOFF.md, or drive the switch: /handoff [status | on | off] [global|project]",
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "").toLowerCase();
      const scopeArg = (tokens[1] ?? "").toLowerCase();

      // /handoff —— 不带参数：看交接文档（旧行为）
      if (!sub) {
        const p = join(ctx.cwd, HANDOFF_FILE);
        if (!existsSync(p)) {
          ctx.ui.notify("No HANDOFF.md yet.", "info");
          return;
        }
        const doc = readFileSync(p, "utf8");
        ctx.ui.notify(doc.split("\n").slice(0, 14).join("\n"), "info");
        return;
      }

      // /handoff status —— 开关生效值 + 每一级来源，调优先级时靠这个
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
            `on/off 对当前会话立即生效，对其它会话在下一个 run 生效。`,
          ].join("\n"),
          enabled ? "info" : "warning"
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
          `Unknown \`/handoff ${sub}\`. Use: /handoff (show doc) | status | on | off [global|project]`,
          "error"
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
          `Write "${SETTINGS_KEY}": ${value} to ${p} — other settings in that file are preserved.`
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
        value ? "info" : "warning"
      );
    },
  });
}

function cut(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}
