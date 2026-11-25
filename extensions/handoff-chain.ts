/**
 * handoff-chain.ts — Kill & Handoff 接力协议 for pi
 *
 * 工作流：
 *   1. Agent 干活，任务完成时调用 `finish`（由 promptGuidelines 约束）
 *   2. finish 把交接文档写入磁盘（每个任务线程一份 lane 文档），在会话里渲染
 *      一张简报卡片（进展 + 问题 + 下一步），然后返回 terminate:true
 *      → pi 在工具批次结束后立即停止，不再追加 LLM 输出（杀胜利巡游）
 *   3. 人审查交接文档（人类闸门），满意后输入 /next（多条 lane 时选一条，可指定模型）
 *   4. /next 读取该 lane 的文档 → ctx.newSession() 开全新会话
 *      → 以 handoff 文档为初始上下文 → 自动发送 kickoff 指令继续下一个任务
 *
 * ── v1.3 修的四件事 ────────────────────────────────────────────────
 *
 * 1) 多个会话互相覆盖 HANDOFF.md
 *    现在一个会话 = 一条 lane（一个任务线程），文档在 `.pi/handoff/<lane>.md`。
 *    根目录 HANDOFF.md 退化成**自动生成的索引 + 最近活跃 lane 正文**：
 *    老脚本（agent-chain.sh）和 "## Next task" 解析照旧可用。
 *    lane 名解析顺序：显式 lane 参数 > HANDOFF_LANE 环境变量 > 本会话已绑定 >
 *    lane 文档里的 `session:` 行（跨进程 resume）> /next 注入的 `handoff-lane:`
 *    标记 > 会话名 > 首条用户消息。绑定关系也用 pi.appendEntry 存进会话，
 *    所以 fork / resume 之后还能认出自己那条 lane。
 *
 * 2) 写完 handoff 会话里没有简述
 *    finish 的 terminate:true 杀掉了"胜利巡游"，副作用是人只看到一句 toast。
 *    现在 finish/checkpoint 自己用 pi.appendEntry + registerEntryRenderer 在
 *    transcript 里渲染简报卡（进展 / 问题 / 下一步 / 产物）：
 *      - 自定义 entry 不进模型上下文 → 不花一个 token
 *      - entry 持久化到会话文件 → 重开会话还在
 *      - headless（pi -p）里 entry 不渲染，同一段文字照样进工具结果，驱动脚本能读
 *
 * 3) 随手一个很短的 checkpoint 就把会话打断
 *    v1.2 默认 reset=compact：任何 checkpoint 都清一次上下文（实测 11% 上下文时
 *    也照清），文档薄得像便签，reset 完 agent 只能重新摸索，看起来就是"会话被打断"。
 *    v1.3 默认 reset=auto：只有 ①上下文已用到 HANDOFF_RESET_MIN（默认 35%）
 *    ②这份文档厚到能当全部上下文用（summary+next_task ≥ 700 字、next_task ≥ 60 字、
 *    列了 artifacts）时才真的重置，否则退化成"只落盘"并说明原因。
 *
 * 4) /next 总是回到默认模型
 *    ctx.newSession() 走 createRuntime，模型取 settings 默认值，当前会话的
 *    /model 切换不会带过去。现在 chainToFreshSession 默认**沿用当前会话的模型**，
 *    并支持显式指定：`/next --model <provider/id|模糊名|list|default|inherit>`。
 *    （pi 实测：pi.setModel 在 withSession 里作用于新会话 —— 会话替换时
 *     apply() → rebindSession() → bindCore() 已经把 runtime 动作换绑到新会话；
 *     setup 阶段 sm.appendModelChange() 只写文件、不改运行时状态，不能用来选模型。）
 *
 * ── 上下文重置引擎（v1.2 的核心，v1.3 加了 auto 闸门）──────────────
 *
 *   checkpoint 只落盘是**不够**的 —— 同一会话越写越长，文档永远不是上下文的
 *   来源，后面再"重新读一遍文档"时，新的文档要和一整屏陈旧上下文竞争话语权，
 *   接力形同虚设。所以真正里程碑的 checkpoint 必须是**上下文重置点**。
 *
 *   四档重置（checkpoint 的 reset 参数，默认 auto）：
 *     auto     只在"划得来"时重置（见上 3）
 *     none     只落盘，不动上下文
 *     compact  就地清空：本轮工具跑完（turn_end，结果已持久化）后触发 compaction，
 *              并用 session_before_compact 把 summary 直接替换成刚写好的 lane 文档。
 *              → 零 LLM 成本的重置：文档本身就是新上下文；
 *                随后 session_compact 后自动推一条"从文档继续"的消息，工作不断线。
 *     session  硬切换：本轮 settle 后以 /cut 拉起全新会话（同 /next，但沿用同一任务）
 *
 *   时序约束（为什么不能在 checkpoint 的 execute 里直接清上下文）：
 *     - 工具的 ctx 是 ExtensionContext，只有 compact()，没有 newSession()；
 *       newSession() 只在命令上下文（ExtensionCommandContext）里可用。
 *     - ctx.compact() 内部会先 abort 当前 run。在 execute 里调用会把正在执行的
 *       工具批次一起打掉，结果可能落不进会话。所以一律延后到 turn_end。
 *     - 会话替换同理延后到 agent_settled（此时 _isAgentRunActive 已为 false），
 *       再通过 sendUserMessage("/cut", {expandPromptTemplates:true}) 走命令通道。
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

/** 根目录的索引文件（保留旧路径，老脚本照旧能解析 "## Next task"） */
const INDEX_FILE = "HANDOFF.md";
const INDEX_MARK = "<!-- handoff-chain:index -->";
/** 每条 lane 一份文档：<cwd>/.pi/handoff/<lane>.md */
const LANE_DIR = ".pi/handoff";
const LEGACY_LANE = "legacy";
/** 会话内简报卡片（自定义 entry，不进模型上下文） */
const BRIEF_TYPE = "handoff-brief";
/** lane 绑定关系（会话内持久化，不进模型上下文） */
const LANE_ENTRY_TYPE = "handoff-lane";
/** 只有这些 pi 内置档位，避免把 thinking 后缀猜错 */
const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// ── 总开关：settings.json 里的 enable_handoff ──────────────────────
//
// pi 没有给扩展暴露读 settings 的 API（ExtensionContext 上只有 getSettings()，
// 命令上下文里才有），但 settings.json 对未知顶层键是透传的，所以扩展自己读自己写。
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

