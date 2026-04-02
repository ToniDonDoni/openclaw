import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error runtime bridge is intentionally shipped as .mjs
import { OpenCodeServeAgent, cfg } from "./opencode-serve-agent.mjs";

function newReq(cwd = "/tmp"): NewSessionRequest {
  return {
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as NewSessionRequest;
}

function loadReq(sessionId: string, cwd = "/tmp"): LoadSessionRequest {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as LoadSessionRequest;
}

function promptReq(sessionId: string, text: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: {},
  } as unknown as PromptRequest;
}

describe("cfg", () => {
  it("falls back to the expected local defaults", () => {
    expect(cfg({})).toEqual({
      url: "http://127.0.0.1:4096",
      provider: "opencode",
      model: "mimo-v2-pro-free",
    });
  });
});

describe("OpenCodeServeAgent", () => {
  it("creates sessions against opencode serve and returns config options", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ id: "ses_123" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const conn = {
      sessionUpdate: vi.fn(async () => {}),
    };
    const agent = new OpenCodeServeAgent(conn, {
      url: "http://127.0.0.1:4096",
      provider: "opencode",
      model: "mimo-v2-pro-free",
    });

    const res = await agent.newSession(newReq("/repo"));

    expect(res.sessionId).toBe("ses_123");
    expect(res.configOptions).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/session?directory=%2Frepo",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });

  it("forwards prompt text and emits thought and message chunks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: "ses_123" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            info: {
              modelID: "mimo-v2-pro-free",
              providerID: "opencode",
            },
            parts: [
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "hello" },
            ],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const sessionUpdate = vi.fn(async () => {});
    const agent = new OpenCodeServeAgent(
      {
        sessionUpdate,
      },
      {
        url: "http://127.0.0.1:4096",
        provider: "opencode",
        model: "mimo-v2-pro-free",
      },
    );

    await agent.newSession(newReq("/repo"));
    const res = await agent.prompt(promptReq("ses_123", "Привет"));

    expect(res).toEqual({ stopReason: "end_turn" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:4096/session/ses_123/message",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: {
            providerID: "opencode",
            modelID: "mimo-v2-pro-free",
          },
          parts: [{ type: "text", text: "Привет" }],
        }),
      }),
    );
    expect(sessionUpdate).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_123",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
    });
    expect(sessionUpdate).toHaveBeenNthCalledWith(2, {
      sessionId: "ses_123",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    vi.unstubAllGlobals();
  });

  it("keeps the adapter model binding stable across reloads", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ id: "ses_123" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new OpenCodeServeAgent(
      {
        sessionUpdate: vi.fn(async () => {}),
      },
      {
        url: "http://127.0.0.1:4096",
        provider: "opencode",
        model: "mimo-v2-pro-free",
      },
    );

    await agent.newSession(newReq("/repo"));
    const res = await agent.loadSession(loadReq("ses_123", "/repo"));

    expect(res.configOptions).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("rejects unsupported config updates explicitly", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ id: "ses_123" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new OpenCodeServeAgent(
      {
        sessionUpdate: vi.fn(async () => {}),
      },
      {
        url: "http://127.0.0.1:4096",
        provider: "opencode",
        model: "mimo-v2-pro-free",
      },
    );

    await agent.newSession(newReq("/repo"));
    await expect(
      agent.setSessionConfigOption({
        sessionId: "ses_123",
        configId: "model_id",
        value: "other",
        _meta: {},
      }),
    ).rejects.toThrow("Unsupported config option: model_id");
    vi.unstubAllGlobals();
  });
});
