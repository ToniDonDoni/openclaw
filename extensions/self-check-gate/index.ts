import crypto from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig, OpenClawPluginApi, PluginCommandContext } from "./api.js";

type SelfCheckPhase = "work" | "self_check" | "finalize";
type SelfCheckVerdictState = "done" | "continue" | "wait_external" | "blocked_external";
type ReleaseKind = "final" | "wait_external" | "blocked_external";

type SelfCheckVerdict = {
  state: SelfCheckVerdictState;
  progressHash: string;
  reason?: string;
  nextAction?: string;
  blockers?: string[];
};

type SelfCheckGateState = {
  armed: boolean;
  phase: SelfCheckPhase;
  attempts: number;
  sameHashCount: number;
  progressHash?: string;
  releaseKind?: ReleaseKind;
  pendingFinal?: string;
  lastVerdict?: SelfCheckVerdictState;
  skipNextContentHash?: string;
  updatedAtMs?: number;
};

type SelfCheckSessionEntry = {
  [key: string]: unknown;
  sessionId: string;
  updatedAt: number;
  modelProvider?: string;
  model?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  channel?: string;
  lastChannel?: string;
  accountId?: string;
  lastAccountId?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastFrom?: string;
  lastTo?: string;
  lastThreadId?: string | number;
  selfCheckGate?: SelfCheckGateState;
};

type SessionStore = Record<string, SelfCheckSessionEntry>;

type SessionBinding = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  entry: SelfCheckSessionEntry;
};

type SessionRuntimeSelection = {
  provider?: string;
  model?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

const TELEGRAM_CHANNEL_ID = "telegram";
const MAX_ATTEMPTS = 6;
const MAX_SAME_HASH = 2;
type SelfCheckLogFn = (message: string, meta?: Record<string, unknown>) => void;

function summarizeStoreKeys(store: SessionStore): string[] {
  return Object.keys(store).toSorted();
}

function formatLogValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatLogValue(item))
      .filter(Boolean)
      .join("|");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function formatLogMeta(meta: Record<string, unknown>): string {
  const parts = Object.entries(meta)
    .map(([key, value]) => {
      const formatted = formatLogValue(value);
      return formatted ? `${key}=${formatted}` : "";
    })
    .filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function normalizeText(value: string | undefined | null): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeTelegramConversationLookupValue(value: string | undefined | null): string {
  const normalized = normalizeText(value);
  return normalized.startsWith(`${TELEGRAM_CHANNEL_ID}:`)
    ? normalized.slice(TELEGRAM_CHANNEL_ID.length + 1)
    : normalized;
}

function resolveSessionRuntimeSelection(entry: SelfCheckSessionEntry): SessionRuntimeSelection {
  const explicitProvider = normalizeText(entry.modelProvider);
  const rawModel = normalizeText(entry.model);
  const authProfileId = normalizeText(entry.authProfileOverride);
  let provider = explicitProvider;
  let model = rawModel;

  if (!provider && rawModel.includes("/")) {
    const slashIndex = rawModel.indexOf("/");
    if (slashIndex > 0 && slashIndex < rawModel.length - 1) {
      provider = rawModel.slice(0, slashIndex);
      model = rawModel.slice(slashIndex + 1);
    }
  }

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(authProfileId ? { authProfileId } : {}),
    ...(authProfileId && entry.authProfileOverrideSource
      ? { authProfileIdSource: entry.authProfileOverrideSource }
      : {}),
  };
}

function getAgentIds(config: OpenClawConfig): string[] {
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  const ids = agents
    .map((agent) => {
      if (!agent || typeof agent !== "object") {
        return "";
      }
      const record = agent as { id?: unknown; default?: unknown };
      return normalizeText(typeof record.id === "string" ? record.id : undefined);
    })
    .filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length > 0) {
    return unique;
  }
  return [resolveAgentIdFromSessionKey("agent:main:main")];
}

function readGateState(entry: SelfCheckSessionEntry | undefined): SelfCheckGateState | undefined {
  const gate = entry?.selfCheckGate;
  if (!gate || typeof gate !== "object") {
    return undefined;
  }
  if (gate.phase !== "work" && gate.phase !== "self_check" && gate.phase !== "finalize") {
    return undefined;
  }
  return {
    armed: gate.armed,
    phase: gate.phase,
    attempts: Number.isFinite(gate.attempts) ? Math.max(0, Math.floor(gate.attempts)) : 0,
    sameHashCount: Number.isFinite(gate.sameHashCount)
      ? Math.max(0, Math.floor(gate.sameHashCount))
      : 0,
    progressHash: normalizeText(gate.progressHash),
    releaseKind:
      gate.releaseKind === "final" ||
      gate.releaseKind === "wait_external" ||
      gate.releaseKind === "blocked_external"
        ? gate.releaseKind
        : undefined,
    pendingFinal: normalizeText(gate.pendingFinal),
    lastVerdict:
      gate.lastVerdict === "done" ||
      gate.lastVerdict === "continue" ||
      gate.lastVerdict === "wait_external" ||
      gate.lastVerdict === "blocked_external"
        ? gate.lastVerdict
        : undefined,
    skipNextContentHash: normalizeText(gate.skipNextContentHash),
    updatedAtMs:
      typeof gate.updatedAtMs === "number" && Number.isFinite(gate.updatedAtMs)
        ? Math.max(0, Math.floor(gate.updatedAtMs))
        : undefined,
  };
}

