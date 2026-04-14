#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LATEST_PID_LINK="$BASE_DIR/openclaw.pid"
STATE_PID_FILE="$BASE_DIR/../state/openclaw.pid"

if [ ! -L "$LATEST_PID_LINK" ] && [ ! -f "$LATEST_PID_LINK" ]; then
  if [ -f "$STATE_PID_FILE" ]; then
    LATEST_PID_LINK="$STATE_PID_FILE"
  else
    echo "not running"
    exit 0
  fi
fi

PID_FILE="$(readlink "$LATEST_PID_LINK" 2>/dev/null || true)"
if [ -z "$PID_FILE" ]; then
  PID_FILE="$LATEST_PID_LINK"
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$PID" ]; then
  rm -f "$LATEST_PID_LINK"
  echo "not running"
  exit 0
fi

STAT="$(ps -p "$PID" -o stat= 2>/dev/null | tr -d ' ' || true)"
if [ -n "$STAT" ] && [ "${STAT#Z}" = "$STAT" ]; then
  kill "$PID" 2>/dev/null || true
  echo "stopped pid=$PID"
else
  echo "not running"
fi

rm -f "$LATEST_PID_LINK"
