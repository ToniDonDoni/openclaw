type OpenCodeServeAgentOpts = {
  url?: string;
  provider?: string;
  model?: string;
};

type OpenCodeSessionUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

type OpenCodeConn = {
  sessionUpdate(params: OpenCodeSessionUpdate): Promise<void>;
};

type OpenCodeSessionRequest = {
  cwd?: string;
  sessionId?: string;
  mcpServers?: unknown[];
  _meta?: Record<string, unknown>;
};

type OpenCodePromptRequest = {
  sessionId: string;
  prompt?: Array<{ type?: string; text?: string }>;
  _meta?: Record<string, unknown>;
};

type OpenCodeConfigRequest = {
  sessionId: string;
  configId: string;
  value: unknown;
  _meta?: Record<string, unknown>;
};

export function cfg(opts?: OpenCodeServeAgentOpts): {
  url: string;
  provider: string;
  model: string;
};

export function call(url: string, init?: RequestInit): Promise<unknown>;

export class OpenCodeServeAgent {
  constructor(conn: OpenCodeConn, opts?: OpenCodeServeAgentOpts);
  start(): void;
  initialize(): Promise<Record<string, unknown>>;
  newSession(params: OpenCodeSessionRequest): Promise<Record<string, unknown>>;
  loadSession(params: OpenCodeSessionRequest): Promise<Record<string, unknown>>;
  authenticate(): Promise<Record<string, never>>;
  setSessionMode(): Promise<Record<string, never>>;
  setSessionConfigOption(params: OpenCodeConfigRequest): Promise<Record<string, unknown>>;
  prompt(params: OpenCodePromptRequest): Promise<Record<string, unknown>>;
  cancel(params: { sessionId: string }): Promise<void>;
  unstable_listSessions(): Promise<Record<string, unknown>>;
}

export function serve(opts?: OpenCodeServeAgentOpts): Promise<void>;
