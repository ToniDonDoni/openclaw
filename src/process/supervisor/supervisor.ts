import crypto from "node:crypto";
import { getShellConfig } from "../../agents/shell-utils.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import { logExecRuntimeLifecycle } from "./lifecycle-log.runtime.js";
import { createRunRegistry } from "./registry.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  SpawnInput,
  TerminationReason,
} from "./types.js";

type ActiveRun = {
  run: ManagedRun;
  scopeKey?: string;
  sessionId: string;
  backendId: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
};

function clampTimeout(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function isTimeoutReason(reason: TerminationReason) {
  return reason === "overall-timeout" || reason === "no-output-timeout";
}

function describeSpawnCommand(input: SpawnInput): string {
  return input.mode === "pty" ? input.ptyCommand : input.argv.join(" ");
}

export function createProcessSupervisor(): ProcessSupervisor {
  const registry = createRunRegistry();
  const active = new Map<string, ActiveRun>();

  const cancel = (runId: string, reason: TerminationReason = "manual-cancel") => {
    const current = active.get(runId);
    if (!current) {
      logExecRuntimeLifecycle("supervisor-cancel-miss", {
        runId,
        reason,
        action: "cancel",
      });
      return;
    }
    logExecRuntimeLifecycle("supervisor-cancel-request", {
      runId,
      sessionId: current.sessionId,
      pid: current.run.pid,
      command: current.command,
      cwd: current.cwd,
      timeoutMs: current.timeoutMs,
      noOutputTimeoutMs: current.noOutputTimeoutMs,
      reason,
      timedOut: isTimeoutReason(reason),
      action: "cancel",
    });
    registry.updateState(runId, "exiting", {
      terminationReason: reason,
    });
    current.run.cancel(reason);
  };

  const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
    if (!scopeKey.trim()) {
      return;
    }
    logExecRuntimeLifecycle("supervisor-cancel-scope", {
      scopeKey,
      reason,
      action: "cancelScope",
      timedOut: isTimeoutReason(reason),
    });
    for (const [runId, run] of active.entries()) {
      if (run.scopeKey !== scopeKey) {
        continue;
      }
      cancel(runId, reason);
    }
  };

  const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
    const runId = normalizeOptionalString(input.runId) ?? crypto.randomUUID();
    const scopeKey = normalizeOptionalString(input.scopeKey);
    if (input.replaceExistingScope && scopeKey) {
      cancelScope(scopeKey, "manual-cancel");
    }
    const startedAtMs = Date.now();
    const record: RunRecord = {
      runId,
      sessionId: input.sessionId,
      backendId: input.backendId,
      scopeKey,
      state: "starting",
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    let forcedReason: TerminationReason | null = null;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timeoutTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const captureOutput = input.captureOutput !== false;

    const overallTimeoutMs = clampTimeout(input.timeoutMs);
    const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);
    const command = describeSpawnCommand(input);

    logExecRuntimeLifecycle("supervisor-spawn-request", {
      runId,
      sessionId: input.sessionId,
      backendId: input.backendId,
      command,
      cwd: input.cwd,
      timeoutMs: overallTimeoutMs,
      noOutputTimeoutMs,
      mode: input.mode,
      replaceExistingScope: input.replaceExistingScope === true,
      timedOut: false,
    });

    const setForcedReason = (reason: TerminationReason) => {
      if (forcedReason) {
        return;
      }
      forcedReason = reason;
      registry.updateState(runId, "exiting", { terminationReason: reason });
    };

    let cancelAdapter: ((reason: TerminationReason) => void) | null = null;

    const requestCancel = (reason: TerminationReason) => {
      logExecRuntimeLifecycle("supervisor-cancel-dispatch", {
        runId,
        sessionId: input.sessionId,
        command,
        cwd: input.cwd,
        timeoutMs: overallTimeoutMs,
        noOutputTimeoutMs,
        reason,
        timedOut: isTimeoutReason(reason),
        action: "requestCancel",
      });
      setForcedReason(reason);
      cancelAdapter?.(reason);
    };

    const touchOutput = () => {
      registry.touchOutput(runId);
      if (!noOutputTimeoutMs || settled) {
        return;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        requestCancel("no-output-timeout");
      }, noOutputTimeoutMs);
    };

    try {
      if (input.mode === "child" && input.argv.length === 0) {
        throw new Error("spawn argv cannot be empty");
      }
      const adapter =
        input.mode === "pty"
          ? await (async () => {
              const { shell, args: shellArgs } = getShellConfig();
              const ptyCommand = input.ptyCommand.trim();
              if (!ptyCommand) {
                throw new Error("PTY command cannot be empty");
              }
              return await createPtyAdapter({
                shell,
                args: [...shellArgs, ptyCommand],
                cwd: input.cwd,
                env: input.env,
                logContext: {
                  runId,
                  sessionId: input.sessionId,
                  backendId: input.backendId,
                  command,
                  cwd: input.cwd,
                  timeoutMs: overallTimeoutMs,
                  noOutputTimeoutMs,
                  mode: input.mode,
                },
              });
            })()
          : await createChildAdapter({
              argv: input.argv,
              cwd: input.cwd,
              env: input.env,
              windowsVerbatimArguments: input.windowsVerbatimArguments,
              input: input.input,
              stdinMode: input.stdinMode,
              logContext: {
                runId,
                sessionId: input.sessionId,
                backendId: input.backendId,
                command,
                cwd: input.cwd,
                timeoutMs: overallTimeoutMs,
                noOutputTimeoutMs,
                mode: input.mode,
              },
            });

      registry.updateState(runId, "running", { pid: adapter.pid });
      logExecRuntimeLifecycle("supervisor-running", {
        runId,
        sessionId: input.sessionId,
        backendId: input.backendId,
        pid: adapter.pid,
        command,
        cwd: input.cwd,
        timeoutMs: overallTimeoutMs,
        noOutputTimeoutMs,
        mode: input.mode,
        timedOut: false,
      });

      const clearTimers = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (noOutputTimer) {
          clearTimeout(noOutputTimer);
          noOutputTimer = null;
        }
      };

      cancelAdapter = (_reason: TerminationReason) => {
        if (settled) {
          logExecRuntimeLifecycle("supervisor-kill-skip-settled", {
            runId,
            sessionId: input.sessionId,
            pid: adapter.pid,
            command,
            cwd: input.cwd,
            reason: _reason,
            timedOut: isTimeoutReason(_reason),
            action: "kill",
          });
          return;
        }
        logExecRuntimeLifecycle("supervisor-kill-adapter", {
          runId,
          sessionId: input.sessionId,
          pid: adapter.pid,
          command,
          cwd: input.cwd,
          reason: _reason,
          signal: "SIGKILL",
          timedOut: isTimeoutReason(_reason),
          action: "kill",
        });
        adapter.kill("SIGKILL");
      };

      if (overallTimeoutMs) {
        logExecRuntimeLifecycle("supervisor-overall-timeout-start", {
          runId,
          sessionId: input.sessionId,
          pid: adapter.pid,
          command,
          cwd: input.cwd,
          timeoutMs: overallTimeoutMs,
          timedOut: false,
        });
        timeoutTimer = setTimeout(() => {
          logExecRuntimeLifecycle("supervisor-overall-timeout-fired", {
            runId,
            sessionId: input.sessionId,
            pid: adapter.pid,
            command,
            cwd: input.cwd,
            timeoutMs: overallTimeoutMs,
            reason: "overall-timeout",
            timedOut: true,
          });
          requestCancel("overall-timeout");
        }, overallTimeoutMs);
      }
      if (noOutputTimeoutMs) {
        logExecRuntimeLifecycle("supervisor-no-output-timeout-start", {
          runId,
          sessionId: input.sessionId,
          pid: adapter.pid,
          command,
          cwd: input.cwd,
          noOutputTimeoutMs,
          timedOut: false,
        });
        noOutputTimer = setTimeout(() => {
          logExecRuntimeLifecycle("supervisor-no-output-timeout-fired", {
            runId,
            sessionId: input.sessionId,
            pid: adapter.pid,
            command,
            cwd: input.cwd,
            noOutputTimeoutMs,
            reason: "no-output-timeout",
            timedOut: true,
          });
          requestCancel("no-output-timeout");
        }, noOutputTimeoutMs);
      }

      adapter.onStdout((chunk) => {
        if (captureOutput) {
          stdout += chunk;
        }
        input.onStdout?.(chunk);
        touchOutput();
      });
      adapter.onStderr((chunk) => {
        if (captureOutput) {
          stderr += chunk;
        }
        input.onStderr?.(chunk);
        touchOutput();
      });

      const waitPromise = (async (): Promise<RunExit> => {
        const result = await adapter.wait();
        if (settled) {
          return {
            reason: forcedReason ?? "exit",
            exitCode: result.code,
            exitSignal: result.signal,
            durationMs: Date.now() - startedAtMs,
            stdout,
            stderr,
            timedOut: isTimeoutReason(forcedReason ?? "exit"),
            noOutputTimedOut: forcedReason === "no-output-timeout",
          };
        }
        settled = true;
        clearTimers();
        adapter.dispose();
        active.delete(runId);

        const reason: TerminationReason =
          forcedReason ?? (result.signal != null ? ("signal" as const) : ("exit" as const));
        const exit: RunExit = {
          reason,
          exitCode: result.code,
          exitSignal: result.signal,
          durationMs: Date.now() - startedAtMs,
          stdout,
          stderr,
          timedOut: isTimeoutReason(forcedReason ?? reason),
          noOutputTimedOut: forcedReason === "no-output-timeout",
        };
        registry.finalize(runId, {
          reason: exit.reason,
          exitCode: exit.exitCode,
          exitSignal: exit.exitSignal,
        });
        logExecRuntimeLifecycle("supervisor-exit", {
          runId,
          sessionId: input.sessionId,
          pid: adapter.pid,
          command,
          cwd: input.cwd,
          timeoutMs: overallTimeoutMs,
          noOutputTimeoutMs,
          reason: exit.reason,
          exitCode: exit.exitCode,
          exitSignal: exit.exitSignal,
          timedOut: exit.timedOut,
          noOutputTimedOut: exit.noOutputTimedOut,
        });
        return exit;
      })().catch((err) => {
        if (!settled) {
          settled = true;
          clearTimers();
          active.delete(runId);
          adapter.dispose();
          registry.finalize(runId, {
            reason: "spawn-error",
            exitCode: null,
            exitSignal: null,
          });
          logExecRuntimeLifecycle("supervisor-wait-error", {
            runId,
            sessionId: input.sessionId,
            pid: adapter.pid,
            command,
            cwd: input.cwd,
            reason: String(err),
            exitCode: null,
            exitSignal: null,
            timedOut: false,
          });
        }
        throw err;
      });

      const managedRun: ManagedRun = {
        runId,
        pid: adapter.pid,
        startedAtMs,
        stdin: adapter.stdin,
        wait: async () => await waitPromise,
        cancel: (reason = "manual-cancel") => {
          logExecRuntimeLifecycle("supervisor-managed-run-cancel", {
            runId,
            sessionId: input.sessionId,
            pid: adapter.pid,
            command,
            cwd: input.cwd,
            reason,
            timedOut: isTimeoutReason(reason),
            action: "cancel",
          });
          requestCancel(reason);
        },
      };

      active.set(runId, {
        run: managedRun,
        scopeKey,
        sessionId: input.sessionId,
        backendId: input.backendId,
        command,
        cwd: input.cwd,
        timeoutMs: overallTimeoutMs,
        noOutputTimeoutMs,
      });
      return managedRun;
    } catch (err) {
      registry.finalize(runId, {
        reason: "spawn-error",
        exitCode: null,
        exitSignal: null,
      });
      logExecRuntimeLifecycle("supervisor-spawn-error", {
        runId,
        sessionId: input.sessionId,
        backendId: input.backendId,
        command,
        cwd: input.cwd,
        timeoutMs: overallTimeoutMs,
        noOutputTimeoutMs,
        mode: input.mode,
        reason: String(err),
        exitCode: null,
        exitSignal: null,
        timedOut: false,
      });
      const { warnProcessSupervisorSpawnFailure } = await import("./supervisor-log.runtime.js");
      warnProcessSupervisorSpawnFailure(`spawn failed: runId=${runId} reason=${String(err)}`);
      throw err;
    }
  };

  return {
    spawn,
    cancel,
    cancelScope,
    reconcileOrphans: async () => {
      // Deliberate no-op: this supervisor uses in-memory ownership only.
      // Active runs are not recovered after process restart in the current model.
    },
    getRecord: (runId: string) => registry.get(runId),
  };
}
