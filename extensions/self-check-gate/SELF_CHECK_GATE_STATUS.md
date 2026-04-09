# Self Check Gate Status

## Done

- The plugin can be enabled from Telegram with `/selfcheck on`.
- Armed session lookup now works for Telegram conversation ids and command flow.
- The real Telegram reply path reaches `message_sending` on preview finalization.
- The plugin runs an inline self-check cycle inside `message_sending` instead of scheduling a detached follow-up through core dispatch.
- Inline self-check reuses the same runtime selection as the original turn (`provider`, `model`, and auth profile).
- A real delay is applied before nested reruns through `SELF_CHECK_FOLLOWUP_DELAY_MS`.
- The plugin now keeps the current candidate text for terminal verdicts (`done`, `wait_external`, `blocked_external`) instead of generating a separate release message.
- Continuation loops are capped with `MAX_CONTINUE_ITERATIONS = 3` to avoid burning tokens.

## Current Behavior

- `done` returns the current candidate text.
- `wait_external` returns the current candidate text.
- `blocked_external` returns the current candidate text.
- `continue` runs another work turn, then re-checks the new candidate.

## TODO

- Extend the plugin hook/runtime input with an `AbortSignal`-style object so the inline self-check cycle can be canceled cleanly.
- Move timing and retry limits into plugin configuration:
  - self-check delay
  - maximum continuation iterations
  - maximum attempts
- Move the hardcoded self-check prompt text into plugin configuration.

## Last Verification

- `pnpm test extensions/self-check-gate/index.test.ts extensions/telegram/src/bot/delivery.test.ts extensions/telegram/src/bot-message-dispatch.test.ts`
- `NODE_OPTIONS="--max-old-space-size=5120" pnpm build`