// ── 阈值 ────────────────────────────────────────────────────────────
// 水位线：上下文用到窗口的 60% 就强制落盘（留出写完交接+余量）
const WATERMARK = Number(process.env.HANDOFF_WATERMARK ?? 0.6);

// checkpoint 默认重置档位：auto | none | compact | session
type ResetKind = "none" | "compact" | "session";
type ResetChoice = ResetKind | "auto";
const DEFAULT_RESET: ResetChoice = pickReset(process.env.HANDOFF_CHECKPOINT_RESET, "auto");

// 熔断：单次会话里自动重置的次数上限（防止 agent 每轮都 checkpoint 造成 复位→重启 抖动）
const MAX_RESETS = Number(process.env.HANDOFF_MAX_RESETS ?? 12);

// 重置下限：上下文用到窗口的这个比例以下，重置纯属自残（清掉的多、留下的少）
const RESET_MIN = Number(process.env.HANDOFF_RESET_MIN ?? 0.35);
// 文档厚度下限：重置后这份文档就是全部上下文，太薄等于把 agent 推回零状态重新摸索
const RESET_MIN_DOC_CHARS = Number(process.env.HANDOFF_RESET_MIN_DOC_CHARS ?? 700);
const RESET_MIN_NEXT_CHARS = Number(process.env.HANDOFF_RESET_MIN_NEXT_CHARS ?? 60);

// /next /cut 默认沿用当前会话的模型（"inherit"）；"default" 恢复 v1.2 的“回到 settings 默认模型”
const CHAIN_MODEL = (process.env.HANDOFF_CHAIN_MODEL ?? "inherit").trim().toLowerCase();

function pickReset(v: string | undefined, fallback: ResetChoice): ResetChoice {
  return v === "none" || v === "compact" || v === "session" || v === "auto" ? v : fallback;
}

// ── lanes：一个会话一条工作线程 ────────────────────────────────────
//
// lane 文档尾部是机器可读区（最后一个 `---` 之后的 key: value），索引就靠它生成。
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

/** 本会话绑定的 lane；key = 会话文件路径（或 cwd 兜底） */
const laneBindings = new Map<string, string>();
/** /next 注入的 `handoff-lane:` 标记（跨进程时靠 lane 文档的 session: 行兜底） */
const injectedLanes = new Map<string, string>();
let migrationsDone = false;
/** 最近一次已知 cwd，只给 /next /handoff 的参数补全用 */
let lastCwd = process.cwd();
/** setup 里算好、传给新会话的 lane（withSession 时写入 injectedLanes） */
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

