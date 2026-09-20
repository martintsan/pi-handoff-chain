/**
 * handoff-chain.ts — Kill & Handoff 接力协议 for pi
 *
 * 工作流（对应 PLAYBOOK.md 第 3.3 节）：
 *   1. Agent 干活，任务完成时调用 `finish` 工具（由 promptGuidelines 约束）
 *   2. finish 把交接文档写入磁盘 HANDOFF.md，然后返回 terminate:true
 *      → pi 在工具批次结束后立即停止，不再追加 LLM 输出（杀胜利巡游）
 *   3. 人审查 HANDOFF.md（人类闸门），满意后输入 /next
 *   4. /next 读取 HANDOFF.md → ctx.newSession() 开全新会话
 *      → 以 handoff 文档为初始上下文 → 自动发送 kickoff 指令继续下一个任务
 *
 * 放在 .pi/extensions/handoff-chain.ts（项目级，需项目被信任后加载）
 * 或 ~/.pi/agent/extensions/handoff-chain.ts（全局）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HANDOFF_FILE = "HANDOFF.md";

// 水位线：上下文用到窗口的 60% 就强制落盘（留出写完交接+余量）
const WATERMARK = Number(process.env.HANDOFF_WATERMARK ?? 0.6);

// 看门狗状态：同一轮只提醒一次，agent_start 时重置
let watchdogFired = false;

function renderHandoff(p: {
  status: string;
  summary: string;
  artifacts?: string[];
  decisions?: string[];
  nextTask?: string;
  blocked?: string;
  sessionFile: string | null;
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
produced-by: pi / handoff-chain
validator: handoff written via finish tool with terminate:true
`;
}

export default function (pi: ExtensionAPI) {
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

  // ── 1b. checkpoint 工具：边做边存档（与 finish 同格式，但不终止）──
  pi.registerTool({
    name: "checkpoint",
    label: "Checkpoint Handoff",
    description:
      "Save an in-progress snapshot of the work to HANDOFF.md WITHOUT ending the session. Call it after every meaningful milestone (a file finished, a decision made, a test passing), so that if this session dies at any moment, the on-disk handoff is at most one step stale. Same fields as `finish`; set status='in-progress'.",
    promptSnippet: "checkpoint: incrementally save progress to HANDOFF.md (non-terminal)",
    promptGuidelines: [
      "For any task expected to take more than ~10 tool calls, call `checkpoint` after each milestone, before and after risky operations. Treat HANDOFF.md as your save file, not as an end-of-exam name field.",
      "`checkpoint` does NOT end your session. Use `finish` only when the task contract is actually complete, cut short by the watermark, or blocked.",
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
    }),
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      const path = join(ctx.cwd, HANDOFF_FILE);
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
      const usage = ctx.getContextUsage();
      const win = (ctx.model as { contextWindow?: number })?.contextWindow ?? 128_000;

      const md = renderHandoff({
        status: p.status,
        summary: p.summary,
        artifacts: p.artifacts,
        decisions: p.decisions,
        nextTask: p.next_task,
        blocked: p.blocked,
        sessionFile,
      }) + `\ncontext-at-write: ${usage ? Math.round((usage.tokens / win) * 100) : "?"}%\n`;
      writeFileSync(path, md, "utf8");

      return {
        content: [
          {
            type: "text",
            text: `Checkpoint saved to ${path} (${p.status}). Keep working — you are NOT done until you call finish.`,
          },
        ],
        details: { path, status: p.status },
      };
    },
  });

  // ── 1c. 水位线看门狗：过线即强制落盘指令 ──────────────────────
  pi.on("agent_start", async () => {
    watchdogFired = false;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (watchdogFired) return;
    const usage = ctx.getContextUsage();
    if (!usage) return;
    const win = (ctx.model as { contextWindow?: number })?.contextWindow ?? 128_000;
    const pct = usage.tokens / win;
    if (pct < WATERMARK) return;

    watchdogFired = true;
    ctx.ui.notify(
      `Context at ${(pct * 100).toFixed(0)}% — forcing landing (watermark ${(WATERMARK * 100).toFixed(0)}%)`,
      "warning"
    );
    // steer：在当前回合工具跑完、下一次 LLM 调用前插入，打断“再干一件小事”的惯性
    pi.sendMessage(
      {
        customType: "handoff-chain",
        content:
          `⚠️ WATERMARK: context usage is ${(pct * 100).toFixed(0)}% of the window. ` +
          `STOP starting new work. Right now: (1) commit any finished artifacts to disk, ` +
          `(2) call \`finish\` with status 'partial' and a fully self-contained next_task ` +
          `describing exactly what remains (assume the next agent has zero memory of this session), ` +
          `or 'done' if you are actually finished. Do not ask questions; land the plane.`,
        display: true,
      },
      { deliverAs: "steer" }
    );
  });

  // ── 2. /next 命令：读交接文档 → 全新会话接力 ──────────────────
  pi.registerCommand("next", {
    description:
      "End this session and chain a FRESH session seeded with HANDOFF.md",
    handler: async (args, ctx) => {
      const path = join(ctx.cwd, HANDOFF_FILE);
      if (!existsSync(path)) {
        ctx.ui.notify(`No ${HANDOFF_FILE} found — nothing to chain from.`, "error");
        return;
      }

      const doc = readFileSync(path, "utf8");
      const nextSection =
        doc
          .split(/^## Next task$/m)[1]
          ?.split(/^## /m)[0]
          ?.trim() ?? "";
      const noNext =
        !nextSection || nextSection.startsWith("(none") || hasNextChainEnd(nextSection);

      if (noNext && !args?.trim()) {
        ctx.ui.notify("Handoff has no next task. Chain complete. 🎉", "info");
        return;
      }

      // 人类闸门：确认后才接力（可去掉 confirm 做全自动）
      const ok = await ctx.ui.confirm(
        "Chain to a fresh session?",
        `Handoff: ${doc.split("\n").slice(5, 7).join(" ").slice(0, 120)}…`
      );
      if (!ok) return;

      const parentSession = ctx.sessionManager.getSessionFile?.() ?? undefined;
      const kickoff =
        (args?.trim() ||
          `You are continuing a task chain as a FRESH agent with no memory of previous sessions. ` +
            `Read HANDOFF.md at the project root (already provided below), verify the listed artifacts on disk, ` +
            `then execute the "Next task" section. When done, call the \`finish\` tool as your final action.`);

      const inject = [
        `<handoff-from-previous-session>`,
        doc,
        `</handoff-from-previous-session>`,
        ``,
        `Follow the chain protocol: verify artifacts, do the Next task, end with \`finish\`.`,
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
          await freshCtx.sendUserMessage(kickoff);
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("New session was cancelled by an extension.", "warning");
      }
    },
  });

  // ── 3. /handoff 命令：人工查看当前交接状态 ────────────────────
  pi.registerCommand("handoff", {
    description: "Show current HANDOFF.md",
    handler: async (_args, ctx) => {
      const path = join(ctx.cwd, HANDOFF_FILE);
      if (!existsSync(path)) {
        ctx.ui.notify("No HANDOFF.md yet.", "info");
        return;
      }
      const doc = readFileSync(path, "utf8");
      ctx.ui.notify(
        doc.split("\n").slice(0, 14).join("\n"),
        "info"
      );
    },
  });
}

function hasNextChainEnd(s: string): boolean {
  return /chain ends here/i.test(s);
}
