#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_LINK="$BASE_DIR/tg-mock.pid"
STATE_PID_FILE="$BASE_DIR/../state/tg-mock.pid"

if [ ! -L "$PID_LINK" ] && [ ! -f "$PID_LINK" ]; then
  if [ -f "$STATE_PID_FILE" ]; then
    PID_LINK="$STATE_PID_FILE"
  else
    echo "not running"
    exit 0
  fi
fi

PID_FILE="$(readlink "$PID_LINK" 2>/dev/null || true)"
if [ -z "$PID_FILE" ]; then
  PID_FILE="$PID_LINK"
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$PID" ]; then
  rm -f "$PID_LINK"
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

rm -f "$PID_LINK"
