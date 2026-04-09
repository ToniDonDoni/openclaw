import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

type RegisteredCommand = {
  handler: (ctx: Record<string, unknown>) => Promise<{ text?: string }>;
};

describe("self-check-gate plugin", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("arms a session through the registered command and keeps hook logging working", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const loadSessionStore = vi.fn(async () => ({}));
    const saveSessionStore = vi.fn(async () => {});
    const resolveStorePath = vi.fn(() => "/tmp/self-check-gate-store.json");
    const resolveSessionFilePath = vi.fn(() => "/tmp/self-check-gate-session.json");
    const runEmbeddedPiAgent = vi.fn(async () => {});

    const api = createTestPluginApi({
      id: "self-check-gate",
      name: "Self Check Gate",
      source: "test",
      config: {
        agents: {
          list: [{ id: "agent-main" }],
        },
        session: {
          store: "/tmp/self-check-gate-session-store.json",
        },
      } as OpenClawPluginApi["config"],
      runtime: {
        agent: {
          session: {
            resolveStorePath,
            loadSessionStore,
            saveSessionStore,
            resolveSessionFilePath,
          },
          runEmbeddedPiAgent,
        },
      } as unknown as OpenClawPluginApi["runtime"],
      logger,
      registerCommand: (command) => {
        commands.set(command.name, command as RegisteredCommand);
      },
      on: (hookName, handler) => {
        hooks.set(hookName, handler as (event: unknown, ctx: unknown) => Promise<unknown>);
      },
    });

    await plugin.register(api);

    const command = commands.get("selfcheck");
    expect(command).toBeDefined();
    expect(hooks.get("before_tool_call")).toBeTypeOf("function");
    expect(hooks.get("message_sending")).toBeTypeOf("function");

    const armResult = await command?.handler({
      args: "on",
      channel: "telegram",
      channelId: "telegram",
      commandBody: "/selfcheck on",
      config: api.config,
      isAuthorizedSender: true,
      requestConversationBinding: async () => ({
        status: "error",
        message: "unsupported in this test",
      }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
      sessionKey: "agent-main:session-1",
      sessionId: "session-1",
      from: "from",
      to: "to",
      accountId: "account-1",
      messageThreadId: "thread-1",
    });

    expect(armResult).toEqual({
      text: "Self-check gate enabled for this session (agent-main:session-1).",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: ENTER armCurrentSession"),
    );
    expect(resolveStorePath).toHaveBeenCalledTimes(1);
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/self-check-gate-store.json", {
      skipCache: true,
    });
    expect(saveSessionStore).toHaveBeenCalledWith(
      "/tmp/self-check-gate-store.json",
      expect.objectContaining({
        "agent-main:session-1": expect.objectContaining({
          sessionId: "session-1",
          channel: "telegram",
          lastChannel: "telegram",
          accountId: "account-1",
          lastAccountId: "account-1",
          lastFrom: "from",
          lastTo: "to",
          lastThreadId: "thread-1",
          selfCheckGate: expect.objectContaining({
            armed: true,
            phase: "work",
          }),
        }),
      }),
    );

    const beforeToolCall = hooks.get("before_tool_call");
    const hookResult = await beforeToolCall?.(
      { toolName: "writeFile", params: { path: "draft.md" } },
      { sessionKey: "agent-main:session-1", sessionId: "session-1" },
    );

    expect(hookResult).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: before_tool_call enter"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: ENTER findGateBindingForTool"),
    );
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("reuses armed session state for the next relevant outbound after /selfcheck on", async () => {
    vi.useFakeTimers();
    const commands = new Map<string, RegisteredCommand>();
    const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    let store: Record<string, unknown> = {
      "agent-main:session-1": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        modelProvider: "openai-codex",
        model: "gpt-5.4",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "user",
      },
    };
    const loadSessionStore = vi.fn(async () => store);
    const saveSessionStore = vi.fn(async (_path: string, nextStore: Record<string, unknown>) => {
      store = { ...nextStore };
    });
    const resolveStorePath = vi.fn(() => "/tmp/self-check-gate-store.json");
    const resolveSessionFilePath = vi.fn(() => "/tmp/self-check-gate-session.json");
    const runEmbeddedPiAgent = vi.fn(async () => {});

    const api = createTestPluginApi({
      id: "self-check-gate",
      name: "Self Check Gate",
      source: "test",
      config: {
        agents: {
          list: [{ id: "agent-main" }],
        },
        session: {
          store: "/tmp/self-check-gate-session-store.json",
        },
      } as OpenClawPluginApi["config"],
      runtime: {
        agent: {
          session: {
            resolveStorePath,
            loadSessionStore,
            saveSessionStore,
            resolveSessionFilePath,
          },
          runEmbeddedPiAgent,
        },
      } as unknown as OpenClawPluginApi["runtime"],
      logger,
      registerCommand: (command) => {
        commands.set(command.name, command as RegisteredCommand);
      },
      on: (hookName, handler) => {
        hooks.set(hookName, handler as (event: unknown, ctx: unknown) => Promise<unknown>);
      },
    });

    await plugin.register(api);

    const command = commands.get("selfcheck");
    const messageSending = hooks.get("message_sending");

    await command?.handler({
      args: "on",
      channel: "telegram",
      channelId: "telegram",
      commandBody: "/selfcheck on",
      config: api.config,
      isAuthorizedSender: true,
      requestConversationBinding: async () => ({
        status: "error",
        message: "unsupported in this test",
      }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
      sessionKey: "agent-main:session-1",
      sessionId: "session-1",
      from: "telegram:1076875102",
      to: "telegram:1076875102",
      accountId: "default",
      messageThreadId: "thread-1",
    });

    const armAckResult = await messageSending?.(
      {
        content: "Self-check gate enabled for this session (agent-main:session-1).",
        to: "1076875102",
      },
      {
        channelId: "telegram",
        accountId: "default",
        conversationId: "1076875102",
      },
    );

    const result = await messageSending?.(
      {
        content: "final answer",
        to: "1076875102",
      },
      {
        channelId: "telegram",
        accountId: "default",
        conversationId: "1076875102",
      },
    );

    expect(armAckResult).toBeUndefined();
    expect(result).toEqual({ cancel: true });
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent-main:session-1",
        agentId: "agent-main",
        provider: "openai-codex",
        model: "gpt-5.4",
        authProfileId: "openai-codex:default",
        authProfileIdSource: "user",
      }),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("message_sending allow reason=no_armed_binding"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("message_sending allow reason=arm_confirmation"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "self-check-gate: ENTER resolveTargetSessionBinding channelId=telegram",
      ),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "self-check-gate: resolveTargetSessionBinding scan_store agentId=agent-main",
      ),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "self-check-gate: resolveTargetSessionBinding candidate_best agentId=agent-main",
      ),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: resolveTargetSessionBinding compare_conversations"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: resolveTargetSessionBinding result matched=true"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("message_sending binding sessionKey=agent-main:session-1"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("runtimeProvider=openai-codex"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("runtimeModel=gpt-5.4"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("message_sending phase_transition sessionKey=agent-main:session-1"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: scheduleSelfCheckFollowup delayed_launch"),
    );
  });

  it("logs lookup diagnostics when no armed session matches the outbound conversation", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const store = {
      "agent-main:session-1": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        channel: "telegram",
        lastChannel: "telegram",
        accountId: "default",
        lastAccountId: "default",
        lastFrom: "telegram-user-1",
        lastTo: "telegram:999999",
        selfCheckGate: {
          armed: true,
          phase: "work",
          attempts: 0,
          sameHashCount: 0,
          updatedAtMs: Date.now(),
        },
      },
    };
    const loadSessionStore = vi.fn(async () => store);
    const saveSessionStore = vi.fn(async () => {});
    const resolveStorePath = vi.fn(() => "/tmp/self-check-gate-store.json");
    const resolveSessionFilePath = vi.fn(() => "/tmp/self-check-gate-session.json");
    const runEmbeddedPiAgent = vi.fn(async () => {});

    const api = createTestPluginApi({
      id: "self-check-gate",
      name: "Self Check Gate",
      source: "test",
      config: {
        agents: {
          list: [{ id: "agent-main" }],
        },
        session: {
          store: "/tmp/self-check-gate-session-store.json",
        },
      } as OpenClawPluginApi["config"],
      runtime: {
        agent: {
          session: {
            resolveStorePath,
            loadSessionStore,
            saveSessionStore,
            resolveSessionFilePath,
          },
          runEmbeddedPiAgent,
        },
      } as unknown as OpenClawPluginApi["runtime"],
      logger,
      registerCommand: (command) => {
        commands.set(command.name, command as RegisteredCommand);
      },
      on: (hookName, handler) => {
        hooks.set(hookName, handler as (event: unknown, ctx: unknown) => Promise<unknown>);
      },
    });

    await plugin.register(api);

    const messageSending = hooks.get("message_sending");
    const result = await messageSending?.(
      {
        content: "final answer",
        to: "1076875102",
      },
      {
        channelId: "telegram",
        accountId: "default",
        conversationId: "1076875102",
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "self-check-gate: ENTER resolveTargetSessionBinding channelId=telegram",
      ),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: resolveTargetSessionBinding inspect_entry"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("reason=conversation_mismatch"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: resolveTargetSessionBinding result matched=false"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-check-gate: message_sending allow reason=no_armed_binding"),
    );
  });
});
