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

type EmbeddedPiRunResult = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["agent"]["runEmbeddedPiAgent"]>
>;

type SelfCheckInlineDecision =
  | { kind: "allow" }
  | { kind: "replace"; content: string }
  | { kind: "cancel"; reason: string };

const TELEGRAM_CHANNEL_ID = "telegram";
const MAX_ATTEMPTS = 6;
const MAX_CONTINUE_ITERATIONS = 3;
const MAX_SAME_HASH = 2;
const SELF_CHECK_FOLLOWUP_DELAY_MS = 1000;
const SELF_CHECK_RUN_TIMEOUT_MS = 5 * 60 * 1000;
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

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractVisibleTextFromRunResult(result: EmbeddedPiRunResult): string | null {
  const segments: string[] = [];
  for (const payload of result.payloads ?? []) {
    if (payload.isError || payload.isReasoning) {
      continue;
    }
    const text = normalizeText(payload.text);
    if (!text) {
      continue;
    }
    segments.push(text);
  }
  return segments.length > 0 ? segments.join("\n\n").trim() : null;
}

function buildResetGateState(lastVerdict?: SelfCheckVerdictState): SelfCheckGateState {
  return {
    armed: true,
    phase: "work",
    attempts: 0,
    sameHashCount: 0,
    ...(lastVerdict ? { lastVerdict } : {}),
    updatedAtMs: Date.now(),
  };
}

function resolveInlineDecision(params: {
  canReplaceContent: boolean;
  originalContent: string;
  finalContent: string;
  denyReason: string;
}): SelfCheckInlineDecision {
  if (params.finalContent === params.originalContent) {
    return { kind: "allow" };
  }
  if (params.canReplaceContent) {
    return { kind: "replace", content: params.finalContent };
  }
  return { kind: "cancel", reason: params.denyReason };
}

function supportsInlineContentReplacement(event: { metadata?: Record<string, unknown> }): boolean {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") {
    return true;
  }
  const channel = normalizeText(
    typeof metadata.channel === "string" ? metadata.channel : undefined,
  );
  if (channel !== TELEGRAM_CHANNEL_ID) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(metadata, "mediaUrls");
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