function writeGateState(entry: SelfCheckSessionEntry, gate: SelfCheckGateState): void {
  entry.selfCheckGate = {
    armed: gate.armed,
    phase: gate.phase,
    attempts: gate.attempts,
    sameHashCount: gate.sameHashCount,
    ...(gate.progressHash ? { progressHash: gate.progressHash } : {}),
    ...(gate.releaseKind ? { releaseKind: gate.releaseKind } : {}),
    ...(gate.pendingFinal ? { pendingFinal: gate.pendingFinal } : {}),
    ...(gate.lastVerdict ? { lastVerdict: gate.lastVerdict } : {}),
    ...(gate.skipNextContentHash ? { skipNextContentHash: gate.skipNextContentHash } : {}),
    updatedAtMs: Date.now(),
  };
}

function clearGateState(entry: SelfCheckSessionEntry): void {
  delete entry.selfCheckGate;
}

function stableHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function formatStateLabel(state: SelfCheckVerdictState): string {
  switch (state) {
    case "done":
      return "approved";
    case "continue":
      return "continue working";
    case "wait_external":
      return "waiting on external dependency";
    case "blocked_external":
      return "blocked by external dependency";
  }
}

function formatSelfCheckPrompt(
  info: SelfCheckLogFn,
  params: {
    sessionKey: string;
    attempts: number;
    sameHashCount: number;
    pendingFinal?: string;
  },
): string {
  info("ENTER formatSelfCheckPrompt", {
    sessionKey: params.sessionKey,
    attempts: params.attempts,
    sameHashCount: params.sameHashCount,
    pendingFinalLength: params.pendingFinal?.length ?? 0,
  });
  return [
    "SELF_CHECK_MODE",
    "Do not answer the user directly.",
    "Use read-only tools only.",
    "Return JSON only with this schema:",
    '{ "state": "done" | "continue" | "wait_external" | "blocked_external", "progressHash": "string", "reason": "string", "nextAction": "string", "blockers": ["string"] }',
    "",
    `sessionKey: ${params.sessionKey}`,
    `attempts: ${params.attempts}`,
    `sameHashCount: ${params.sameHashCount}`,
    "",
    "Check whether the current work is terminal.",
    "If the draft is ready, state must be done.",
    "If more work is required, state must be continue and nextAction must describe the next step.",
    "If you need an external event, state must be wait_external.",
    "If an external dependency blocks completion, state must be blocked_external.",
    "",
    "Draft to evaluate:",
    params.pendingFinal?.trim() || "(empty)",
  ].join("\n");
}

function formatReleasePrompt(
  info: SelfCheckLogFn,
  params: { state: SelfCheckGateState; reason?: string },
): string {
  info("ENTER formatReleasePrompt", {
    phase: params.state.phase,
    releaseKind: params.state.releaseKind,
    reason: params.reason,
  });
  const base =
    params.state.releaseKind === "wait_external"
      ? [
          "SELF_CHECK_RELEASE_MODE",
          "Emit a short user-facing wait status message.",
          `Reason: ${params.reason?.trim() || "external dependency pending"}`,
        ]
      : params.state.releaseKind === "blocked_external"
        ? [
            "SELF_CHECK_RELEASE_MODE",
            "Emit a short user-facing blocker message.",
            `Reason: ${params.reason?.trim() || "external dependency blocked completion"}`,
          ]
        : ["SELF_CHECK_RELEASE_MODE", "Emit the approved final response verbatim."];
  const pendingFinal = params.state.pendingFinal?.trim();
  return pendingFinal
    ? [...base, "", "Approved content:", pendingFinal].join("\n")
    : base.join("\n");
}

function parseVerdict(text: string): SelfCheckVerdict | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/, "")
        .trim()
    : trimmed;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const state = parsed.state;
    const progressHash =
      typeof parsed.progressHash === "string" && parsed.progressHash.trim()
        ? parsed.progressHash.trim()
        : stableHash(candidate);
    if (
      state !== "done" &&
      state !== "continue" &&
      state !== "wait_external" &&
      state !== "blocked_external"
    ) {
      return null;
    }
    return {
      state,
      progressHash,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
      nextAction: typeof parsed.nextAction === "string" ? parsed.nextAction.trim() : undefined,
      blockers: Array.isArray(parsed.blockers)
        ? parsed.blockers.filter((value): value is string => typeof value === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}

function looksReadOnlyTool(toolName: string, params: Record<string, unknown>): boolean {
  const normalized = normalizeText(toolName).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized.startsWith("get") ||
    normalized.startsWith("list") ||
    normalized.startsWith("read") ||
    normalized.startsWith("fetch") ||
    normalized.startsWith("search") ||
    normalized.startsWith("view") ||
    normalized.startsWith("inspect") ||
    normalized.startsWith("status") ||
    normalized.startsWith("probe") ||
    normalized.startsWith("check")
  ) {
    return true;
  }
  if (
    normalized === "exec" ||
    normalized === "bash" ||
    normalized === "write" ||
    normalized === "edit"
  ) {
    return false;
  }
  if (normalized === "session_status") {
    return typeof params.model !== "string" || params.model.trim().length === 0;
  }
  return false;
}

async function loadSessionStore(
  api: OpenClawPluginApi,
  storePath: string,
  info?: SelfCheckLogFn,
): Promise<SessionStore> {
  info?.("ENTER loadSessionStore", { storePath });
  const store = api.runtime.agent.session.loadSessionStore(storePath, { skipCache: true });
  info?.("loadSessionStore loaded", {
    storePath,
    keyCount: Object.keys(store as Record<string, unknown>).length,
    keys: summarizeStoreKeys(store as SessionStore),
  });
  return store as SessionStore;
}

