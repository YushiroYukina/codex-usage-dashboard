#!/bin/bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "$0")" && pwd)"
task_node="${USAGE_LEDGER_NODE:-}"
if [[ -z "$task_node" ]]; then task_node="$(command -v node || true)"; fi
if [[ -z "$task_node" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /Applications/Codex.app/Contents/Resources/node; do
    if [[ -x "$candidate" ]]; then task_node="$candidate"; break; fi
  done
fi
if [[ -z "$task_node" ]]; then
  echo '请先安装 Node.js 24 或更高版本，或设置 USAGE_LEDGER_NODE 为 node 的完整路径。'
  exit 1
fi
exec "$task_node" "$task_root/runtime/mac-install.mjs" "$@"
