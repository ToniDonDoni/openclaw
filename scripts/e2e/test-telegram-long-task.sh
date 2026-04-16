#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
STAND_DIR="$(cd "$BASE_DIR/.." && pwd)"
LOG_DIR="$STAND_DIR/logs"
OPENCLAW_LOG="$LOG_DIR/openclaw.log"
TG_LOG="$LOG_DIR/tg-mock.log"
TEST_DONE_SLEEP_SEC="${TEST_DONE_SLEEP_SEC:-15}"
MSG="${1:-Use the exec tool to run this exact command: export TEST_DONE_SLEEP_SEC=${TEST_DONE_SLEEP_SEC}; /tmp/done . Wait until the command finishes. Then reply with exactly: DONE}"
EXPECTED_BOT_TEXT="${2:-DONE}"
WAIT_SECONDS="${WAIT_SECONDS:-120}"
MIN_REPLY_MS="${MIN_REPLY_MS:-$((TEST_DONE_SLEEP_SEC * 1000))}"
REQUIRE_PROGRESS_BEFORE_DONE="${REQUIRE_PROGRESS_BEFORE_DONE:-1}"
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
  TG_MOCK_EXPECT_BOT_TEXT="$EXPECTED_BOT_TEXT" \
  TG_MOCK_TIMEOUT_MS="$((WAIT_SECONDS * 1000))" \
  TG_MOCK_POLL_MS="$TG_MOCK_POLL_MS" \
  TG_MOCK_MIN_REPLY_MS="$MIN_REPLY_MS" \
  TG_MOCK_REQUIRE_PROGRESS_BEFORE_DONE="$REQUIRE_PROGRESS_BEFORE_DONE" \
  TG_MOCK_SENT_AT_MS="$TEST_SENT_AT_MS" \
  node --input-type=module <<'NODE'
import process from "node:process";

const apiRoot = process.env.TG_MOCK_API_ROOT ?? "http://127.0.0.1:19001";
const token = process.env.TG_MOCK_TOKEN ?? "TEST:TOKEN";
const expectedUserText = process.env.TG_MOCK_EXPECT_USER_TEXT ?? "";
const expectedBotText = process.env.TG_MOCK_EXPECT_BOT_TEXT ?? "";
const timeoutMs = Number(process.env.TG_MOCK_TIMEOUT_MS ?? "120000");
const pollMs = Number(process.env.TG_MOCK_POLL_MS ?? "2000");
const minReplyMs = Number(process.env.TG_MOCK_MIN_REPLY_MS ?? "0");
const requireProgressBeforeDone = process.env.TG_MOCK_REQUIRE_PROGRESS_BEFORE_DONE !== "0";
const sentAtMs = Number(process.env.TG_MOCK_SENT_AT_MS ?? "0");

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

const startedAt = Number.isFinite(sentAtMs) && sentAtMs > 0 ? sentAtMs : Date.now();
let lastPoll = null;

while (Date.now() - startedAt < timeoutMs) {
  const history = await post("/getUpdatesHistory", { token });
  const updates = Array.isArray(history.json?.result) ? history.json.result : [];

  let userIndex = -1;
  let matchingBotIndex = -1;
  let progressBotIndex = -1;
  const userTexts = [];
  const botTexts = [];

  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const text = textOf(update);
    if (hasChatId(update)) {
      botTexts.push(text);
      if (text === expectedBotText && matchingBotIndex === -1) {
        matchingBotIndex = index;
      }
      continue;
    }
    userTexts.push(text);
    if (text === expectedUserText && userIndex === -1) {
      userIndex = index;
    }
  }

  if (userIndex !== -1 && matchingBotIndex > userIndex) {
    for (let index = userIndex + 1; index < matchingBotIndex; index += 1) {
      const text = textOf(updates[index]);
      if (hasChatId(updates[index]) && typeof text === "string" && text.trim() && text !== expectedBotText) {
        progressBotIndex = index;
        break;
      }
    }
  }

  const matched = userIndex !== -1 && matchingBotIndex > userIndex;
  lastPoll = {
    elapsedMs: Date.now() - startedAt,
    count: updates.length,
    expectedUserText,
    expectedBotText,
    userIndex,
    matchingBotIndex,
    progressBotIndex,
    matched,
    userTexts,
    botTexts,
    snapshot: updates.map((update) => ({
      updateId: update?.updateId ?? null,
      messageId: update?.messageId ?? null,
      isRead: update?.isRead ?? null,
      text: textOf(update),
      chat_id: update?.message?.chat_id ?? null,
      hasFrom: Boolean(update?.message?.from),
    })),
  };

  if (matched) {
    const elapsedMs = Date.now() - startedAt;
    if (minReplyMs > 0 && elapsedMs < minReplyMs) {
      console.error(
        `early_reply expectedBotText=${JSON.stringify(expectedBotText)} elapsedMs=${elapsedMs} minReplyMs=${minReplyMs}`,
      );
      process.exit(2);
    }
    if (requireProgressBeforeDone && progressBotIndex === -1) {
      console.error(
        `missing_progress_before_done expectedBotText=${JSON.stringify(expectedBotText)} elapsedMs=${elapsedMs} minReplyMs=${minReplyMs}`,
      );
      process.exit(3);
    }
    console.log(
      `reply_matched expectedBotText=${JSON.stringify(expectedBotText)} elapsedMs=${elapsedMs} minReplyMs=${minReplyMs} progressBotIndex=${progressBotIndex}`,
    );
    process.exit(0);
  }

  await sleep(pollMs);
}

process.exit(1);
NODE
}

log "test_start msg=$MSG expected_bot_text=$EXPECTED_BOT_TEXT test_done_sleep_sec=$TEST_DONE_SLEEP_SEC min_reply_ms=$MIN_REPLY_MS require_progress_before_done=$REQUIRE_PROGRESS_BEFORE_DONE wait_seconds=$WAIT_SECONDS poll_ms=$TG_MOCK_POLL_MS"
log "inject_message text=$MSG"
TEST_SENT_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
node "$BASE_DIR/tg-mock-client.mjs" "$MSG"

log "wait_for_reply expected_user_text=$MSG expected_bot_text=$EXPECTED_BOT_TEXT min_reply_ms=$MIN_REPLY_MS require_progress_before_done=$REQUIRE_PROGRESS_BEFORE_DONE"
if wait_for_reply; then
  log "test_pass expected_user_text=$MSG expected_bot_text=$EXPECTED_BOT_TEXT min_reply_ms=$MIN_REPLY_MS require_progress_before_done=$REQUIRE_PROGRESS_BEFORE_DONE"
  printf 'PASS\n'
  exit 0
else
  status=$?
  log "test_fail status=$status expected_user_text=$MSG expected_bot_text=$EXPECTED_BOT_TEXT min_reply_ms=$MIN_REPLY_MS require_progress_before_done=$REQUIRE_PROGRESS_BEFORE_DONE"
  log "expected progress bot message before exact bot reply text=$EXPECTED_BOT_TEXT after user text=$MSG and not before ${MIN_REPLY_MS}ms"
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
