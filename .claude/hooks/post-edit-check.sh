#!/usr/bin/env bash
set -euo pipefail
export BEAGLE_PATH="${BEAGLE_PATH:-/home/tom/code/beagle}"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="simple"
PROJECT_DIR="$(cd "$HOOK_DIR/../.." && pwd)"
POOL_CFG="$PROJECT_DIR/.beagle/pool.json"
if [[ -f "$POOL_CFG" ]]; then
    _mode=$(python3 -c "import json,sys; print(json.load(open('$POOL_CFG')).get('mode','simple'))" 2>/dev/null || true)
    [[ -n "$_mode" ]] && MODE="$_mode"
fi
INPUT=$(cat)
if [[ "$MODE" == "pool" && -f "$HOOK_DIR/post_edit_check_pool.py" ]]; then
    exec python3 "$HOOK_DIR/post_edit_check_pool.py" "$INPUT"
else
    exec python3 "$HOOK_DIR/post_edit_check_simple.py" "$INPUT"
fi
