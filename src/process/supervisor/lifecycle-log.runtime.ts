import { getLogger } from "../../logging/logger.js";
import { defaultRuntime } from "../../runtime.js";

export const EXEC_RUNTIME_DEBUG_PREFIX = "exec-runtime-debug:";

type LifecycleValue = boolean | number | string | null | undefined;

export type ExecLifecycleFields = Record<string, LifecycleValue>;

function formatLifecycleValue(value: LifecycleValue): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value.replace(/\s+/g, " ").trim());
  }
  return String(value);
}

export function formatExecLifecycleFields(fields: ExecLifecycleFields): string {
  return Object.entries(fields)
    .filter(
      (entry): entry is [string, Exclude<LifecycleValue, undefined>] => entry[1] !== undefined,
    )
    .map(([key, value]) => `${key}=${formatLifecycleValue(value)}`)
    .join(" ");
}

export function logExecRuntimeLifecycle(action: string, fields: ExecLifecycleFields): void {
  const renderedFields = formatExecLifecycleFields(fields);
  const line = renderedFields
    ? `${EXEC_RUNTIME_DEBUG_PREFIX} action=${action} ${renderedFields}`
    : `${EXEC_RUNTIME_DEBUG_PREFIX} action=${action}`;
  defaultRuntime.log?.(line);
  getLogger().info(line);
}
