# Self Check Gate

Session-scoped Telegram self-check gate for OpenClaw.

Commands:

- `/selfcheck on` arms the current session.
- `/selfcheck off` disarms the current session.

Behavior:

- Armed state is stored per session key in the session store.
- `message_sending` cancels the current outbound message, queues a same-session self-check followup, and keeps the gate scoped to the Telegram session.
- `before_tool_call` blocks non-read-only tools while the session is in self-check mode.
