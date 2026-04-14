# TEST-README.md

Minimal manual Telegram mock/OpenClaw test flow.

## Requirements

This test setup uses the `jehy/telegram-test-api` Telegram mock project:

- `https://github.com/jehy/telegram-test-api`

In this environment, `tg-mock-server.mjs` imports the built library from a local workspace clone of that repository, so the project must be cloned and built before running the mock.

## Order

1. Start Telegram mock:

```sh
./scripts/run-tg-mock.sh
```

2. Start OpenClaw. For a clean test start, use `--clean`:

```sh
./scripts/run.sh --clean
```

If you do not need to clean state, use the normal start:

```sh
./scripts/run.sh
```

Why `--clean` matters:

- OpenClaw stores Telegram polling state, including the last update offset it has already consumed.
- If you reuse old state, OpenClaw can start with an offset that is already ahead of your freshly injected mock updates.
- That makes old or low-id test messages look stale, so they may be skipped immediately.
- Use `--clean` when you want a predictable fresh polling start and do not want old Telegram offset state to interfere with the test.

3. Run the single-message test:

```sh
./scripts/test-telegram-mock-openclaw.sh
```

The script will:

- send one message into tg-mock
- wait for a reply from OpenClaw
- print the result to stdout
- exit with `0` on pass and `1` on fail

Important timing rule:

- Inject test messages only after OpenClaw has fully started.
- During startup, OpenClaw may issue an initial `getUpdates` request with a high offset to drop old pending updates.
- If you preload mock messages too early, startup polling can consume or invalidate them before your actual test begins.
- For stable tests, start tg-mock, start OpenClaw, wait for OpenClaw to be up, and only then inject the test message.

4. Stop OpenClaw:

```sh
./scripts/stop.sh
```

5. Stop Telegram mock:

```sh
./scripts/stop-tg-mock.sh
```

## Logs

- OpenClaw: `./logs/openclaw.log`
- tg-mock: `./logs/tg-mock.log`
