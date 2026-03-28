import { describe, expect, it } from "vitest";
import { parseCliJsonl, parseCliOutput } from "./cli-output.js";

describe("parseCliJsonl", () => {
  it("parses Claude stream-json result events", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-123" }),
        JSON.stringify({
          type: "result",
          session_id: "session-123",
          result: "Claude says hello",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "Claude says hello",
      sessionId: "session-123",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("preserves Claude session metadata even when the final result text is empty", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-456" }),
        JSON.stringify({
          type: "result",
          session_id: "session-456",
          result: "   ",
          usage: {
            input_tokens: 18,
            output_tokens: 0,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-456",
      usage: {
        input: 18,
        output: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("parses Codex message items from item.content arrays and keeps thread_id", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Codex says hello" }],
          },
        }),
      ].join("\n"),
      {
        command: "codex",
        output: "jsonl",
        sessionIdFields: ["thread_id"],
      },
      "codex-cli",
    );

    expect(result).toEqual({
      text: "Codex says hello",
      sessionId: "thread-123",
      usage: undefined,
    });
  });

  it("ignores Codex user and partial assistant message items when extracting final output", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-321" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "User prompt" }],
          },
        }),
        JSON.stringify({
          type: "item.delta",
          item: {
            type: "message_delta",
            role: "assistant",
            content: [{ type: "output_text", text: "Partial answer" }],
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Final answer" }],
          },
        }),
      ].join("\n"),
      {
        command: "codex",
        output: "jsonl",
        sessionIdFields: ["thread_id"],
      },
      "codex-cli",
    );

    expect(result).toEqual({
      text: "Final answer",
      sessionId: "thread-321",
      usage: undefined,
    });
  });

  it("parses final Codex agent_message items while still ignoring non-final message noise", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-654" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "User prompt" }],
          },
        }),
        JSON.stringify({
          type: "item.delta",
          item: {
            type: "message_delta",
            role: "assistant",
            content: [{ type: "output_text", text: "Partial answer" }],
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_0",
            type: "agent_message",
            text: "Final answer",
          },
        }),
      ].join("\n"),
      {
        command: "codex",
        output: "jsonl",
        sessionIdFields: ["thread_id"],
      },
      "codex-cli",
    );

    expect(result).toEqual({
      text: "Final answer",
      sessionId: "thread-654",
      usage: undefined,
    });
  });

  it("preserves Codex thread metadata without leaking raw JSONL when no message text exists", () => {
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-789" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "internal summary" }],
        },
      }),
    ].join("\n");

    expect(
      parseCliJsonl(
        raw,
        {
          command: "codex",
          output: "jsonl",
          sessionIdFields: ["thread_id"],
        },
        "codex-cli",
      ),
    ).toEqual({
      text: "",
      sessionId: "thread-789",
      usage: undefined,
    });

    expect(
      parseCliOutput({
        raw,
        backend: {
          command: "codex",
          output: "jsonl",
          sessionIdFields: ["thread_id"],
        },
        providerId: "codex-cli",
        outputMode: "jsonl",
      }),
    ).toEqual({
      text: "",
      sessionId: "thread-789",
      usage: undefined,
    });
  });
});
