#!/usr/bin/env bash
# agent-chain.sh — Kevin 式「杀进程接力」无人值守驱动器（配合 handoff-chain.ts 扩展）
#
# 用法:
#   ./scripts/agent-chain.sh TASK.md          # 从 TASK.md 的初始终任务启动链
#
# 每轮:
#   1. 用 kickoff 启动一个全新的 `pi -p` 进程（干净上下文，零历史包袱）
#   2. Agent 干活，最终必须调用 finish 工具 → HANDOFF.md 落盘 + terminate:true
#      → pi 进程干净退出（胜利巡游被杀，不浪费一个 token）
#   3. 驱动器读 HANDOFF.md 的 "Next task"：有 → 起下一个进程接力；无 → 链结束
#   4. 没写 HANDOFF.md 就退出 = 流程违规，链停止并告警（绝不盲目续跑）

set -euo pipefail

TASK_FILE="${1:-TASK.md}"
HANDOFF="HANDOFF.md"
MAX_TURNS="${MAX_TURNS:-10}"     # 熔断上限，防失控烧钱
LOG_DIR="${LOG_DIR:-.chain-logs}"
mkdir -p "$LOG_DIR"

[[ -f "$TASK_FILE" ]] || { echo "缺少起始任务文件: $TASK_FILE"; exit 1; }

kickoff="$(cat "$TASK_FILE")"
turn=0

while [[ -n "$kickoff" ]]; do
  turn=$((turn + 1))
  if (( turn > MAX_TURNS )); then
    echo "⚠️  达到熔断上限 MAX_TURNS=$MAX_TURNS，链停止。" >&2
    exit 2
  fi

  echo "═══════ Turn $turn ═══════"
  rm -f "$HANDOFF"

  # 全新进程 = 全新会话 = 干净上下文。--name 便于事后 /resume 回溯
  pi --name "chain-T${turn}" -p "$kickoff" 2>&1 | tee "$LOG_DIR/turn-${turn}.log"

  if [[ ! -f "$HANDOFF" ]]; then
    echo "⚠️  Turn $turn 没有写 HANDOFF.md —— 尝试恢复咒语（带残留上下文 resume 重建交接）..." >&2
    pi --name "chain-T${turn}-recover" -c -p "你上一次运行被强制中断且未写交接文档。基于当前会话的已有内容（可能已被自动压缩）：立即重建 HANDOFF.md —— 写明 Status、已完成事项、产物路径、以及未完成的剩余工作作为 'Next task'（假设接手的全新 Agent 对本次会话毫无记忆）。重建完成后调用 finish 落盘。不要继续执行新任务，只负责重建交接。" 2>&1 | tee -a "$LOG_DIR/turn-${turn}-recover.log" || true
  fi

  if [[ ! -f "$HANDOFF" ]]; then
    echo "🛑 恢复失败：仍然没有 HANDOFF.md —— 链停止，需要人工介入。" >&2
    exit 3
  fi

  status="$(awk -F': ' '/^## Status$/{getline; print; exit}' "$HANDOFF")"
  if [[ "$status" == "blocked" ]]; then
    echo "🛑 Turn $turn 被标记 blocked —— 链停止，需要人工介入。" >&2
    exit 4
  fi

  # 提取 "## Next task" 段落
  kickoff="$(awk '/^## Next task/{flag=1;next}/^## /{flag=0}flag' "$HANDOFF" | sed '/(none/d' | sed '/^$/d')"

  if [[ -z "$kickoff" ]]; then
    echo "✅ 链在第 $turn 轮完成，无后续任务。"
  else
    echo "→ 接力下一任务: ${kickoff:0:80}..."
  fi
done
