#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$BASE_DIR/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
STATE_DIR="$ROOT_DIR/state/tg-mock"
COUNTER_FILE="$STATE_DIR/counters.json"
PID_LINK="$BASE_DIR/tg-mock.pid"
LATEST_LOG_LINK="$LOG_DIR/tg-mock.log"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
PID_FILE="$LOG_DIR/tg-mock-$STAMP.pid"
LOG_FILE="$LOG_DIR/tg-mock-$STAMP.log"

mkdir -p "$LOG_DIR" "$STATE_DIR"
export COUNTER_FILE

NEXT_ID=$(python3 - <<'PY'
import json, os
p=os.environ['COUNTER_FILE']
last=400
if os.path.exists(p):
    try:
        with open(p) as f:
            data=json.load(f)
            last=max(int(data.get('lastUpdateId', 400)), int(data.get('lastMessageId', 400)))
    except Exception:
        last=400
next_id=last+1
with open(p, 'w') as f:
    json.dump({'lastUpdateId': next_id, 'lastMessageId': next_id}, f)
print(next_id)
PY
)

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

if [ -L "$PID_LINK" ] || [ -f "$PID_LINK" ]; then
  PID="$(cat "$PID_LINK" 2>/dev/null || true)"
  if is_running_pid "$PID"; then
    echo "already running pid=$PID log=$LATEST_LOG_LINK"
    exit 0
  fi
  rm -f "$PID_LINK"
fi

export COUNTER_FILE
setsid bash -lc '
  set -euo pipefail
  echo "$BASHPID" > "$1"
  export TG_MOCK_HOST=127.0.0.1
  export TG_MOCK_PORT=19001
  export TG_MOCK_TOKEN=TEST:TOKEN
  export TG_MOCK_STATE_DIR=/work/e2e-openclaw/state/tg-mock
  export TG_MOCK_START_UPDATE_ID="$2"
  export TG_MOCK_START_MESSAGE_ID="$2"
  exec node /work/e2e-openclaw/scripts/tg-mock-server.mjs
' _ "$PID_FILE" "$NEXT_ID" >>"$LOG_FILE" 2>&1 &

ln -sf "$PID_FILE" "$PID_LINK"
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
