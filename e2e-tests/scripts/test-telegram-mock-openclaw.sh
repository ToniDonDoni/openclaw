#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
STAND_DIR="$(cd "$BASE_DIR/.." && pwd)"
LOG_DIR="$STAND_DIR/logs"
OPENCLAW_LOG="$LOG_DIR/openclaw.log"
TG_LOG="$LOG_DIR/tg-mock.log"
MSG="${1:-test-kuku-1}"
OPENCLAW_TG_TEST_WAIT_SECONDS="${OPENCLAW_TG_TEST_WAIT_SECONDS:-60}"
TG_MOCK_API_ROOT="${TG_MOCK_API_ROOT:-http://127.0.0.1:19001}"
TG_MOCK_TOKEN="${TG_MOCK_TOKEN:-TEST:TOKEN}"
TG_MOCK_POLL_MS="${TG_MOCK_POLL_MS:-2000}"

mkdir -p "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"
}

wait_for_reply() {
  TG_MOCK_API_ROOT="$TG_MOCK_API_ROOT" \
  TG_MOCK_TOKEN="$TG_MOCK_TOKEN" \
  TG_MOCK_EXPECT_USER_TEXT="$MSG" \
  TG_MOCK_TIMEOUT_MS="$((OPENCLAW_TG_TEST_WAIT_SECONDS * 1000))" \
  TG_MOCK_POLL_MS="$TG_MOCK_POLL_MS" \
  node --input-type=module <<'NODE'
import process from "node:process";

const apiRoot = process.env.TG_MOCK_API_ROOT ?? "http://127.0.0.1:19001";
const token = process.env.TG_MOCK_TOKEN ?? "TEST:TOKEN";
const expectedUserText = process.env.TG_MOCK_EXPECT_USER_TEXT ?? "";
const timeoutMs = Number(process.env.TG_MOCK_TIMEOUT_MS ?? "60000");
const pollMs = Number(process.env.TG_MOCK_POLL_MS ?? "2000");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path, body) {
  const res = await fetch(`${apiRoot}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, raw: text };
  }
  return { status: res.status, json };
}

const hasChatId = (update) =>
  Boolean(update && typeof update === "object" && update.message && Object.hasOwn(update.message, "chat_id"));
const textOf = (update) =>
  typeof update?.message?.text === "string" ? update.message.text : null;

const startedAt = Date.now();
while (Date.now() - startedAt < timeoutMs) {
  const history = await post("/getUpdatesHistory", { token });
  const updates = Array.isArray(history.json?.result) ? history.json.result : [];

  let userIndex = -1;
  let firstBotIndex = -1;

  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const text = textOf(update);
    if (hasChatId(update)) {
      if (firstBotIndex === -1) {
        firstBotIndex = index;
      }
      continue;
    }
    if (text === expectedUserText && userIndex === -1) {
      userIndex = index;
    }
  }

  const matched = userIndex !== -1 && firstBotIndex > userIndex;
  if (matched) {
    process.exit(0);
  }

  await sleep(pollMs);
}

process.exit(1);
NODE
}

log "test_start msg=$MSG wait_seconds=$OPENCLAW_TG_TEST_WAIT_SECONDS poll_ms=$TG_MOCK_POLL_MS"
log "inject_message text=$MSG"
node "$BASE_DIR/tg-mock-client.mjs" "$MSG"

log "wait_for_reply expected_user_text=$MSG"
if wait_for_reply; then
  log "test_pass expected_user_text=$MSG"
  printf 'PASS\n'
  exit 0
else
  log "test_fail expected_user_text=$MSG"
  log "expected a bot reply after user text=$MSG"
  log "tg_mock_history_snapshot_begin"
  node "$BASE_DIR/tg-mock-history.mjs" || true
  log "tg_mock_history_snapshot_end"
  log "tg_mock_log_tail_begin"
  tail -n 220 "$TG_LOG" || true
  log "tg_mock_log_tail_end"
  log "openclaw_log_tail_begin"
  tail -n 220 "$OPENCLAW_LOG" || true
  log "openclaw_log_tail_end"
  printf 'FAILED\n'
  exit 1
fi