async function saveSessionStore(
  info: SelfCheckLogFn,
  api: OpenClawPluginApi,
  storePath: string,
  store: SessionStore,
): Promise<void> {
  info("ENTER saveSessionStore", {
    storePath,
    keyCount: Object.keys(store).length,
    keys: summarizeStoreKeys(store),
  });
  await api.runtime.agent.session.saveSessionStore(storePath, store as never);
}

async function resolveTargetSessionBinding(
  info: SelfCheckLogFn,
  api: OpenClawPluginApi,
  event: { channelId?: string; accountId?: string; conversationId?: string },
): Promise<SessionBinding | null> {
  const requestedConversationId = normalizeText(event.conversationId);
  const normalizedRequestedConversationId =
    normalizeTelegramConversationLookupValue(requestedConversationId);
  info("ENTER resolveTargetSessionBinding", {
    channelId: event.channelId,
    accountId: event.accountId,
    conversationId: event.conversationId,
    normalizedConversationId: normalizedRequestedConversationId,
  });
  if (normalizeText(event.channelId) !== TELEGRAM_CHANNEL_ID) {
    info("resolveTargetSessionBinding result", {
      matched: false,
      reason: "unsupported_channel",
      channelId: event.channelId,
    });
    return null;
  }

  let best: SessionBinding | null = null;
  for (const agentId of getAgentIds(api.config)) {
    const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
      agentId,
    });
    const store = await loadSessionStore(api, storePath, info);
    info("resolveTargetSessionBinding scan_store", {
      agentId,
      storePath,
      keyCount: Object.keys(store).length,
      keys: summarizeStoreKeys(store),
    });
    for (const [sessionKey, entry] of Object.entries(store)) {
      const gate = readGateState(entry);
      info("resolveTargetSessionBinding inspect_entry", {
        agentId,
        storePath,
        sessionKey,
        entrySessionId: entry.sessionId,
        armed: gate?.armed === true,
        phase: gate?.phase,
        lastFrom: entry.lastFrom,
        lastTo: entry.lastTo,
        channel: entry.channel,
        lastChannel: entry.lastChannel,
        accountId: entry.accountId,
        lastAccountId: entry.lastAccountId,
      });
      if (!gate?.armed) {
        info("resolveTargetSessionBinding skip", {
          sessionKey,
          reason: "entry_not_armed",
        });
        continue;
      }
      const delivery = entry.deliveryContext;
      const candidateChannel =
        normalizeText(delivery?.channel) ||
        normalizeText(entry.lastChannel) ||
        normalizeText(entry.channel);
      const candidateConversations = [
        normalizeText(delivery?.to),
        normalizeText(entry.lastTo),
        normalizeText(entry.lastFrom),
        normalizeText(entry.sessionId),
      ].filter(Boolean);
      const normalizedCandidateConversations = [
        ...new Set(
          candidateConversations.map((candidate) =>
            normalizeTelegramConversationLookupValue(candidate),
          ),
        ),
      ].filter(Boolean);
      const candidateAccountId =
        normalizeText(delivery?.accountId) ||
        normalizeText(entry.lastAccountId) ||
        normalizeText(entry.accountId);
      if (candidateChannel !== TELEGRAM_CHANNEL_ID) {
        info("resolveTargetSessionBinding skip", {
          sessionKey,
          reason: "channel_mismatch",
          candidateChannel,
        });
        continue;
      }
      info("resolveTargetSessionBinding compare_conversations", {
        sessionKey,
        requestedConversationId,
        normalizedRequestedConversationId,
        candidateConversations,
        normalizedCandidateConversations,
      });
      if (
        requestedConversationId &&
        !normalizedCandidateConversations.includes(normalizedRequestedConversationId)
      ) {
        info("resolveTargetSessionBinding skip", {
          sessionKey,
          reason: "conversation_mismatch",
          requestedConversationId,
          normalizedRequestedConversationId,
          candidateConversations,
          normalizedCandidateConversations,
        });
        continue;
      }
      if (
        normalizeText(event.accountId) &&
        candidateAccountId &&
        candidateAccountId !== normalizeText(event.accountId)
      ) {
        info("resolveTargetSessionBinding skip", {
          sessionKey,
          reason: "account_mismatch",
          requestedAccountId: normalizeText(event.accountId),
          candidateAccountId,
        });
        continue;
      }
      const updatedAt = Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : 0;
      if (
        !best ||
        updatedAt >= (Number.isFinite(best.entry.updatedAt) ? Number(best.entry.updatedAt) : 0)
      ) {
        best = { agentId, storePath, sessionKey, entry };
        info("resolveTargetSessionBinding candidate_best", {
          agentId,
          storePath,
          sessionKey,
          updatedAt,
          candidateConversations,
          normalizedCandidateConversations,
          candidateAccountId,
        });
      }
    }
  }
  info("resolveTargetSessionBinding result", {
    matched: Boolean(best),
    agentId: best?.agentId,
    storePath: best?.storePath,
    sessionKey: best?.sessionKey,
  });
  return best;
}