async function persistBindingEntry(
  info: SelfCheckLogFn,
  api: OpenClawPluginApi,
  binding: SessionBinding,
): Promise<void> {
  const store = await loadSessionStore(api, binding.storePath, info);
  store[binding.sessionKey] = binding.entry;
  await saveSessionStore(info, api, binding.storePath, store);
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

async function runInlineFollowupTurn(
  info: SelfCheckLogFn,
  api: OpenClawPluginApi,
  params: {
    kind: "self_check" | "continue";
    agentId: string;
    sessionId: string;
    sessionKey: string;
    channelId: string;
    accountId?: string;
    messageThreadId?: string | number;
    prompt: string;
    delayMs?: number;
    runtimeSelection?: SessionRuntimeSelection;
  },
): Promise<EmbeddedPiRunResult> {
  info("ENTER runInlineFollowupTurn", {
    kind: params.kind,
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    channelId: params.channelId,
    accountId: params.accountId,
    messageThreadId: params.messageThreadId,
    delayMs: params.delayMs ?? 0,
    provider: params.runtimeSelection?.provider,
    model: params.runtimeSelection?.model,
    authProfileId: params.runtimeSelection?.authProfileId,
    authProfileIdSource: params.runtimeSelection?.authProfileIdSource,
  });
  const runParams = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    messageChannel: params.channelId,
    agentAccountId: params.accountId,
    messageTo: params.sessionKey,
    messageThreadId: params.messageThreadId,
    trigger: "manual",
    prompt: params.prompt,
    config: api.config,
    workspaceDir: api.config.agents?.defaults?.workspace ?? process.cwd(),
    sessionFile: api.runtime.agent.session.resolveSessionFilePath(params.sessionId, undefined, {
      agentId: params.agentId,
    }),
    timeoutMs: SELF_CHECK_RUN_TIMEOUT_MS,
    runId: `self-check-gate:${params.kind}:${params.sessionKey}:${Date.now()}`,
    disableTools: false,
    disableMessageTool: true,
    allowGatewaySubagentBinding: false,
    ...(params.runtimeSelection?.provider ? { provider: params.runtimeSelection.provider } : {}),
    ...(params.runtimeSelection?.model ? { model: params.runtimeSelection.model } : {}),
    ...(params.runtimeSelection?.authProfileId
      ? { authProfileId: params.runtimeSelection.authProfileId }
      : {}),
    ...(params.runtimeSelection?.authProfileId && params.runtimeSelection.authProfileIdSource
      ? { authProfileIdSource: params.runtimeSelection.authProfileIdSource }
      : {}),
  };
  if (typeof params.delayMs === "number" && params.delayMs > 0) {
    info("runInlineFollowupTurn delayed_launch", {
      kind: params.kind,
      sessionKey: params.sessionKey,
      delayMs: params.delayMs,
    });
    await waitForDelay(params.delayMs);
  }
  info("runInlineFollowupTurn start_run", {
    kind: params.kind,
    sessionKey: params.sessionKey,
    delayMs: params.delayMs ?? 0,
    provider: params.runtimeSelection?.provider,
    model: params.runtimeSelection?.model,
    authProfileId: params.runtimeSelection?.authProfileId,
    authProfileIdSource: params.runtimeSelection?.authProfileIdSource,
  });
  const result = await api.runtime.agent.runEmbeddedPiAgent(runParams);
  info("runInlineFollowupTurn complete", {
    kind: params.kind,
    sessionKey: params.sessionKey,
    payloadCount: result.payloads?.length ?? 0,
    visibleTextLength: extractVisibleTextFromRunResult(result)?.length ?? 0,
    aborted: result.meta?.aborted === true,
    didSendViaMessagingTool: result.didSendViaMessagingTool === true,
    stopReason: result.meta?.stopReason,
  });
  return result;
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

async function runInlineSelfCheckCycle(
  info: SelfCheckLogFn,
  api: OpenClawPluginApi,
  params: {
    binding: SessionBinding;
    originalContent: string;
    canReplaceContent: boolean;
    runtimeSelection: SessionRuntimeSelection;
    accountId?: string;
    messageThreadId?: string | number;
  },
): Promise<SelfCheckInlineDecision> {
  const { binding, originalContent, canReplaceContent, runtimeSelection } = params;
  const initialGate = readGateState(binding.entry);
  if (!initialGate?.armed) {
    return { kind: "allow" };
  }

  const sessionId = normalizeText(binding.entry.sessionId) || binding.sessionKey;
  const accountId =
    normalizeText(params.accountId) || normalizeText(binding.entry.deliveryContext?.accountId);
  const messageThreadId =
    params.messageThreadId ?? binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId;

  let candidateContent = originalContent;
  let attempts = initialGate.attempts;
  let sameHashCount = initialGate.sameHashCount;
  let progressHash = initialGate.progressHash;
  let lastVerdict = initialGate.lastVerdict;

  const resetAndPersist = async (verdict?: SelfCheckVerdictState) => {
    writeGateState(binding.entry, buildResetGateState(verdict ?? lastVerdict));
    await persistBindingEntry(info, api, binding);
  };

  try {
    while (true) {
      attempts += 1;
      const selfCheckGate: SelfCheckGateState = {
        armed: true,
        phase: "self_check",
        attempts,
        sameHashCount,
        ...(progressHash ? { progressHash } : {}),
        pendingFinal: candidateContent,
        ...(lastVerdict ? { lastVerdict } : {}),
        updatedAtMs: Date.now(),
      };
      info("message_sending phase_transition", {
        sessionKey: binding.sessionKey,
        from: attempts === initialGate.attempts + 1 ? initialGate.phase : "work",
        to: selfCheckGate.phase,
        attempts: selfCheckGate.attempts,
        sameHashCount: selfCheckGate.sameHashCount,
      });
      writeGateState(binding.entry, selfCheckGate);
      await persistBindingEntry(info, api, binding);

      info("message_sending schedule_followup", {
        kind: "self_check",
        mode: "inline",
        sessionKey: binding.sessionKey,
        sessionId,
        delayMs: SELF_CHECK_FOLLOWUP_DELAY_MS,
        messageThreadId,
      });
      const selfCheckResult = await runInlineFollowupTurn(info, api, {
        kind: "self_check",
        agentId: binding.agentId,
        sessionId,
        sessionKey: binding.sessionKey,
        channelId: TELEGRAM_CHANNEL_ID,
        accountId,
        messageThreadId,
        delayMs: SELF_CHECK_FOLLOWUP_DELAY_MS,
        prompt: formatSelfCheckPrompt(info, {
          sessionKey: binding.sessionKey,
          attempts: selfCheckGate.attempts,
          sameHashCount: selfCheckGate.sameHashCount,
          pendingFinal: candidateContent,
        }),
        runtimeSelection,
      });
      const verdictText = extractVisibleTextFromRunResult(selfCheckResult) ?? "";
      info("message_sending parse_verdict", {
        sessionKey: binding.sessionKey,
        length: verdictText.length,
      });

      const parsedVerdict = parseVerdict(verdictText);
      const verdict: SelfCheckVerdict =
        parsedVerdict ??
        ({
          state: "blocked_external",
          progressHash: stableHash(verdictText || "invalid-self-check-verdict"),
          reason: "Self-check verdict was not valid JSON.",
          blockers: ["invalid self-check verdict"],
        } satisfies SelfCheckVerdict);
      if (!parsedVerdict) {
        info("message_sending verdict_invalid", {
          sessionKey: binding.sessionKey,
          nextPhase: "finalize",
        });
      }

      sameHashCount = verdict.progressHash === progressHash ? sameHashCount + 1 : 0;
      progressHash = verdict.progressHash;
      lastVerdict = verdict.state;
      info("message_sending verdict_parsed", {
        sessionKey: binding.sessionKey,
        verdictState: verdict.state,
        progressHash: verdict.progressHash,
        sameHashCount,
        attempts,
      });

      if (sameHashCount >= MAX_SAME_HASH || attempts >= MAX_ATTEMPTS) {
        const stopContent = buildStopPrompt(verdict, {
          ...selfCheckGate,
          sameHashCount,
        });
        info("message_sending stop", {
          sessionKey: binding.sessionKey,
          reason: sameHashCount >= MAX_SAME_HASH ? "same_hash_limit" : "attempt_limit",
          sameHashCount,
          attempts,
          nextPhase: "finalize",
        });
        await resetAndPersist("blocked_external");
        return resolveInlineDecision({
          canReplaceContent,
          originalContent,
          finalContent: stopContent,
          denyReason: "inline_release_not_supported_after_stop",
        });
      }

      if (verdict.state === "continue") {
        const continueIterations = Math.max(0, attempts - 1);
        if (continueIterations >= MAX_CONTINUE_ITERATIONS) {
          const stopContent = buildStopPrompt(
            {
              ...verdict,
              state: "blocked_external",
              reason:
                verdict.reason?.trim() || "Reached the maximum number of continuation iterations.",
              blockers: verdict.blockers?.length
                ? verdict.blockers
                : ["continuation iteration limit reached"],
            },
            {
              ...selfCheckGate,
              sameHashCount,
            },
          );
          info("message_sending stop", {
            sessionKey: binding.sessionKey,
            reason: "continue_iteration_limit",
            continueIterations,
            maxContinueIterations: MAX_CONTINUE_ITERATIONS,
            attempts,
            nextPhase: "finalize",
          });
          await resetAndPersist("blocked_external");
          return resolveInlineDecision({
            canReplaceContent,
            originalContent,
            finalContent: stopContent,
            denyReason: "inline_release_not_supported_after_continue_limit",
          });
        }
        const workGate: SelfCheckGateState = {
          armed: true,
          phase: "work",
          attempts,
          sameHashCount,
          progressHash: verdict.progressHash,
          lastVerdict: verdict.state,
          updatedAtMs: Date.now(),
        };
        info("message_sending phase_transition", {
          sessionKey: binding.sessionKey,
          from: selfCheckGate.phase,
          to: workGate.phase,
          verdictState: verdict.state,
          sameHashCount,
        });
        writeGateState(binding.entry, workGate);
        await persistBindingEntry(info, api, binding);

        info("message_sending schedule_followup", {
          kind: "continue",
          mode: "inline",
          sessionKey: binding.sessionKey,
          sessionId,
          nextAction: verdict.nextAction,
          messageThreadId,
        });
        const continueResult = await runInlineFollowupTurn(info, api, {
          kind: "continue",
          agentId: binding.agentId,
          sessionId,
          sessionKey: binding.sessionKey,
          channelId: TELEGRAM_CHANNEL_ID,
          accountId,
          messageThreadId,
          delayMs: SELF_CHECK_FOLLOWUP_DELAY_MS,
          prompt: buildContinuePrompt(verdict, workGate),
          runtimeSelection,
        });
        const nextCandidate = extractVisibleTextFromRunResult(continueResult);
        if (!nextCandidate) {
          const blockedContent = buildStopPrompt(
            {
              state: "blocked_external",
              progressHash: stableHash("missing-continue-output"),
              reason: "Continue turn produced no visible final content.",
              blockers: ["empty continue result"],
            },
            workGate,
          );
          info("message_sending stop", {
            sessionKey: binding.sessionKey,
            reason: "empty_continue_result",
            attempts,
            nextPhase: "finalize",
          });
          await resetAndPersist("blocked_external");
          return resolveInlineDecision({
            canReplaceContent,
            originalContent,
            finalContent: blockedContent,
            denyReason: "inline_release_not_supported_after_empty_continue",
          });
        }
        candidateContent = nextCandidate;
        continue;
      }

      info("message_sending release_final", {
        sessionKey: binding.sessionKey,
        verdictState: verdict.state,
        contentLength: candidateContent.length,
      });
      await resetAndPersist(verdict.state);
      return resolveInlineDecision({
        canReplaceContent,
        originalContent,
        finalContent: candidateContent,
        denyReason: "inline_terminal_replace_not_supported",
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "unknown";
    api.logger.warn(
      `self-check-gate: inline self-check failed sessionKey=${binding.sessionKey} error=${message}`,
    );
    await resetAndPersist();
    return { kind: "allow" };
  }
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
      const canReplaceContent = supportsInlineContentReplacement(hookEvent);
      info("message_sending binding", {
        sessionKey: binding.sessionKey,
        agentId: binding.agentId,
        armed: gate?.armed === true,
        phase: gate?.phase,
        canReplaceContent,
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
        const decision = await runInlineSelfCheckCycle(info, api, {
          binding,
          originalContent: content,
          canReplaceContent,
          runtimeSelection,
          accountId: hookCtx.accountId,
          messageThreadId:
            binding.entry.deliveryContext?.threadId ?? binding.entry.lastThreadId ?? undefined,
        });
        if (decision.kind === "allow") {
          info("message_sending allow", {
            reason: "inline_self_check_released",
            sessionKey: binding.sessionKey,
          });
          return;
        }
        if (decision.kind === "replace") {
          info("message_sending allow", {
            reason: "inline_self_check_replaced",
            sessionKey: binding.sessionKey,
            contentLength: decision.content.length,
          });
          return { content: decision.content };
        }
        info("message_sending cancel", {
          reason: decision.reason,
          sessionKey: binding.sessionKey,
        });
        return { cancel: true };
      }

      info("message_sending allow", {
        reason: "non_work_phase_passthrough",
        sessionKey: binding.sessionKey,
        phase: gate.phase,
      });
      return;
    });
  },
});

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