/** ASCII 化 slug（lane 名要能当文件名，也要好打在 /next 后面） */
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

/** 解析 lane 文档尾部的 key: value 区（找不到就当空对象） */
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

/** 全部 lane，按最近活跃排序 */
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
 * 生成根目录 HANDOFF.md：表格式索引 + 最近活跃 lane 的正文。
 * 保留 "## Status" / "## Next task" 段落形状，老脚本（agent-chain.sh）照旧能解析。
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

/** 是否是本扩展生成的索引（而不是某个手写的 / 旧版单文件 HANDOFF.md） */
function looksLikeIndex(doc: string): boolean {
  return doc.includes(INDEX_MARK) || /^#\s*HANDOFF index\b/m.test(doc);
}

function isLaneDocText(doc: string): boolean {
  return /^#\s*HANDOFF\b/m.test(doc) && !looksLikeIndex(doc);
}

function trailerOf(doc: string, key: string): string {
  return parseTrailer(doc)[key] ?? "";
}

/** 把旧的单文件 HANDOFF.md 收进 .pi/handoff/legacy.md（每个进程只做一次） */
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
  if (!isLaneDocText(doc)) return; // 手写的、空的、或者已经不是交接文档：别乱动
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
    /* 迁移失败不拦主流程 */
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

/** 从会话内容里推 lane 名：注入标记 > 会话名 > 首条用户消息 */
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
      // 链式注入 / checkpoint 重置注入不算“任务描述”
      if (/^<(handoff-from-previous-session|checkpoint-handoff)\b/i.test(text.trim())) continue;
      readable = slugify(text.slice(0, 160));
      break;
    }
  } catch {
    /* getBranch 拿不到就走兜底 */
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
  // 名字被另一条还活跃的线程占了 → 带会话指纹，避免互相覆盖
  return recent ? `${readable}-${hash4(own)}` : readable;
}

/** 确定本会话的 lane（并绑定） */
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
    // 跨进程 resume：lane 文档里记着是谁写的
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
    // 只在绑定发生变化时留一条 entry，别把会话文件刷满
    try {
      pi.appendEntry(LANE_ENTRY_TYPE, { lane, source, at: Date.now() });
    } catch {
      /* entry 不可写就只留内存绑定 */
    }
  }
  return { lane, file: lanePath(cwd, lane), source };
}

/** 写 lane 文档 + 重建根索引 */
function writeLaneDoc(cwd: string, lane: string, doc: string): string {
  mkdirSync(laneDir(cwd), { recursive: true });
  const file = lanePath(cwd, lane);
  writeFileSync(file, doc, "utf8");
  try {
    writeFileSync(join(cwd, INDEX_FILE), renderIndex(cwd, listLanes(cwd)), "utf8");
  } catch {
    /* 索引写失败不影响 lane 文档本身 */
  }
  return file;
}

/** 保留 lane 文档最初的创建时间（标题行的时间戳） */
function createdOf(file: string, fallback: string): string {
  try {
    const first = readFileSync(file, "utf8").split("\n")[0] ?? "";
    return /^#\s*HANDOFF\s*[—-]\s*(.+)$/.exec(first)?.[1]?.trim() || fallback;
  } catch {
    return fallback;
  }
}

// ── 会话内简报 ─────────────────────────────────────────────────────

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
    /* headless 或 entry 不可写：文字仍然在工具结果里 */
  }
  ctx.ui.notify(b.head || briefText(b), b.status === "blocked" ? "warning" : "info");
}

// ── 看门狗 / 重置引擎状态（进程内，session_start 时全部清零）───────
//
// 状态机（时序全是实测出来的，不是猜的）：
//   checkpoint.execute   → armed = { kind, doc, file, lane }
//   turn_end             → compact: resetSummary 定弹 + ourCompactInFlight=true + ctx.compact()
//   session_before_compact→ 用 resetSummary 顶替默认 summary（零 LLM 成本）
//   session_compact/_failed → 清旗，然后等 idle 推 RESUME
//   agent_settled         → compact 的 abort 会先 settle（实测），所以这里只做兜底；
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
let armed: { kind: "compact" | "session"; doc: string; file: string; lane: string } | null = null;
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
let activeLaneFile: string | null = null;
let activeLaneName = "";

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
 * 把 handoff 文档变成"重置后的上下文正文"。
 * 作为 compaction 的 summary 注入 → 旧对话被丢弃，文档成为唯一可信记录。
 * 因为 summary 是我们自己写的，这一步不花任何 LLM token。
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