async function armCurrentSession(
  info: SelfCheckLogFn,
  api: OpenClawPluginApi,
  ctx: PluginCommandContext,
): Promise<string> {
  info("ENTER armCurrentSession", {
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    channelId: ctx.channelId,
    accountId: ctx.accountId,
    from: ctx.from,
    to: ctx.to,
    messageThreadId: ctx.messageThreadId,
  });
  const sessionKey = normalizeText(ctx.sessionKey);
  if (!sessionKey) {
    info("armCurrentSession result", { armed: false, reason: "missing_session_key" });
    return "Cannot arm self-check gate: missing session key.";
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
    agentId,
  });
  const store = await loadSessionStore(api, storePath, info);
  const currentKey = Object.prototype.hasOwnProperty.call(store, sessionKey)
    ? sessionKey
    : Object.keys(store).find((key) => normalizeText(key) === normalizeText(sessionKey));
  const targetKey = currentKey ?? sessionKey;
  const armReply = `Self-check gate enabled for this session (${sessionKey}).`;
  const entry = store[targetKey] ?? {
    sessionId: normalizeText(ctx.sessionId) || sessionKey,
    updatedAt: Date.now(),
  };

  entry.sessionId = normalizeText(ctx.sessionId) || entry.sessionId || sessionKey;
  entry.updatedAt = Date.now();
  entry.channel = ctx.channelId;
  entry.lastChannel = ctx.channelId;
  entry.accountId = ctx.accountId;
  entry.lastAccountId = ctx.accountId;
  entry.lastFrom = ctx.from;
  entry.lastTo = ctx.to;
  if (ctx.messageThreadId != null) {
    entry.lastThreadId = ctx.messageThreadId;
  }
  writeGateState(entry, {
    armed: true,
    phase: "work",
    attempts: 0,
    sameHashCount: 0,
    skipNextContentHash: stableHash(armReply),
    updatedAtMs: Date.now(),
  });
  store[targetKey] = entry;
  await saveSessionStore(info, api, storePath, store);
  info("armCurrentSession result", {
    armed: true,
    agentId,
    storePath,
    currentKey,
    targetKey,
    sessionId: entry.sessionId,
    lastFrom: entry.lastFrom,
    lastTo: entry.lastTo,
    skipNextContentHash: readGateState(entry)?.skipNextContentHash,
  });
  return armReply;
}

async function disarmCurrentSession(
  info: SelfCheckLogFn,
  api: OpenClawPluginApi,
  ctx: PluginCommandContext,
): Promise<string> {
  info("ENTER disarmCurrentSession", {
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
  });
  const sessionKey = normalizeText(ctx.sessionKey);
  if (!sessionKey) {
    info("disarmCurrentSession result", { disarmed: false, reason: "missing_session_key" });
    return "Cannot disarm self-check gate: missing session key.";
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
    agentId,
  });
  const store = await loadSessionStore(api, storePath);
  const currentKey = Object.prototype.hasOwnProperty.call(store, sessionKey)
    ? sessionKey
    : Object.keys(store).find((key) => normalizeText(key) === normalizeText(sessionKey));
  const targetKey = currentKey ?? sessionKey;
  const entry = store[targetKey] ?? {
    sessionId: normalizeText(ctx.sessionId) || sessionKey,
    updatedAt: Date.now(),
  };
  entry.sessionId = normalizeText(ctx.sessionId) || entry.sessionId || sessionKey;
  entry.updatedAt = Date.now();
  clearGateState(entry);
  store[targetKey] = entry;
  await saveSessionStore(info, api, storePath, store);
  info("disarmCurrentSession result", {
    disarmed: true,
    agentId,
    storePath,
    currentKey,
    targetKey,
  });
  return `Self-check gate disabled for this session (${sessionKey}).`;
}

function buildMessageSendingFollowup(prompt: string): { followup: { prompt: string } } {
  return {
    followup: {
      prompt,
    },
  };
}

