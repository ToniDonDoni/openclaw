#!/usr/bin/env bash
set -euo pipefail

CLEAN=0
if [ "${1:-}" = "--clean" ]; then
  CLEAN=1
  shift
fi

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$BASE_DIR/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
STATE_DIR="$ROOT_DIR/state"
mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
PID_FILE="$LOG_DIR/openclaw-$STAMP.pid"
LATEST_PID_LINK="$BASE_DIR/openclaw.pid"
LOG_FILE="$LOG_DIR/openclaw-$STAMP.log"
LATEST_LOG_LINK="$LOG_DIR/openclaw.log"

is_running_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  local stat
  stat="$(ps -p "$pid" -o stat= 2>/dev/null | tr -d ' ')"
  [ -n "$stat" ] || return 1
  case "$stat" in
    Z*) return 1 ;;
    *) return 0 ;;
  esac
}

if [ -L "$LATEST_PID_LINK" ] || [ -f "$LATEST_PID_LINK" ]; then
  PID="$(cat "$LATEST_PID_LINK" 2>/dev/null || true)"
  if is_running_pid "$PID"; then
    echo "already running pid=$PID log=$LATEST_LOG_LINK"
    exit 0
  fi
  rm -f "$LATEST_PID_LINK"
fi

if [ "$CLEAN" -eq 1 ]; then
  rm -f "$STATE_DIR/telegram/update-offset-default.json"
  rm -f "$STATE_DIR/telegram/command-hash-default-"*.txt 2>/dev/null || true
  echo "cleaned openclaw test state"
fi

setsid bash -lc '
  set -euo pipefail
  echo "$BASHPID" > "$1"
  export OPENCLAW_CONFIG_PATH=/work/e2e-openclaw/config/openclaw.json
  export OPENCLAW_STATE_DIR=/work/e2e-openclaw/state
  exec node /work/openclaw/openclaw.mjs gateway run --verbose --port 28789
' _ "$PID_FILE" >>"$LOG_FILE" 2>&1 &

ln -sf "$PID_FILE" "$LATEST_PID_LINK"
ln -sf "$LOG_FILE" "$LATEST_LOG_LINK"

sleep 1
if [ -s "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_running_pid "$PID"; then
    echo "started pid=$PID log=$LOG_FILE pidfile=$PID_FILE"
    exit 0
  fi
fi

echo "started log=$LOG_FILE pidfile=$PID_FILE"
