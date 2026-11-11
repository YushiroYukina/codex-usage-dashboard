#!/bin/bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "$0")" && pwd)"
task_node="${USAGE_LEDGER_NODE:-$(command -v node || true)}"
if [[ -z "$task_node" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then task_node="$candidate"; break; fi
  done
fi
if [[ -z "$task_node" ]]; then echo '找不到 Node.js，请设置 USAGE_LEDGER_NODE。'; exit 1; fi
exec "$task_node" "$task_root/runtime/mac-check.mjs" "$@"
