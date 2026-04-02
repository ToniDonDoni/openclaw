#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const DEFAULT_URL = "http://127.0.0.1:4096";
const DEFAULT_PROVIDER = "opencode";
const DEFAULT_MODEL = "mimo-v2-pro-free";
const DEFAULT_MODE = "default";
function arg(name) {
  const ix = process.argv.indexOf(name);
  if (ix < 0) {
    return "";
  }
  return String(process.argv[ix + 1] || "");
}

function text(prompt) {
  return prompt
    .filter(
      (part) =>
        part && typeof part === "object" && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function msg(err, fallback) {
  if (!err || typeof err !== "object") {
    return fallback;
  }
  if (typeof err.message === "string" && err.message.trim()) {
    return err.message;
  }
  if (
    err.data &&
    typeof err.data === "object" &&
    typeof err.data.message === "string" &&
    err.data.message.trim()
  ) {
    return err.data.message;
  }
  return fallback;
}

async function body(res) {
  const raw = await res.text();
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw);
}

export function cfg(opts = {}) {
  return {
    url: opts.url || arg("--url") || process.env.OPENCODE_SERVER_URL || DEFAULT_URL,
    provider:
      opts.provider || arg("--provider") || process.env.OPENCODE_PROVIDER || DEFAULT_PROVIDER,
    model: opts.model || arg("--model") || process.env.OPENCODE_MODEL || DEFAULT_MODEL,
  };
}

export async function call(url, init) {
  const res = await fetch(url, init);
  const data = await body(res);
  if (res.ok) {
    return data;
  }
  throw new Error(
    msg(data?.error || data?.info?.error || data, `OpenCode request failed with ${res.status}`),
  );
}

function config(state) {
  return [];
}

function modes() {
  return {
    currentModeId: DEFAULT_MODE,
    availableModes: [
      {
        id: DEFAULT_MODE,
        title: "Default",
      },
    ],
  };
}

export class OpenCodeServeAgent {
  constructor(conn, opts = {}) {
    this.conn = conn;
    this.base = cfg(opts);
    this.sessions = new Map();
    this.runs = new Map();
  }

  start() {}

  state(id, cwd) {
    const prev = this.sessions.get(id);
    const next = {
      cwd: cwd || prev?.cwd || process.cwd(),
    };
    this.sessions.set(id, next);
    return next;
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
        },
      },
      agentInfo: {
        name: "opencode-serve",
        version: "0.1.0",
      },
      authMethods: [],
    };
  }

  async newSession(params) {
    const data = await call(
      `${this.base.url}/session?directory=${encodeURIComponent(params.cwd || process.cwd())}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    const state = this.state(data.id, params.cwd);
    return {
      sessionId: data.id,
      configOptions: config(state),
      modes: modes(),
    };
  }

  async loadSession(params) {
    const state = this.state(params.sessionId, params.cwd);
    return {
      configOptions: config(state),
      modes: modes(),
    };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async setSessionConfigOption(params) {
    this.state(params.sessionId);
    throw new Error(`Unsupported config option: ${params.configId}`);
  }

  async prompt(params) {
    const state = this.state(params.sessionId);
    const ctl = new AbortController();
    this.runs.set(params.sessionId, ctl);
    const input = text(params.prompt || []);
    let data;
    try {
      data = await call(
        `${this.base.url}/session/${encodeURIComponent(params.sessionId)}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: {
              providerID: this.base.provider,
              modelID: this.base.model,
            },
            parts: [{ type: "text", text: input }],
          }),
          signal: ctl.signal,
        },
      );
    } catch (err) {
      this.runs.delete(params.sessionId);
      if (ctl.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw err;
    }
    this.runs.delete(params.sessionId);
    if (data?.info?.error) {
      throw new Error(msg(data.info.error, "OpenCode prompt failed"));
    }
    for (const part of data?.parts || []) {
      if (part.type === "reasoning" && typeof part.text === "string" && part.text) {
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: part.text },
          },
        });
        continue;
      }
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: part.text },
          },
        });
      }
    }
    return { stopReason: "end_turn" };
  }

  async cancel(params) {
    this.runs.get(params.sessionId)?.abort();
    this.runs.delete(params.sessionId);
  }

  async unstable_listSessions() {
    return {
      sessions: [],
      nextCursor: null,
    };
  }
}

export async function serve(opts = {}) {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = ndJsonStream(input, output);
  new AgentSideConnection((conn) => {
    const agent = new OpenCodeServeAgent(conn, opts);
    agent.start();
    return agent;
  }, stream);
  return await new Promise(() => {});
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  await serve();
}
