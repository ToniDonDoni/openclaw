import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { killProcessTree } from "../../kill-tree.js";
import { spawnWithFallback } from "../../spawn-utils.js";
import { resolveWindowsCommandShim } from "../../windows-command.js";
import {
  type ExecLifecycleFields,
  logExecRuntimeLifecycle,
} from "../lifecycle-log.runtime.js";
import type { ManagedRunStdin, SpawnProcessAdapter } from "../types.js";
import { toStringEnv } from "./env.js";

const FORCE_KILL_WAIT_FALLBACK_MS = 4000;
const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 250;

function resolveCommand(command: string): string {
  return resolveWindowsCommandShim({
    command,
    cmdCommands: ["npm", "pnpm", "yarn", "npx"],
  });
}

export type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;

function isServiceManagedRuntime(): boolean {
  return Boolean(process.env.OPENCLAW_SERVICE_MARKER?.trim());
}

export async function createChildAdapter(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
  logContext?: ExecLifecycleFields;
}): Promise<ChildAdapter> {
  const resolvedArgv = [...params.argv];
  resolvedArgv[0] = resolveCommand(resolvedArgv[0] ?? "");

  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  // In service-managed mode keep children attached so systemd/launchd can
  // stop the full process tree reliably. Outside service mode preserve the
  // existing POSIX detached behavior.
  const useDetached = process.platform !== "win32" && !isServiceManagedRuntime();

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  };
  if (stdinMode === "inherit") {
    options.stdio = ["inherit", "pipe", "pipe"];
  } else {
    options.stdio = ["pipe", "pipe", "pipe"];
  }

  const spawned = await spawnWithFallback({
    argv: resolvedArgv,
    options,
    fallbacks: useDetached
      ? [
          {
            label: "no-detach",
            options: { detached: false },
          },
        ]
      : [],
  });

  const child = spawned.child as ChildProcessWithoutNullStreams;
  logExecRuntimeLifecycle("adapter-child-started", {
    ...params.logContext,
    pid: child.pid ?? null,
    command: resolvedArgv.join(" "),
    cwd: params.cwd,
    detached: useDetached,
    stdinMode,
    timedOut: false,
  });
  if (child.stdin) {
    if (params.input !== undefined) {
      child.stdin.write(params.input);
      child.stdin.end();
    } else if (stdinMode === "pipe-closed") {
      child.stdin.end();
    }
  }

  const stdin: ManagedRunStdin | undefined = child.stdin
    ? {
        destroyed: false,
        write: (data: string, cb?: (err?: Error | null) => void) => {
          try {
            child.stdin.write(data, cb);
          } catch (err) {
            cb?.(err as Error);
          }
        },
        end: () => {
          try {
            child.stdin.end();
          } catch {
            // ignore close errors
          }
        },
        destroy: () => {
          try {
            child.stdin.destroy();
          } catch {
            // ignore destroy errors
          }
        },
      }
    : undefined;

  const onStdout = (listener: (chunk: string) => void) => {
    child.stdout.on("data", (chunk) => {
      listener(chunk.toString());
    });
  };

  const onStderr = (listener: (chunk: string) => void) => {
    child.stderr.on("data", (chunk) => {
      listener(chunk.toString());
    });
  };

  let waitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let waitError: unknown;
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  let rejectWait: ((reason?: unknown) => void) | null = null;
  let waitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let forceKillWaitFallbackTimer: NodeJS.Timeout | null = null;
  let childExitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let windowsCloseFallbackTimer: NodeJS.Timeout | null = null;
  let stdoutDrained = child.stdout == null;
  let stderrDrained = child.stderr == null;

  const clearForceKillWaitFallback = () => {
    if (!forceKillWaitFallbackTimer) {
      return;
    }
    clearTimeout(forceKillWaitFallbackTimer);
    forceKillWaitFallbackTimer = null;
  };

  const clearWindowsCloseFallbackTimer = () => {
    if (!windowsCloseFallbackTimer) {
      return;
    }
    clearTimeout(windowsCloseFallbackTimer);
    windowsCloseFallbackTimer = null;
  };

  const settleWait = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (waitResult || waitError !== undefined) {
      return;
    }
    clearForceKillWaitFallback();
    clearWindowsCloseFallbackTimer();
    waitResult = value;
    logExecRuntimeLifecycle("adapter-child-wait-settled", {
      ...params.logContext,
      pid: child.pid ?? null,
      command: resolvedArgv.join(" "),
      cwd: params.cwd,
      exitCode: value.code,
      exitSignal: value.signal,
      timedOut: false,
    });
    if (resolveWait) {
      const resolve = resolveWait;
      resolveWait = null;
      rejectWait = null;
      resolve(value);
    }
  };

  const rejectPendingWait = (error: unknown) => {
    if (waitResult || waitError !== undefined) {
      return;
    }
    clearForceKillWaitFallback();
    clearWindowsCloseFallbackTimer();
    waitError = error;
    logExecRuntimeLifecycle("adapter-child-wait-error", {
      ...params.logContext,
      pid: child.pid ?? null,
      command: resolvedArgv.join(" "),
      cwd: params.cwd,
      reason: String(error),
      timedOut: false,
    });
    if (rejectWait) {
      const reject = rejectWait;
      resolveWait = null;
      rejectWait = null;
      reject(error);
    }
  };

  const scheduleForceKillWaitFallback = (signal: NodeJS.Signals) => {
    clearForceKillWaitFallback();
    // Some Windows child processes never emit `close` after a hard kill.
    logExecRuntimeLifecycle("adapter-child-kill-fallback-start", {
      ...params.logContext,
      pid: child.pid ?? null,
      command: resolvedArgv.join(" "),
      cwd: params.cwd,
      signal,
      action: "fallback-settle",
    });
    forceKillWaitFallbackTimer = setTimeout(() => {
      logExecRuntimeLifecycle("adapter-child-kill-fallback-fired", {
        ...params.logContext,
        pid: child.pid ?? null,
        command: resolvedArgv.join(" "),
        cwd: params.cwd,
        signal,
        action: "fallback-settle",
      });
      settleWait({ code: null, signal });
    }, FORCE_KILL_WAIT_FALLBACK_MS);
    forceKillWaitFallbackTimer.unref?.();
  };

  const resolveObservedExitState = (fallback: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => {
    if (childExitState != null) {
      return childExitState;
    }
    return {
      code: child.exitCode ?? fallback.code,
      signal: child.signalCode ?? fallback.signal,
    };
  };

  const maybeSettleAfterWindowsExit = () => {
    if (
      process.platform !== "win32" ||
      childExitState == null ||
      !stdoutDrained ||
      !stderrDrained
    ) {
      return;
    }
    settleWait(resolveObservedExitState(childExitState));
  };

  const scheduleWindowsCloseFallback = () => {
    if (process.platform !== "win32") {
      return;
    }
    clearWindowsCloseFallbackTimer();
    windowsCloseFallbackTimer = setTimeout(() => {
      maybeSettleAfterWindowsExit();
    }, WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS);
    windowsCloseFallbackTimer.unref?.();
  };

  child.stdout?.once("end", () => {
    stdoutDrained = true;
    maybeSettleAfterWindowsExit();
  });
  child.stdout?.once("close", () => {
    stdoutDrained = true;
    maybeSettleAfterWindowsExit();
  });
  child.stderr?.once("end", () => {
    stderrDrained = true;
    maybeSettleAfterWindowsExit();
  });
  child.stderr?.once("close", () => {
    stderrDrained = true;
    maybeSettleAfterWindowsExit();
  });

  child.once("error", (error) => {
    logExecRuntimeLifecycle("adapter-child-error", {
      ...params.logContext,
      pid: child.pid ?? null,
      command: resolvedArgv.join(" "),
      cwd: params.cwd,
      reason: String(error),
      timedOut: false,
    });
    rejectPendingWait(error);
  });
  child.once("exit", (code, signal) => {
    childExitState = { code, signal };
    logExecRuntimeLifecycle("adapter-child-exit-event", {
      ...params.logContext,
      pid: child.pid ?? null,
      command: resolvedArgv.join(" "),
      cwd: params.cwd,
      exitCode: code,
      exitSignal: signal,
      timedOut: false,
    });
    scheduleWindowsCloseFallback();
  });
  child.once("close", (code, signal) => {
    logExecRuntimeLifecycle("adapter-child-close-event", {
      ...params.logContext,
      pid: child.pid ?? null,
      command: resolvedArgv.join(" "),
      cwd: params.cwd,
      exitCode: code,
      exitSignal: signal,
      timedOut: false,
    });
    settleWait(resolveObservedExitState({ code, signal }));
  });

  const wait = async () => {
    if (waitResult) {
      return waitResult;
    }
    if (waitError !== undefined) {
      throw waitError;
    }
    if (!waitPromise) {
      waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          resolveWait = resolve;
          rejectWait = reject;
          if (waitResult) {
            const settled = waitResult;
            resolveWait = null;
            rejectWait = null;
            resolve(settled);
            return;
          }
          if (waitError !== undefined) {
            const error = waitError;
            resolveWait = null;
            rejectWait = null;
            reject(error);
          }
        },
      );
    }
    return waitPromise;
  };

  const kill = (signal?: NodeJS.Signals) => {
    const pid = child.pid ?? undefined;
    logExecRuntimeLifecycle("adapter-child-kill", {
      ...params.logContext,
      pid: pid ?? null,
      command: resolvedArgv.join(" "),
      cwd: params.cwd,
      signal: signal ?? "SIGKILL",
      action: "kill",
    });
    if (signal === undefined || signal === "SIGKILL") {
      if (pid) {
        logExecRuntimeLifecycle("adapter-child-kill-tree", {
          ...params.logContext,
          pid,
          command: resolvedArgv.join(" "),
          cwd: params.cwd,
          signal: "SIGKILL",
          action: "killProcessTree",
        });
        killProcessTree(pid);
      }
      try {
        logExecRuntimeLifecycle("adapter-child-kill-direct", {
          ...params.logContext,
          pid: pid ?? null,
          command: resolvedArgv.join(" "),
          cwd: params.cwd,
          signal: "SIGKILL",
          action: "child.kill",
        });
        child.kill("SIGKILL");
      } catch {
        // ignore kill errors
      }
      scheduleForceKillWaitFallback("SIGKILL");
      return;
    }
    try {
      logExecRuntimeLifecycle("adapter-child-kill-direct", {
        ...params.logContext,
        pid: pid ?? null,
        command: resolvedArgv.join(" "),
        cwd: params.cwd,
        signal,
        action: "child.kill",
      });
      child.kill(signal);
    } catch {
      // ignore kill errors for non-kill signals
    }
  };

  const dispose = () => {
    clearForceKillWaitFallback();
    clearWindowsCloseFallbackTimer();
    child.removeAllListeners();
  };

  return {
    pid: child.pid ?? undefined,
    stdin,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
