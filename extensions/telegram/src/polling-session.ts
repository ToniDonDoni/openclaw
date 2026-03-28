import { type RunOptions, run } from "@grammyjs/runner";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/infra-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { formatDurationPrecise } from "openclaw/plugin-sdk/infra-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { type TelegramTransport } from "./fetch.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const POLL_STALL_THRESHOLD_MS = 90_000;
const POLL_WATCHDOG_INTERVAL_MS = 30_000;
const POLL_STOP_GRACE_MS = 15_000;
const DEBUG_GETUPDATES_FILE_ENV = "OPENCLAW_TELEGRAM_DEBUG_GETUPDATES_FILE";
const DEBUG_EMPTY_GETUPDATES_DELAY_MS = 250;

const waitForGracefulStop = async (stop: () => Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stop(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, POLL_STOP_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

type TelegramBot = ReturnType<typeof createTelegramBot>;

type TelegramPollingSessionOpts = {
  token: string;
  config: Parameters<typeof createTelegramBot>[0]["config"];
  accountId: string;
  runtime: Parameters<typeof createTelegramBot>[0]["runtime"];
  proxyFetch: Parameters<typeof createTelegramBot>[0]["proxyFetch"];
  abortSignal?: AbortSignal;
  runnerOptions: RunOptions<unknown>;
  getLastUpdateId: () => number | null;
  persistUpdateId: (updateId: number) => Promise<void>;
  log: (line: string) => void;
  /** Pre-resolved Telegram transport to reuse across bot instances */
  telegramTransport?: TelegramTransport;
  /** Rebuild Telegram transport after stall/network recovery when marked dirty. */
  createTelegramTransport?: () => TelegramTransport;
};

export class TelegramPollingSession {
  #restartAttempts = 0;
  #webhookCleared = false;
  #forceRestarted = false;
  #activeRunner: ReturnType<typeof run> | undefined;
  #activeFetchAbort: AbortController | undefined;
  #telegramTransport: TelegramTransport | undefined;
  #discardTransportOnRestart = false;
  constructor(private readonly opts: TelegramPollingSessionOpts) {
    this.#telegramTransport = opts.telegramTransport;
  }

  get activeRunner() {
    return this.#activeRunner;
  }

  markForceRestarted() {
    this.#forceRestarted = true;
  }

  markTransportDirty() {
    this.#discardTransportOnRestart = true;
  }

  abortActiveFetch() {
    this.#activeFetchAbort?.abort();
  }

  async runUntilAbort(): Promise<void> {
    while (!this.opts.abortSignal?.aborted) {
      this.opts.log("[telegram][poll_trace] createPollingBot:start");
      const bot = await this.#createPollingBot();
      this.opts.log(`[telegram][poll_trace] createPollingBot:${bot ? "done" : "retry"}`);
      if (!bot) {
        continue;
      }

      const cleanupState = await this.#ensureWebhookCleanup(bot);
      if (cleanupState === "retry") {
        continue;
      }
      if (cleanupState === "exit") {
        return;
      }

      const state = await this.#runPollingCycle(bot);
      if (state === "exit") {
        return;
      }
    }
  }

  async #waitBeforeRestart(buildLine: (delay: string) => string): Promise<boolean> {
    this.#restartAttempts += 1;
    const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, this.#restartAttempts);
    const delay = formatDurationPrecise(delayMs);
    this.opts.log(buildLine(delay));
    try {
      await sleepWithAbort(delayMs, this.opts.abortSignal);
    } catch (sleepErr) {
      if (this.opts.abortSignal?.aborted) {
        return false;
      }
      throw sleepErr;
    }
    return true;
  }

  async #waitBeforeRetryOnRecoverableSetupError(err: unknown, logPrefix: string): Promise<boolean> {
    if (this.opts.abortSignal?.aborted) {
      return false;
    }
    if (!isRecoverableTelegramNetworkError(err, { context: "unknown" })) {
      throw err;
    }
    return this.#waitBeforeRestart(
      (delay) => `${logPrefix}: ${formatErrorMessage(err)}; retrying in ${delay}.`,
    );
  }

  async #createPollingBot(): Promise<TelegramBot | undefined> {
    const fetchAbortController = new AbortController();
    this.#activeFetchAbort = fetchAbortController;
    const shouldRebuildTransport = this.#discardTransportOnRestart || !this.#telegramTransport;
    const telegramTransport = shouldRebuildTransport
      ? (this.opts.createTelegramTransport?.() ?? this.#telegramTransport)
      : this.#telegramTransport;
    if (shouldRebuildTransport && telegramTransport) {
      this.opts.log("[telegram][diag] rebuilding transport for next polling cycle");
    }
    this.#telegramTransport = telegramTransport;
    this.#discardTransportOnRestart = false;
    try {
      return createTelegramBot({
        token: this.opts.token,
        runtime: this.opts.runtime,
        proxyFetch: this.opts.proxyFetch,
        config: this.opts.config,
        accountId: this.opts.accountId,
        fetchAbortSignal: fetchAbortController.signal,
        updateOffset: {
          lastUpdateId: this.opts.getLastUpdateId(),
          onUpdateId: this.opts.persistUpdateId,
        },
        telegramTransport,
      });
    } catch (err) {
      await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram setup network error");
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
      }
      return undefined;
    }
  }

  async #ensureWebhookCleanup(bot: TelegramBot): Promise<"ready" | "retry" | "exit"> {
    if (this.#webhookCleared) {
      return "ready";
    }
    try {
      this.opts.log("[telegram][poll_trace] deleteWebhook:start");
      await withTelegramApiErrorLogging({
        operation: "deleteWebhook",
        runtime: this.opts.runtime,
        fn: () => bot.api.deleteWebhook({ drop_pending_updates: false }),
      });
      this.#webhookCleared = true;
      this.opts.log("[telegram][poll_trace] deleteWebhook:done");
      return "ready";
    } catch (err) {
      const shouldRetry = await this.#waitBeforeRetryOnRecoverableSetupError(
        err,
        "Telegram webhook cleanup failed",
      );
      return shouldRetry ? "retry" : "exit";
    }
  }

  async #confirmPersistedOffset(bot: TelegramBot): Promise<void> {
    const lastUpdateId = this.opts.getLastUpdateId();
    if (lastUpdateId === null || lastUpdateId >= Number.MAX_SAFE_INTEGER) {
      return;
    }
    try {
      this.opts.log(`[telegram][poll_trace] confirmOffset:start offset=${lastUpdateId + 1}`);
      await bot.api.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
      this.opts.log("[telegram][poll_trace] confirmOffset:done");
    } catch {
      // Non-fatal: runner middleware still skips duplicates via shouldSkipUpdate.
      this.opts.log("[telegram][poll_trace] confirmOffset:error");
    }
  }

  async #runPollingCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    await this.#confirmPersistedOffset(bot);

    const botWithDebug = bot as TelegramBot & {
      init?: () => Promise<unknown>;
      handleUpdate?: (update: unknown) => Promise<void>;
    };
    if (typeof botWithDebug.init === "function") {
      const originalInit = botWithDebug.init.bind(botWithDebug);
      botWithDebug.init = async () => {
        this.opts.log("[telegram][poll_trace] bot.init:start");
        try {
          const result = await originalInit();
          this.opts.log("[telegram][poll_trace] bot.init:done");
          return result;
        } catch (error) {
          this.opts.log(`[telegram][poll_trace] bot.init:error ${formatErrorMessage(error)}`);
          throw error;
        }
      };
    }
    const debugApi = botWithDebug.api as typeof botWithDebug.api & {
      getUpdates: typeof botWithDebug.api.getUpdates;
    };
    const originalGetUpdates = debugApi.getUpdates.bind(debugApi);
    debugApi.getUpdates = (async (
      ...args: Parameters<typeof originalGetUpdates>
    ): Promise<Awaited<ReturnType<typeof originalGetUpdates>>> => {
      this.opts.log(
        `[telegram][poll_trace] bot.api.getUpdates:start payload=${JSON.stringify(args[0] ?? {})}`,
      );
      try {
        const updates = await originalGetUpdates(...args);
        if (
          process.env[DEBUG_GETUPDATES_FILE_ENV]?.trim() &&
          Array.isArray(updates) &&
          updates.length === 0
        ) {
          this.opts.log(
            `[telegram][poll_trace] bot.api.getUpdates:debug-empty-delay ms=${DEBUG_EMPTY_GETUPDATES_DELAY_MS}`,
          );
          await sleepWithAbort(DEBUG_EMPTY_GETUPDATES_DELAY_MS, this.opts.abortSignal);
        }
        this.opts.log(
          `[telegram][poll_trace] bot.api.getUpdates:done count=${Array.isArray(updates) ? updates.length : -1}`,
        );
        return updates;
      } catch (error) {
        this.opts.log(
          `[telegram][poll_trace] bot.api.getUpdates:error ${formatErrorMessage(error)}`,
        );
        throw error;
      }
    }) as typeof originalGetUpdates;
    if (typeof botWithDebug.handleUpdate === "function") {
      const originalHandleUpdate = botWithDebug.handleUpdate.bind(botWithDebug);
      botWithDebug.handleUpdate = async (update) => {
        const updateId =
          update && typeof update === "object" && "update_id" in update
            ? String((update as { update_id?: unknown }).update_id ?? "unknown")
            : "unknown";
        this.opts.log(`[telegram][poll_trace] handleUpdate:start update_id=${updateId}`);
        try {
          await originalHandleUpdate(update);
          this.opts.log(`[telegram][poll_trace] handleUpdate:done update_id=${updateId}`);
          return;
        } catch (error) {
          this.opts.log(
            `[telegram][poll_trace] handleUpdate:error update_id=${updateId} ${formatErrorMessage(error)}`,
          );
          throw error;
        }
      };
    }

    let lastGetUpdatesAt = Date.now();
    let lastGetUpdatesStartedAt: number | null = null;
    let lastGetUpdatesFinishedAt: number | null = null;
    let lastGetUpdatesDurationMs: number | null = null;
    let lastGetUpdatesOutcome = "not-started";
    let lastGetUpdatesError: string | null = null;
    let lastGetUpdatesOffset: number | null = null;
    let inFlightGetUpdates = 0;
    let stopSequenceLogged = false;
    let stallDiagLoggedAt = 0;

    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method !== "getUpdates") {
        return prev(method, payload, signal);
      }

      const startedAt = Date.now();
      lastGetUpdatesAt = startedAt;
      lastGetUpdatesStartedAt = startedAt;
      lastGetUpdatesOffset =
        payload && typeof payload === "object" && "offset" in payload
          ? ((payload as { offset?: number }).offset ?? null)
          : null;
      inFlightGetUpdates += 1;
      lastGetUpdatesOutcome = "started";
      lastGetUpdatesError = null;

      try {
        const result = await prev(method, payload, signal);
        const finishedAt = Date.now();
        lastGetUpdatesFinishedAt = finishedAt;
        lastGetUpdatesDurationMs = finishedAt - startedAt;
        lastGetUpdatesOutcome = Array.isArray(result) ? `ok:${result.length}` : "ok";
        return result;
      } catch (err) {
        const finishedAt = Date.now();
        lastGetUpdatesFinishedAt = finishedAt;
        lastGetUpdatesDurationMs = finishedAt - startedAt;
        lastGetUpdatesOutcome = "error";
        lastGetUpdatesError = formatErrorMessage(err);
        throw err;
      } finally {
        inFlightGetUpdates = Math.max(0, inFlightGetUpdates - 1);
      }
    });

    this.opts.log("[telegram][poll_trace] runner:start");
    const runner = run(botWithDebug, this.opts.runnerOptions);
    this.opts.log("[telegram][poll_trace] runner:started");
    this.#activeRunner = runner;
    const fetchAbortController = this.#activeFetchAbort;
    const abortFetch = () => {
      fetchAbortController?.abort();
    };

    if (this.opts.abortSignal && fetchAbortController) {
      this.opts.abortSignal.addEventListener("abort", abortFetch, { once: true });
    }
    let stopPromise: Promise<void> | undefined;
    let stalledRestart = false;
    let forceCycleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCycleResolve: (() => void) | undefined;
    const forceCyclePromise = new Promise<void>((resolve) => {
      forceCycleResolve = resolve;
    });
    const stopRunner = () => {
      fetchAbortController?.abort();
      stopPromise ??= Promise.resolve(runner.stop())
        .then(() => undefined)
        .catch(() => {
          // Runner may already be stopped by abort/retry paths.
        });
      return stopPromise;
    };
    const stopBot = () => {
      return Promise.resolve(bot.stop())
        .then(() => undefined)
        .catch(() => {
          // Bot may already be stopped by runner stop/abort paths.
        });
    };
    const stopOnAbort = () => {
      if (this.opts.abortSignal?.aborted) {
        void stopRunner();
      }
    };

    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted) {
        return;
      }

      const now = Date.now();
      const activeElapsed =
        inFlightGetUpdates > 0 && lastGetUpdatesStartedAt != null
          ? now - lastGetUpdatesStartedAt
          : 0;
      const idleElapsed =
        inFlightGetUpdates > 0 ? 0 : now - (lastGetUpdatesFinishedAt ?? lastGetUpdatesAt);
      const elapsed = inFlightGetUpdates > 0 ? activeElapsed : idleElapsed;

      if (elapsed > POLL_STALL_THRESHOLD_MS && runner.isRunning()) {
        if (stallDiagLoggedAt && now - stallDiagLoggedAt < POLL_STALL_THRESHOLD_MS / 2) {
          return;
        }
        stallDiagLoggedAt = now;
        this.#discardTransportOnRestart = true;
        stalledRestart = true;
        const elapsedLabel =
          inFlightGetUpdates > 0
            ? `active getUpdates stuck for ${formatDurationPrecise(elapsed)}`
            : `no completed getUpdates for ${formatDurationPrecise(elapsed)}`;
        this.opts.log(
          `[telegram] Polling stall detected (${elapsedLabel}); forcing restart. [diag inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"}${lastGetUpdatesError ? ` error=${lastGetUpdatesError}` : ""}]`,
        );
        void stopRunner();
        void stopBot();
        if (!forceCycleTimer) {
          forceCycleTimer = setTimeout(() => {
            if (this.opts.abortSignal?.aborted) {
              return;
            }
            this.opts.log(
              `[telegram] Polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`,
            );
            forceCycleResolve?.();
          }, POLL_STOP_GRACE_MS);
        }
      }
    }, POLL_WATCHDOG_INTERVAL_MS);

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      await Promise.race([runner.task(), forceCyclePromise]);
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      const reason = stalledRestart
        ? "polling stall detected"
        : this.#forceRestarted
          ? "unhandled network error"
          : "runner stopped (maxRetryTime exceeded or graceful stop)";
      this.#forceRestarted = false;
      this.opts.log(
        `[telegram][diag] polling cycle finished reason=${reason} inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"}${lastGetUpdatesError ? ` error=${lastGetUpdatesError}` : ""}`,
      );
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram polling runner stopped (${reason}); restarting in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } catch (err) {
      this.#forceRestarted = false;
      if (this.opts.abortSignal?.aborted) {
        throw err;
      }
      const isConflict = isGetUpdatesConflict(err);
      if (isConflict) {
        this.#webhookCleared = false;
      }
      const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
      if (isConflict || isRecoverable) {
        this.#discardTransportOnRestart = true;
      }
      if (!isConflict && !isRecoverable) {
        throw err;
      }
      const reason = isConflict ? "getUpdates conflict" : "network error";
      const errMsg = formatErrorMessage(err);
      this.opts.log(
        `[telegram][diag] polling cycle error reason=${reason} inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"} err=${errMsg}${lastGetUpdatesError ? ` lastGetUpdatesError=${lastGetUpdatesError}` : ""}`,
      );
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(watchdog);
      if (forceCycleTimer) {
        clearTimeout(forceCycleTimer);
      }
      this.opts.abortSignal?.removeEventListener("abort", abortFetch);
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      await waitForGracefulStop(stopRunner);
      await waitForGracefulStop(stopBot);
      this.#activeRunner = undefined;
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
      }
    }
  }
}

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};
