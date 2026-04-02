import { describe, expect, it } from "vitest";
import {
  createMockRuntimeFixture,
  readMockRuntimeLogEntries,
} from "./test-utils/runtime-fixtures.js";

describe("AcpxRuntime local agents", () => {
  it("routes the local opencode serve bridge through acpx --agent without MCP servers", async () => {
    const { runtime, logPath } = await createMockRuntimeFixture();

    await runtime.ensureSession({
      sessionKey: "agent:opencode-serve:acp:local",
      agent: "opencode-serve",
      mode: "persistent",
    });

    const logs = await readMockRuntimeLogEntries(logPath);
    const ensureArgs = (logs.find((entry) => entry.kind === "ensure")?.args as string[]) ?? [];
    const agentFlagIndex = ensureArgs.indexOf("--agent");
    expect(agentFlagIndex).toBeGreaterThanOrEqual(0);
    expect(ensureArgs[agentFlagIndex + 1]).toContain("opencode-serve-agent.mjs");
    expect(ensureArgs[agentFlagIndex + 1]).not.toContain("mcp-proxy.mjs");
  });

  it("wraps the local opencode serve bridge in the MCP proxy when MCP servers are configured", async () => {
    const { runtime, logPath } = await createMockRuntimeFixture({
      mcpServers: {
        canva: {
          command: "npx",
          args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
          env: {
            CANVA_TOKEN: "secret",
          },
        },
      },
    });

    await runtime.ensureSession({
      sessionKey: "agent:opencode-serve:acp:mcp",
      agent: "opencode-serve",
      mode: "persistent",
    });

    const logs = await readMockRuntimeLogEntries(logPath);
    const ensureArgs = (logs.find((entry) => entry.kind === "ensure")?.args as string[]) ?? [];
    const agentFlagIndex = ensureArgs.indexOf("--agent");
    expect(agentFlagIndex).toBeGreaterThanOrEqual(0);
    const raw = ensureArgs[agentFlagIndex + 1];
    expect(raw).toContain("mcp-proxy.mjs");
    const payloadMatch = raw.match(/--payload\s+([A-Za-z0-9_-]+)/);
    expect(payloadMatch?.[1]).toBeDefined();
    const payload = JSON.parse(
      Buffer.from(String(payloadMatch?.[1]), "base64url").toString("utf8"),
    ) as {
      targetCommand: string;
    };
    expect(payload.targetCommand).toContain("opencode-serve-agent.mjs");
  });
});
