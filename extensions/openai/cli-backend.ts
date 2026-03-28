import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

export function buildOpenAICodexCliBackend(): CliBackendPlugin {
  return {
    id: "codex-cli",
    config: {
      command: "codex",
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ],
      resumeArgs: [
        "exec",
        "resume",
        "{sessionId}",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ],
      output: "jsonl",
      resumeOutput: "text",
      input: "arg",
      modelArg: "--model",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
      imageArg: "--image",
      imageMode: "repeat",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
    normalizeConfig: (config) => ({
      ...config,
      // Codex `exec --json` emits a JSONL event stream, not a single JSON object.
      // Force the parser mode here so a user config override cannot regress thread
      // persistence or leak raw event-stream chunks to chat surfaces.
      output: "jsonl",
      // `codex exec resume` currently returns plain text, not JSON.
      resumeOutput: "text",
      sessionIdFields: ["thread_id"],
    }),
  };
}