function buildContinuePrompt(verdict: SelfCheckVerdict, gate: SelfCheckGateState): string {
  const nextAction = verdict.nextAction?.trim();
  return [
    "CONTINUE_WORK",
    "Continue the task using the latest self-check feedback.",
    nextAction
      ? `Next action: ${nextAction}`
      : "Continue refining the work and fix the remaining issues.",
    `Attempts so far: ${gate.attempts + 1}`,
    `Progress hash: ${verdict.progressHash}`,
    verdict.reason ? `Reason: ${verdict.reason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildStopPrompt(verdict: SelfCheckVerdict, gate: SelfCheckGateState): string {
  const blockers = verdict.blockers?.length ? verdict.blockers.join(", ") : "unknown blockers";
  return [
    "SELF_CHECK_STOP",
    `Outcome: ${formatStateLabel(verdict.state)}`,
    `Blockers: ${blockers}`,
    verdict.reason ? `Reason: ${verdict.reason}` : "",
    `Attempts: ${gate.attempts}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export default definePluginEntry({
  id: "self-check-gate",
  name: "Self Check Gate",
  description: "Session-scoped self-check gate for Telegram followups.",
  register(api: OpenClawPluginApi) {
    const info: SelfCheckLogFn = (message, meta) => {
      const line = `self-check-gate: ${message}${meta ? formatLogMeta(meta) : ""}`;
      api.logger.info(line);
    };
    info("plugin registered", {
      pluginId: api.id,
      registrationMode: api.registrationMode,
      source: api.source,
    });

    api.registerCommand({
      name: "selfcheck",
      description: "Arm or disarm the self-check gate for the current session.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const action = normalizeText(ctx.args).split(/\s+/)[0]?.toLowerCase() ?? "";
        if (action === "on") {
          return { text: await armCurrentSession(info, api, ctx) };
        }
        if (action === "off") {
          return { text: await disarmCurrentSession(info, api, ctx) };
        }
        return {
          text: "Usage: /selfcheck on | /selfcheck off",
        };
      },
    });

    api.on("before_tool_call", async (event, ctx) => {
      const hookEvent = event as { toolName?: string; params?: Record<string, unknown> };
      const hookCtx = ctx as { sessionKey?: string; sessionId?: string };
      const sessionKey = normalizeText(hookCtx.sessionKey);
      const sessionId = normalizeText(hookCtx.sessionId);
      const toolName = normalizeText(hookEvent.toolName);
      info("before_tool_call enter", { sessionKey, sessionId, toolName });
      if (!sessionKey && !sessionId) {
        info("before_tool_call allow", { reason: "missing_session_identity", toolName });
        return;
      }
      const binding = await findGateBindingForTool(info, api, sessionKey, sessionId);
      if (!binding) {
        info("before_tool_call allow", {
          reason: "no_armed_binding",
          sessionKey,
          sessionId,
          toolName,
        });
        return;
      }
      const gate = readGateState(binding.entry);
      if (!gate?.armed || gate.phase !== "self_check") {
        info("before_tool_call allow", {
          reason: !gate?.armed ? "session_not_armed" : "phase_not_self_check",
          bindingSessionKey: binding.sessionKey,
          phase: gate?.phase,
          toolName,
        });
        return;
      }
      const paramsRecord = hookEvent.params ?? {};
      if (looksReadOnlyTool(toolName, paramsRecord)) {
        info("before_tool_call allow", {
          reason: "read_only_tool",
          bindingSessionKey: binding.sessionKey,
          phase: gate.phase,
          toolName,
        });
        return;
      }
      info("before_tool_call block", {
        reason: "self_check_write_block",
        bindingSessionKey: binding.sessionKey,
        phase: gate.phase,
        toolName,
      });
      return {
        block: true,
        blockReason: "Self-check mode allows read-only tools only.",
      };
    });

    api.on("message_sending", async (event, ctx) => {
      const hookEvent = event as {
        content?: string;
        metadata?: Record<string, unknown>;
        to?: string;
      };
      const hookCtx = ctx as { channelId?: string; accountId?: string; conversationId?: string };
      info("message_sending enter", {
        channelId: hookCtx.channelId,
        accountId: hookCtx.accountId,
        conversationId: hookCtx.conversationId,
        targetTo: hookEvent.to,
      });
      if (normalizeText(hookCtx.channelId) !== TELEGRAM_CHANNEL_ID) {
        info("message_sending allow", {
          reason: "unsupported_channel",
          channelId: hookCtx.channelId,
        });
        return;
      }
      const binding = await resolveTargetSessionBinding(info, api, hookCtx);
      if (!binding) {
        info("message_sending allow", {
          reason: "no_armed_binding",
          conversationId: hookCtx.conversationId,
          accountId: hookCtx.accountId,
        });
        return;
      }
      const gate = readGateState(binding.entry);
      const runtimeSelection = resolveSessionRuntimeSelection(binding.entry);
      info("message_sending binding", {
        sessionKey: binding.sessionKey,
        agentId: binding.agentId,
        armed: gate?.armed === true,
        phase: gate?.phase,
        runtimeProvider: runtimeSelection.provider,
        runtimeModel: runtimeSelection.model,
        authProfileId: runtimeSelection.authProfileId,
        authProfileIdSource: runtimeSelection.authProfileIdSource,
      });
      if (!gate?.armed) {
        info("message_sending allow", {
          reason: "session_not_armed",
          sessionKey: binding.sessionKey,
        });
        return;
      }

      const content = normalizeText(hookEvent.content);
      info("message_sending candidate_final", {
        sessionKey: binding.sessionKey,
        detected: content.length > 0,
        length: content.length,
      });
      if (!content) {
        info("message_sending allow", {
          reason: "empty_content",
          sessionKey: binding.sessionKey,
        });
        return;
      }

      if (gate.skipNextContentHash && gate.skipNextContentHash === stableHash(content)) {
        const nextGate = {
          ...gate,
          skipNextContentHash: undefined,
          updatedAtMs: Date.now(),
        };
        writeGateState(binding.entry, nextGate);
        await saveSessionStore(info, api, binding.storePath, {
          ...(await loadSessionStore(api, binding.storePath, info)),
          [binding.sessionKey]: binding.entry,
        });
        info("message_sending allow", {
          reason: "arm_confirmation",
          sessionKey: binding.sessionKey,
        });
        return;
      }

      if (gate.phase === "work") {
        const nextGate = {
          ...gate,
          phase: "self_check" as const,
          attempts: gate.attempts + 1,
          pendingFinal: content,
          sameHashCount: gate.sameHashCount,
          updatedAtMs: Date.now(),
        };
        info("message_sending phase_transition", {
          sessionKey: binding.sessionKey,
          from: gate.phase,
          to: nextGate.phase,
          attempts: nextGate.attempts,
          sameHashCount: nextGate.sameHashCount,
        });
        writeGateState(binding.entry, nextGate);
        await saveSessionStore(info, api, binding.storePath, {
          ...(await loadSessionStore(api, binding.storePath, info)),
          [binding.sessionKey]: binding.entry,
        });
        info("message_sending schedule_followup", {
          kind: "self_check",
          sessionKey: binding.sessionKey,
          sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
          messageThreadId:
            binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
        });
        return buildMessageSendingFollowup(
          formatSelfCheckPrompt(info, {
            sessionKey: binding.sessionKey,
            attempts: nextGate.attempts,
            sameHashCount: nextGate.sameHashCount,
            pendingFinal: content,
          }),
        );
      }

      if (gate.phase === "self_check") {
        info("message_sending parse_verdict", {
          sessionKey: binding.sessionKey,
          length: content.length,
        });
        const verdict = parseVerdict(content);
        if (!verdict) {
          const fallbackGate = {
            ...gate,
            phase: "finalize" as const,
            releaseKind: "blocked_external" as const,
            pendingFinal: buildStopPrompt(
              {
                state: "blocked_external",
                progressHash: stableHash(content),
                reason: "Self-check verdict was not valid JSON.",
                blockers: ["invalid self-check verdict"],
              },
              gate,
            ),
            lastVerdict: "blocked_external" as const,
            updatedAtMs: Date.now(),
          };
          info("message_sending verdict_invalid", {
            sessionKey: binding.sessionKey,
            nextPhase: fallbackGate.phase,
            releaseKind: fallbackGate.releaseKind,
          });
          writeGateState(binding.entry, fallbackGate);
          await saveSessionStore(info, api, binding.storePath, {
            ...(await loadSessionStore(api, binding.storePath, info)),
            [binding.sessionKey]: binding.entry,
          });
          info("message_sending schedule_followup", {
            kind: "release_invalid_verdict",
            sessionKey: binding.sessionKey,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
          });
          return buildMessageSendingFollowup(fallbackGate.pendingFinal || "");
        }

        const sameHashCount =
          verdict.progressHash === gate.progressHash ? gate.sameHashCount + 1 : 0;
        const attempts = gate.attempts;
        info("message_sending verdict_parsed", {
          sessionKey: binding.sessionKey,
          verdictState: verdict.state,
          progressHash: verdict.progressHash,
          sameHashCount,
          attempts,
        });
        if (sameHashCount >= MAX_SAME_HASH || attempts >= MAX_ATTEMPTS) {
          const stopper: SelfCheckGateState = {
            ...gate,
            phase: "finalize",
            sameHashCount,
            releaseKind: "blocked_external",
            pendingFinal: buildStopPrompt(verdict, { ...gate, sameHashCount }),
            lastVerdict: verdict.state,
            progressHash: verdict.progressHash,
            updatedAtMs: Date.now(),
          };
          info("message_sending stop", {
            sessionKey: binding.sessionKey,
            reason: sameHashCount >= MAX_SAME_HASH ? "same_hash_limit" : "attempt_limit",
            sameHashCount,
            attempts,
            nextPhase: stopper.phase,
          });
          writeGateState(binding.entry, stopper);
          await saveSessionStore(info, api, binding.storePath, {
            ...(await loadSessionStore(api, binding.storePath, info)),
            [binding.sessionKey]: binding.entry,
          });
          info("message_sending schedule_followup", {
            kind: "stop",
            sessionKey: binding.sessionKey,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
          });
          return buildMessageSendingFollowup(stopper.pendingFinal || "");
        }

        if (verdict.state === "continue") {
          const nextGate: SelfCheckGateState = {
            ...gate,
            phase: "work",
            attempts: gate.attempts,
            sameHashCount,
            progressHash: verdict.progressHash,
            releaseKind: undefined,
            pendingFinal: undefined,
            lastVerdict: verdict.state,
            updatedAtMs: Date.now(),
          };
          info("message_sending phase_transition", {
            sessionKey: binding.sessionKey,
            from: gate.phase,
            to: nextGate.phase,
            verdictState: verdict.state,
            sameHashCount,
          });
          writeGateState(binding.entry, nextGate);
          await saveSessionStore(info, api, binding.storePath, {
            ...(await loadSessionStore(api, binding.storePath, info)),
            [binding.sessionKey]: binding.entry,
          });
          info("message_sending schedule_followup", {
            kind: "continue",
            sessionKey: binding.sessionKey,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            nextAction: verdict.nextAction,
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
          });
          return buildMessageSendingFollowup(buildContinuePrompt(verdict, nextGate));
        }

        const releaseKind: ReleaseKind =
          verdict.state === "done"
            ? "final"
            : verdict.state === "wait_external"
              ? "wait_external"
              : "blocked_external";
        const nextGate: SelfCheckGateState = {
          ...gate,
          phase: "finalize",
          attempts: gate.attempts,
          sameHashCount,
          progressHash: verdict.progressHash,
          releaseKind,
          pendingFinal:
            releaseKind === "final"
              ? gate.pendingFinal
              : buildStopPrompt(verdict, { ...gate, sameHashCount }),
          lastVerdict: verdict.state,
          updatedAtMs: Date.now(),
        };
        info("message_sending phase_transition", {
          sessionKey: binding.sessionKey,
          from: gate.phase,
          to: nextGate.phase,
          verdictState: verdict.state,
          releaseKind,
          sameHashCount,
        });
        writeGateState(binding.entry, nextGate);
        await saveSessionStore(info, api, binding.storePath, {
          ...(await loadSessionStore(api, binding.storePath, info)),
          [binding.sessionKey]: binding.entry,
        });
        info("message_sending schedule_followup", {
          kind: "release",
          sessionKey: binding.sessionKey,
          sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
          releaseKind,
          messageThreadId:
            binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
        });
        return buildMessageSendingFollowup(
          releaseKind === "final"
            ? formatReleasePrompt(info, { state: nextGate, reason: verdict.reason })
            : nextGate.pendingFinal || "",
        );
      }

      if (gate.phase === "finalize") {
        info("message_sending release_final", {
          sessionKey: binding.sessionKey,
          releaseKind: gate.releaseKind,
          lastVerdict: gate.lastVerdict,
        });
        clearGateState(binding.entry);
        await saveSessionStore(info, api, binding.storePath, {
          ...(await loadSessionStore(api, binding.storePath, info)),
          [binding.sessionKey]: binding.entry,
        });
        info("message_sending allow", {
          reason: "final_message_released",
          sessionKey: binding.sessionKey,
        });
        return;
      }
    });
  },
});
/*
      if (gate.phase === "self_check") {
        info("message_sending parse_verdict", {
          sessionKey: binding.sessionKey,
          length: content.length,
        });
        const verdict = parseVerdict(content);
        if (!verdict) {
          const fallbackGate = {
            ...gate,
            phase: "finalize" as const,
            releaseKind: "blocked_external" as const,
            pendingFinal: buildStopPrompt(
              {
                state: "blocked_external",
                progressHash: stableHash(content),
                reason: "Self-check verdict was not valid JSON.",
                blockers: ["invalid self-check verdict"],
              },
              gate,
            ),
            lastVerdict: "blocked_external" as const,
            updatedAtMs: Date.now(),
          };
          info("message_sending verdict_invalid", {
            sessionKey: binding.sessionKey,
            nextPhase: fallbackGate.phase,
            releaseKind: fallbackGate.releaseKind,
          });
          writeGateState(binding.entry, fallbackGate);
          await saveSessionStore(info, api, binding.storePath, {
            ...(await loadSessionStore(api, binding.storePath, info)),
            [binding.sessionKey]: binding.entry,
          });
          info("message_sending schedule_followup", {
            kind: "release_invalid_verdict",
            sessionKey: binding.sessionKey,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
          });
          await scheduleSelfCheckFollowup(info, api, {
            agentId: binding.agentId,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            sessionKey: binding.sessionKey,
            channelId: TELEGRAM_CHANNEL_ID,
            accountId:
              normalizeText(hookCtx.accountId) ||
              normalizeText(binding.entry.deliveryContext?.accountId),
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
            prompt: fallbackGate.pendingFinal || "",
          });
          info("message_sending cancel", {
            reason: "invalid_verdict_release_scheduled",
            sessionKey: binding.sessionKey,
          });
          return { cancel: true };
        }

        const sameHashCount =
          verdict.progressHash === gate.progressHash ? gate.sameHashCount + 1 : 0;
        const attempts = gate.attempts;
        info("message_sending verdict_parsed", {
          sessionKey: binding.sessionKey,
          verdictState: verdict.state,
          progressHash: verdict.progressHash,
          sameHashCount,
          attempts,
        });
        if (sameHashCount >= MAX_SAME_HASH || attempts >= MAX_ATTEMPTS) {
          const stopper: SelfCheckGateState = {
            ...gate,
            phase: "finalize",
            sameHashCount,
            releaseKind: "blocked_external",
            pendingFinal: buildStopPrompt(verdict, { ...gate, sameHashCount }),
            lastVerdict: verdict.state,
            progressHash: verdict.progressHash,
            updatedAtMs: Date.now(),
          };
          info("message_sending stop", {
            sessionKey: binding.sessionKey,
            reason: sameHashCount >= MAX_SAME_HASH ? "same_hash_limit" : "attempt_limit",
            sameHashCount,
            attempts,
            nextPhase: stopper.phase,
          });
          writeGateState(binding.entry, stopper);
          await saveSessionStore(info, api, binding.storePath, {
            ...(await loadSessionStore(api, binding.storePath, info)),
            [binding.sessionKey]: binding.entry,
          });
          info("message_sending schedule_followup", {
            kind: "stop",
            sessionKey: binding.sessionKey,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
          });
          await scheduleSelfCheckFollowup(info, api, {
            agentId: binding.agentId,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            sessionKey: binding.sessionKey,
            channelId: TELEGRAM_CHANNEL_ID,
            accountId:
              normalizeText(hookCtx.accountId) ||
              normalizeText(binding.entry.deliveryContext?.accountId),
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
            prompt: stopper.pendingFinal || "",
          });
          info("message_sending cancel", {
            reason: "stop_followup_scheduled",
            sessionKey: binding.sessionKey,
          });
          return { cancel: true };
        }

        if (verdict.state === "continue") {
          const nextGate: SelfCheckGateState = {
            ...gate,
            phase: "work",
            attempts: gate.attempts,
            sameHashCount,
            progressHash: verdict.progressHash,
            releaseKind: undefined,
            pendingFinal: undefined,
            lastVerdict: verdict.state,
            updatedAtMs: Date.now(),
          };
          info("message_sending phase_transition", {
            sessionKey: binding.sessionKey,
            from: gate.phase,
            to: nextGate.phase,
            verdictState: verdict.state,
            sameHashCount,
          });
          writeGateState(binding.entry, nextGate);
          await saveSessionStore(info, api, binding.storePath, {
            ...(await loadSessionStore(api, binding.storePath, info)),
            [binding.sessionKey]: binding.entry,
          });
          info("message_sending schedule_followup", {
            kind: "continue",
            sessionKey: binding.sessionKey,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            nextAction: verdict.nextAction,
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
          });
          await scheduleSelfCheckFollowup(info, api, {
            agentId: binding.agentId,
            sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
            sessionKey: binding.sessionKey,
            channelId: TELEGRAM_CHANNEL_ID,
            accountId:
              normalizeText(hookCtx.accountId) ||
              normalizeText(binding.entry.deliveryContext?.accountId),
            messageThreadId:
              binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
            prompt: buildContinuePrompt(verdict, nextGate),
          });
          info("message_sending cancel", {
            reason: "continue_followup_scheduled",
            sessionKey: binding.sessionKey,
          });
          return { cancel: true };
        }

        const releaseKind: ReleaseKind =
          verdict.state === "done"
            ? "final"
            : verdict.state === "wait_external"
              ? "wait_external"
              : "blocked_external";
        const nextGate: SelfCheckGateState = {
          ...gate,
          phase: "finalize",
          attempts: gate.attempts,
          sameHashCount,
          progressHash: verdict.progressHash,
          releaseKind,
          pendingFinal:
            releaseKind === "final"
              ? gate.pendingFinal
              : buildStopPrompt(verdict, { ...gate, sameHashCount }),
          lastVerdict: verdict.state,
          updatedAtMs: Date.now(),
        };
        info("message_sending phase_transition", {
          sessionKey: binding.sessionKey,
          from: gate.phase,
          to: nextGate.phase,
          verdictState: verdict.state,
          releaseKind,
          sameHashCount,
        });
        writeGateState(binding.entry, nextGate);
        await saveSessionStore(info, api, binding.storePath, {
          ...(await loadSessionStore(api, binding.storePath, info)),
          [binding.sessionKey]: binding.entry,
        });
        info("message_sending schedule_followup", {
          kind: "release",
          sessionKey: binding.sessionKey,
          sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
          releaseKind,
          messageThreadId:
            binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
        });
        await scheduleSelfCheckFollowup(info, api, {
          agentId: binding.agentId,
          sessionId: normalizeText(binding.entry.sessionId) || binding.sessionKey,
          sessionKey: binding.sessionKey,
          channelId: TELEGRAM_CHANNEL_ID,
          accountId:
            normalizeText(hookCtx.accountId) ||
            normalizeText(binding.entry.deliveryContext?.accountId),
          messageThreadId:
            binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
          prompt:
            releaseKind === "final"
              ? formatReleasePrompt(info, { state: nextGate, reason: verdict.reason })
              : nextGate.pendingFinal || "",
        });
        info("message_sending cancel", {
          reason: "release_followup_scheduled",
          sessionKey: binding.sessionKey,
          releaseKind,
        });
        return { cancel: true };
      }

      if (gate.phase === "finalize") {
        info("message_sending release_final", {
          sessionKey: binding.sessionKey,
          releaseKind: gate.releaseKind,
          lastVerdict: gate.lastVerdict,
        });
        clearGateState(binding.entry);
        await saveSessionStore(info, api, binding.storePath, {
          ...(await loadSessionStore(api, binding.storePath, info)),
          [binding.sessionKey]: binding.entry,
        });
        info("message_sending allow", {
          reason: "final_message_released",
          sessionKey: binding.sessionKey,
        });
        return;
      }
    });
  },
});

*/

async function findGateBindingForTool(
  info: SelfCheckLogFn,
  api: OpenClawPluginApi,
  sessionKey: string,
  sessionId: string,
): Promise<SessionBinding | null> {
  info("ENTER findGateBindingForTool", { sessionKey, sessionId });
  if (!sessionKey && !sessionId) {
    info("findGateBindingForTool result", { matched: false, reason: "missing_session_identity" });
    return null;
  }
  const normalizedSessionKey = normalizeText(sessionKey);
  const normalizedSessionId = normalizeText(sessionId);
  for (const agentId of getAgentIds(api.config)) {
    const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
      agentId,
    });
    const store = await loadSessionStore(api, storePath, info);
    info("findGateBindingForTool scan_store", {
      agentId,
      storePath,
      keyCount: Object.keys(store).length,
      keys: summarizeStoreKeys(store),
    });
    for (const [candidateKey, entry] of Object.entries(store)) {
      const gate = readGateState(entry);
      info("findGateBindingForTool inspect_entry", {
        agentId,
        storePath,
        candidateKey,
        entrySessionId: entry.sessionId,
        armed: gate?.armed === true,
        phase: gate?.phase,
      });
      if (!gate?.armed) {
        info("findGateBindingForTool skip", { candidateKey, reason: "entry_not_armed" });
        continue;
      }
      if (normalizedSessionKey && normalizeText(candidateKey) !== normalizedSessionKey) {
        info("findGateBindingForTool skip", {
          candidateKey,
          reason: "session_key_mismatch",
          requestedSessionKey: normalizedSessionKey,
        });
        continue;
      }
      if (normalizedSessionId && normalizeText(entry.sessionId) !== normalizedSessionId) {
        info("findGateBindingForTool skip", {
          candidateKey,
          reason: "session_id_mismatch",
          requestedSessionId: normalizedSessionId,
          entrySessionId: entry.sessionId,
        });
        continue;
      }
      info("findGateBindingForTool result", {
        matched: true,
        agentId,
        storePath,
        sessionKey: candidateKey,
      });
      return { agentId, storePath, sessionKey: candidateKey, entry };
    }
  }
  info("findGateBindingForTool result", {
    matched: false,
    sessionKey: normalizedSessionKey,
    sessionId: normalizedSessionId,
  });
  return null;
}
