#!/usr/bin/env bash
set -euo pipefail

# /tmp/done helper source:
#   #include <stdio.h>
#   #include <stdlib.h>
#   #include <time.h>
#   #include <unistd.h>
#
#   int main(void) {
#     const char *value = getenv("TEST_DONE_SLEEP_SEC");
#     unsigned int sleep_sec = value == NULL ? 20U : (unsigned int)atoi(value);
#     sleep(sleep_sec);
#     printf("done %ld\n", (long)time(NULL));
#     return 0;
#   }
#
# Build:
#   gcc -O2 -Wall -Wextra -o /tmp/done done.c

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
STAND_DIR="$(cd "$BASE_DIR/.." && pwd)"
LOG_DIR="$STAND_DIR/logs"
OPENCLAW_LOG="$LOG_DIR/openclaw.log"
TG_LOG="$LOG_DIR/tg-mock.log"
TEST_DONE_SLEEP_SEC="${TEST_DONE_SLEEP_SEC:-45}"
MSG="${1:-Start /tmp/done with a 60 second timeout. It is likely to run about 10 seconds. You may return once it has started, but I still need the exact command output when it finishes.}"
WAIT_SECONDS="${WAIT_SECONDS:-120}"
MIN_REPLY_MS="${MIN_REPLY_MS:-$((TEST_DONE_SLEEP_SEC * 1000))}"
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
  TG_MOCK_TIMEOUT_MS="$((WAIT_SECONDS * 1000))" \
  TG_MOCK_POLL_MS="$TG_MOCK_POLL_MS" \
  TG_MOCK_MIN_REPLY_MS="$MIN_REPLY_MS" \
  TG_MOCK_SENT_AT_MS="$TEST_SENT_AT_MS" \
  node --input-type=module <<'NODE'
import process from "node:process";

const apiRoot = process.env.TG_MOCK_API_ROOT ?? "http://127.0.0.1:19001";
const token = process.env.TG_MOCK_TOKEN ?? "TEST:TOKEN";
const expectedUserText = process.env.TG_MOCK_EXPECT_USER_TEXT ?? "";
const timeoutMs = Number(process.env.TG_MOCK_TIMEOUT_MS ?? "120000");
const pollMs = Number(process.env.TG_MOCK_POLL_MS ?? "2000");
const minReplyMs = Number(process.env.TG_MOCK_MIN_REPLY_MS ?? "0");
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
const extractDoneOutput = (text) => {
  if (typeof text !== "string") {
    return null;
  }
  const direct = /^done\s+\d+$/u.exec(text.trim());
  if (direct) {
    return direct[0];
  }
  const embedded = /(?:^|[\n>])\s*(done\s+\d+)\s*(?:[\n<]|$)/u.exec(text);
  return embedded?.[1] ?? null;
};

const startedAt = Number.isFinite(sentAtMs) && sentAtMs > 0 ? sentAtMs : Date.now();
let lastPoll = null;
const loggedInterimBotTexts = new Set();

while (Date.now() - startedAt < timeoutMs) {
  const history = await post("/getUpdatesHistory", { token });
  const updates = Array.isArray(history.json?.result) ? history.json.result : [];

  let userIndex = -1;
  let doneBotIndex = -1;
  let doneBotText = null;
  const userTexts = [];
  const botTexts = [];
  const botTextsAfterUser = [];

  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const text = textOf(update);
    if (hasChatId(update)) {
      botTexts.push(text);
      if (userIndex !== -1 && index > userIndex && typeof text === "string") {
        botTextsAfterUser.push(text);
        const doneOutput = extractDoneOutput(text);
        if (doneOutput && doneBotIndex === -1) {
          doneBotIndex = index;
          doneBotText = doneOutput;
          console.log(`completion_bot_output output=${JSON.stringify(doneOutput)} elapsedMs=${Date.now() - startedAt}`);
        } else if (text.trim() && !loggedInterimBotTexts.has(text)) {
          loggedInterimBotTexts.add(text);
          console.log(`interim_bot_output output=${JSON.stringify(text.trim())} elapsedMs=${Date.now() - startedAt}`);
        }
      }
      continue;
    }
    userTexts.push(text);
    if (text === expectedUserText && userIndex === -1) {
      userIndex = index;
    }
  }

  const matched = userIndex !== -1 && doneBotIndex > userIndex;
  lastPoll = {
    elapsedMs: Date.now() - startedAt,
    count: updates.length,
    expectedUserText,
    userIndex,
    doneBotIndex,
    doneBotText,
    matched,
    userTexts,
    botTexts,
    botTextsAfterUser,
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
    if (typeof doneBotText !== "string" || !doneBotText.trim()) {
      console.error(
        `empty_bot_output elapsedMs=${Date.now() - startedAt} minReplyMs=${minReplyMs}`,
      );
      process.exit(2);
    }
    const trimmedOutput = doneBotText.trim();
    const outputMatch = /^done\s+(\d+)$/u.exec(trimmedOutput);
    if (!outputMatch) {
      console.error(
        `invalid_bot_output output=${JSON.stringify(trimmedOutput)} elapsedMs=${Date.now() - startedAt} minReplyMs=${minReplyMs}`,
      );
      process.exit(2);
    }
    const outputTimestampMs = Number(outputMatch[1]) * 1000;
    const outputElapsedMs = outputTimestampMs - startedAt;
    const replyElapsedMs = Date.now() - startedAt;
    if (!Number.isFinite(outputTimestampMs) || outputElapsedMs < minReplyMs) {
      console.error(
        `early_command_output output=${JSON.stringify(trimmedOutput)} outputElapsedMs=${outputElapsedMs} replyElapsedMs=${replyElapsedMs} minReplyMs=${minReplyMs} sentAtMs=${startedAt} outputTimestampMs=${outputTimestampMs}`,
      );
      process.exit(3);
    }
    console.log(
      `reply_matched output=${JSON.stringify(trimmedOutput)} outputElapsedMs=${outputElapsedMs} replyElapsedMs=${replyElapsedMs} minReplyMs=${minReplyMs} sentAtMs=${startedAt} outputTimestampMs=${outputTimestampMs}`,
    );
    process.exit(0);
  }

  await sleep(pollMs);
}

process.exit(1);
NODE
}

log "test_start msg=$MSG test_done_sleep_sec=$TEST_DONE_SLEEP_SEC min_reply_ms=$MIN_REPLY_MS wait_seconds=$WAIT_SECONDS poll_ms=$TG_MOCK_POLL_MS"
log "kill_stale_done_processes"
pkill -9 -x done 2>/dev/null || true
log "inject_message text=$MSG"
TEST_SENT_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
node "$BASE_DIR/tg-mock-client.mjs" "$MSG"

log "wait_for_background_completion expected_user_text=$MSG min_reply_ms=$MIN_REPLY_MS"
if wait_for_reply; then
  log "test_pass expected_user_text=$MSG min_reply_ms=$MIN_REPLY_MS"
  printf 'PASS\n'
  exit 0
else
  status=$?
  log "test_fail status=$status expected_user_text=$MSG min_reply_ms=$MIN_REPLY_MS"
  log "expected eventual bot reply to include /tmp/done output matching 'done <unix_seconds>' with output timestamp at least ${MIN_REPLY_MS}ms after test send timestamp; interim bot replies are allowed"
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
