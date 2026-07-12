#!/usr/bin/env bash
# detach.sh — survivable detached-op runner
# § 7 (survivable-unit standard) + § 8 item 3, docs/private/darkmode/dev-loop-assessment.md
#
# USAGE
#   detach.sh [--fact <thread-id>] <name> -- <cmd...>
#   detach.sh --status <name>
#
# * Runs <cmd> in a new session (setsid -f); survives caller death.
# * Logs stdout+stderr to /tmp/<name>.log.
# * Stall watchdog: if log mtime stale > 15 min AND zero compiler/render
#   processes detected → appends WATCHDOG-STALL line to log, exits rc 30.
# * Appends "<name> exited rc=N" to log on completion (grep-able bar evidence).
# * --fact <thread-id>: on completion posts a north progress fact; degrades
#   silently if north binary absent.
# * Duplicate guard: refuses start if <name> already has a live pidfile entry.
#
# Compiler/render process patterns (stall check):
#   cc1, cc1plus, rustc, clang, clang++, ld.lld, cargo, GeckoMain, firefox, Renderer

set -uo pipefail

SCRIPT=$(readlink -f "${BASH_SOURCE[0]}")
NORTH=/home/tom/code/north/bin/north
PIDDIR=/tmp/detach-pids
STALL_SECS=900   # 15 min log-stale threshold
POLL_SECS=60     # watchdog poll cadence
# Active build/render process comm patterns (ps -eo comm=)
COMPILER_PAT='^(cc1|cc1plus|rustc|clang|clang\+\+|ld\.lld|cargo|GeckoMain|firefox|Renderer)$'

# ── internal: run the op ──────────────────────────────────────────────────────

__run() {
  # __run <name> <fact|-> <log> -- <cmd...>
  local NAME=$1 FACT=$2 LOG=$3
  shift 3; [[ "${1:-}" == "--" ]] && shift
  # register live pid (overwrite pending placeholder if present)
  printf '%d\n' "$$" > "$PIDDIR/$NAME.pid"
  # run op
  "$@" >> "$LOG" 2>&1
  local RC=$?
  # bar-evidence terminal line
  printf '%s exited rc=%d\n' "$NAME" "$RC" >> "$LOG"
  rm -f "$PIDDIR/$NAME.pid"
  # optional north fact
  if [[ "$FACT" != "-" ]] && [[ -x "$NORTH" ]]; then
    "$NORTH" tell "$FACT" progress "$NAME exited rc=$RC" 2>/dev/null || true
  fi
  exit "$RC"
}

# ── internal: stall watchdog ──────────────────────────────────────────────────

__watchdog() {
  # __watchdog <name> <log>
  local NAME=$1 LOG=$2
  while true; do
    sleep "$POLL_SECS"
    # op finished?
    if grep -qF "$NAME exited rc=" "$LOG" 2>/dev/null; then
      exit 0
    fi
    # stall: log silent > 15 min AND no compiler/render processes alive
    local NOW AGE CC
    NOW=$(date +%s)
    AGE=$(( NOW - $(stat -c %Y "$LOG" 2>/dev/null || echo "$NOW") ))
    CC=$(ps -eo comm= 2>/dev/null | grep -Ec "$COMPILER_PAT" || echo 0)
    if (( AGE > STALL_SECS )) && (( CC == 0 )); then
      printf 'WATCHDOG-STALL: %s log stale %ds, 0 compiler/render processes — op may be hung.\n' \
        "$NAME" "$AGE" >> "$LOG"
      exit 30
    fi
  done
}

# ── sub-command dispatch ──────────────────────────────────────────────────────

case "${1:-}" in
  __run)
    shift; __run "$@"
    ;;
  __watchdog)
    shift; __watchdog "$@"
    ;;
  --status)
    NAME=${2:?'--status requires <name>'}
    LOG=/tmp/$NAME.log
    PID_F=$PIDDIR/$NAME.pid
    if [[ -f "$PID_F" ]]; then
      PID=$(cat "$PID_F")
      if [[ "$PID" == "pending" ]] || kill -0 "$PID" 2>/dev/null; then
        printf '%s: RUNNING (pid %s, log %s)\n' "$NAME" "$PID" "$LOG"
        [[ -f "$LOG" ]] && { echo "--- tail ---"; tail -5 "$LOG"; }
      else
        printf '%s: DEAD (stale pidfile pid=%s)\n' "$NAME" "$PID"
        [[ -f "$LOG" ]] && grep -F "$NAME exited rc=" "$LOG" | tail -1
      fi
    elif [[ -f "$LOG" ]] && grep -qF "$NAME exited rc=" "$LOG"; then
      printf '%s: COMPLETED\n' "$NAME"
      grep -F "$NAME exited rc=" "$LOG" | tail -1
    else
      printf '%s: UNKNOWN (no pidfile or log)\n' "$NAME"
    fi
    exit 0
    ;;
esac

# ── main entry: parse args ────────────────────────────────────────────────────

FACT="-"
if [[ "${1:-}" == "--fact" ]]; then
  FACT=${2:?'--fact requires <thread-id>'}
  shift 2
fi

NAME=${1:?'Usage: detach.sh [--fact <thread>] <name> -- <cmd...>'}
shift

if [[ "${1:-}" != "--" ]]; then
  printf 'detach: expected "--" after <name>, got "%s"\n' "${1:-}" >&2
  exit 1
fi
shift

if (( $# == 0 )); then
  echo 'detach: no command specified after "--"' >&2
  exit 1
fi

LOG=/tmp/$NAME.log
mkdir -p "$PIDDIR"
mkdir -p "$(dirname "$LOG")"   # /tmp always exists; guard for subdirectory names

# ── duplicate guard ───────────────────────────────────────────────────────────

PID_F=$PIDDIR/$NAME.pid
if [[ -f "$PID_F" ]]; then
  PID=$(cat "$PID_F")
  if [[ "$PID" == "pending" ]] || kill -0 "$PID" 2>/dev/null; then
    printf 'detach: "%s" already running (pid %s) — log: %s\n' "$NAME" "$PID" "$LOG" >&2
    exit 2
  fi
  rm -f "$PID_F"   # stale pidfile
fi

# placeholder — __run overwrites with real pid once it starts
printf 'pending\n' > "$PID_F"

# ── launch ────────────────────────────────────────────────────────────────────

printf '[%s] detach: starting %s\n' "$(date -Iseconds)" "$NAME" >> "$LOG"

# op in new session; stdout+stderr handled inside __run via >> $LOG
setsid -f bash "$SCRIPT" __run "$NAME" "$FACT" "$LOG" -- "$@" \
  </dev/null >/dev/null 2>&1

# stall watchdog in its own new session
setsid -f bash "$SCRIPT" __watchdog "$NAME" "$LOG" \
  </dev/null >/dev/null 2>&1

printf 'detach: launched "%s" → %s\n' "$NAME" "$LOG"