// ── 模型选择（/next /cut）──────────────────────────────────────────
//
// ctx.newSession() 内部 createRuntime 取 settings 默认模型，当前会话的 /model
// 切换不会跟过去（v1.2 的痛点）。这里显式把模型搬进新会话：
//   - setup 阶段 sm.appendModelChange() 只写会话文件，不改运行时 → 只用于留痕
//   - withSession 阶段 pi.setModel(realModelObject) 才真的作用在新会话上
//     （会话替换时 apply() → rebindSession() 已经把 runtime 动作换绑到新会话）
//   - Model 对象必须来自 ctx.modelRegistry.find(provider, id)（官方 docs 的用法），
//     不能自己拼 {provider, id}：pi.setModel 还要 api / baseUrl / capabilities 等字段

/** 真实 Model 对象类型：从 pi 自己的签名里取，避免手搓 */
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

/** 可选模型清单：当前模型 + scopedModels + registry 里已配好鉴权的 */
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

/** 用官方 registry 拿到真正的 Model 对象（找不到返回 undefined） */
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

/** 解析 spec → 目标模型；"default"/"settings" 返回空（用 settings 默认），"inherit" 用当前模型 */
function findModel(
  ctx: ExtensionContext | ExtensionCommandContext,
  spec: string,
): ModelTarget {
  const s = spec.trim();
  if (!s || s === "default" || s === "settings") return {};
  if (s === "inherit" || s === "current") {
    if (!ctx.model) return {};
    const cur = ctx.model as ModelHandle & ModelRef;
    // ctx.model 本身就是 registry 里的真 Model，直接当 handle 用；
    // 再查一次 registry 只是为了拿到更完整的对象（有则更好，无则用当前）。
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
  // registry 里有就必须拿真 Model；拿不到说明这个 provider/id 不存在或没配鉴权
  const handle = lookupModel(ctx, ref.provider, ref.id);
  if (!handle && ctx.modelRegistry) {
    return {
      error: `model ${ref.provider}/${ref.id} is not available (unknown id or no API key configured)`,
      candidates: refs.slice(0, 8).map((m) => `${m.provider}/${m.id}`),
    };
  }
  return { ref, handle, thinking };
}

/** 共享的"开新会话接力"逻辑：/next 与 /cut 都走这里 */
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
  // 模型先解析（解析失败就别切会话）
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

  // 若在 agent 还在跑时下达指令，先等它 settle，避免会话替换冲突
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
      // 留痕用：真正的运行时切换在 withSession 里用 pi.setModel 做
      if (ref) {
        try {
          sm.appendModelChange(ref.provider, ref.id);
        } catch {
          /* 新会话的 sm 可能不暴露 appendModelChange，忽略 */
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

      // 模型：会话替换已经把这批 runtime 动作换绑到新会话，pi.setModel 落在新会话上。
      // Model 对象必须是 ctx.modelRegistry.find() 返回的那个（带 api/baseUrl/capabilities）。
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
          /* 模型不支持就算了 */
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
 * 解析 `/next [lane] [-m <model>] ...` 之类的参数里的模型选项。
 * 支持：`--model x` / `--model=x` / `-m x` / `@x` / `model=x` / 裸 `--model`（打开选择器）
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

/** 从工具参数拼一段给人看的简报（进展 + 问题 + 下一步） */
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
        `进展: ${oneLine(p.summary, 320)}`,
        p.status === "blocked" || p.blocked ? `问题: ${oneLine(p.blocked || "see the document", 240)}` : `问题: none`,
        p.nextTask && !isChainEnd(p.nextTask)
          ? `下一步: ${oneLine(p.nextTask, 240)}`
          : `下一步: (chain ends here)`,
      ].filter(Boolean);
  if (p.artifacts?.length) lines.push(`产物: ${p.artifacts.slice(0, 6).join(", ")}`);
  if (p.note) lines.push(p.note);
  const head = `${p.kind === "finish" ? "落盘" : "存档"} · ${p.lane} · ${p.status}${
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

/** 这份 checkpoint 厚到能当全部上下文用吗？薄就别拿它去覆盖上下文 */
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
  // 简报卡片：finish / checkpoint 落盘后人在 transcript 里看到的那张卡
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

  // 每一轮 run 重新开始计警告（重置后的 resume 也是一轮新 run），并刷新开关
  pi.on("agent_start", async (_event, ctx) => {
    watchdogFired = false;
    lastCwd = ctx.cwd;
    syncEnabled(pi, ctx);
  });

  // 每次会话开始（含 /new、/resume、/cut、/next 之后的新会话）先读开关，
  // 再清空进程内残留状态——否则上一个会话遗留的 armed reset 会把新会话立刻打去 compaction。
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
    // 恢复本会话的 lane 绑定：本扩展写过的 handoff-lane entry（fork / resume 之后仍有效）
    try {
      for (const e of ctx.sessionManager.getEntries()) {
        if (e.type === "custom" && (e as { customType?: string }).customType === LANE_ENTRY_TYPE) {
          const data = (e as { data?: { lane?: string } }).data;
          if (data?.lane) laneBindings.set(key, data.lane);
        }
      }
    } catch {
      /* entry 读不到就算了，写的时候再推 */
    }
    // /next 注入的 handoff-lane 标记（跨进程 resume 的兜底）
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

  // ── 1. finish 工具：交接落盘 + 会话内简报 + 立刻终止本会话 ──────
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

      // finish = 终止。清掉任何待执行的重置，否则 terminate 之后的 turn_end
      // 还会把这一会话拖去 compaction，纯属浪费。
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

      // ── 这次到底要不要真的重置上下文（v1.3：默认 auto，不再一律清）──
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

  // ── 1c. 重置引擎：把 compaction 的 summary 换成刚写的 lane 文档 ──
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
        details: { handoffChainReset: true, source: activeLaneFile ?? INDEX_FILE },
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
          if (!ourCompactInFlight) return; // session_compact_failed 可能已经先处理过了
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
      "warning",
    );
    // steer：在当前回合工具跑完、下一次 LLM 调用前插入，打断“再干一件小事”的惯性
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
    cutArmedByTool = true; // /cut 里跳过人工确认
    // 工具上下文里没有 newSession()，走命令通道拿带会话替换权限的 ctx。
    // 必须 whenIdle：否则“compaction in progress”之类的拒接会直接吐掉 /cut。
    whenIdle(ctx, () => {
      pi.sendUserMessage("/cut", { expandPromptTemplates: true });
    }, "auto /cut");
  });

  // ── 2. /next 命令：读某条 lane 的交接文档 → 全新会话接力 ────────
  //
  // 用法： /next [lane] [-m <provider/id>|@model|model=x] [--default-model] [kickoff...]`
  //   - lane：省略时选最近有 next task 的 lane；多条且是交互式会话时弹选择器
  //   - 模型：默认沿用当前会话的模型（HANDOFF_CHAIN_MODEL=default 可改回 settings 默认），
  //     `-m list` 打开模型选择器
  //   - 其余文字作为 kickoff 覆盖默认指令
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

      // 第一个 token 是已知 lane 名就当 lane 选择，剩下的都是 kickoff
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

      // 人类闸门：确认后才接力（可去掉 confirm 做全自动）
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

  // ── 2b. /cut 命令：同一个任务，换个干净的脑子接着干 ────────────
  // 与 /next 的区别只在语义：/next = 链到下一个任务；
  // /cut = 上下文就地归零，同一个任务从 checkpoint 继续。
  // checkpoint(reset:"session") 会在 settle 后自动派发 /cut。
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

  // ── 3. /handoff 命令：人工查看交接状态 + 开关控制面 ────────────
  //
  // /handoff                 列出所有 lane（*  = 本会话的 lane）
  // /handoff <lane>          看某条 lane 的正文
  // /handoff all             每条 lane 的摘要 + 路径
  // /handoff status          开关生效值 + 各级来源 + lane 列表
  // /handoff on|off [scope]  写 enable_handoff
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

      // /handoff —— 不带参数：列出所有 lane
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

      // /handoff <lane> —— 看某一条 lane 的正文
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
            `this session's lane: ${activeLaneName || laneBindings.get(sessionKey(ctx)) || "(not bound yet)"}`,
            `lanes: ${
              listLanes(ctx.cwd)
                .map((l) => `${l.lane}(${l.status})`)
                .join(", ") || "(none)"
            }`,
            `reset floor ${(RESET_MIN * 100).toFixed(0)}% · min doc ${RESET_MIN_DOC_CHARS} chars · default reset ${DEFAULT_RESET}`,
            `on/off 对当前会话立即生效，对其它会话在下一个 run 生效。`,
          ].join("\n"),
          enabled ? "info" : "warning",
        );
        return;
      }

      // /handoff all —— 每条 lane 的摘要 + 路径
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
