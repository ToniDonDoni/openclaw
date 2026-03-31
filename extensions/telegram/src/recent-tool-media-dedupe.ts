const RECENT_MESSAGE_TOOL_MEDIA_TTL_MS = 2 * 60 * 1000;
const RECENT_MESSAGE_TOOL_MEDIA_MAX = 200;

type RecentMessageToolMediaEntry = {
  chatId: string;
  mediaUrl: string;
  expiresAt: number;
};

const RECENT_MESSAGE_TOOL_MEDIA_GLOBAL_KEY = Symbol.for("openclaw.telegram.recentMessageToolMedia");

function getRecentMessageToolMediaStore(): RecentMessageToolMediaEntry[] {
  const globalStore = globalThis as typeof globalThis & {
    [RECENT_MESSAGE_TOOL_MEDIA_GLOBAL_KEY]?: RecentMessageToolMediaEntry[];
  };
  const existing = globalStore[RECENT_MESSAGE_TOOL_MEDIA_GLOBAL_KEY];
  if (existing) {
    return existing;
  }
  const created: RecentMessageToolMediaEntry[] = [];
  globalStore[RECENT_MESSAGE_TOOL_MEDIA_GLOBAL_KEY] = created;
  return created;
}

function normalizeMediaForDedupe(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!trimmed.toLowerCase().startsWith("file://")) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") {
      return decodeURIComponent(parsed.pathname || "");
    }
  } catch {
    // Keep fallback below for non-URL-like inputs.
  }
  return trimmed.replace(/^file:\/\//i, "");
}

function pruneExpiredRecentMessageToolMedia(now: number): void {
  const recentMessageToolMedia = getRecentMessageToolMediaStore();
  for (let i = recentMessageToolMedia.length - 1; i >= 0; i -= 1) {
    if (recentMessageToolMedia[i]!.expiresAt <= now) {
      recentMessageToolMedia.splice(i, 1);
    }
  }
  if (recentMessageToolMedia.length > RECENT_MESSAGE_TOOL_MEDIA_MAX) {
    recentMessageToolMedia.splice(0, recentMessageToolMedia.length - RECENT_MESSAGE_TOOL_MEDIA_MAX);
  }
}

export function rememberRecentMessageToolMedia(params: {
  chatId: string;
  mediaUrl: string;
  now?: number;
}): void {
  const recentMessageToolMedia = getRecentMessageToolMediaStore();
  const mediaUrl = normalizeMediaForDedupe(params.mediaUrl);
  if (!params.chatId.trim() || !mediaUrl) {
    return;
  }
  const now = params.now ?? Date.now();
  pruneExpiredRecentMessageToolMedia(now);
  recentMessageToolMedia.push({
    chatId: params.chatId,
    mediaUrl,
    expiresAt: now + RECENT_MESSAGE_TOOL_MEDIA_TTL_MS,
  });
  pruneExpiredRecentMessageToolMedia(now);
}

export function consumeRecentMessageToolMediaDuplicates(params: {
  chatId: string;
  mediaUrls: string[];
  now?: number;
}): { keptMediaUrls: string[]; removedMediaUrls: string[] } {
  const recentMessageToolMedia = getRecentMessageToolMediaStore();
  if (!params.chatId.trim() || params.mediaUrls.length === 0) {
    return { keptMediaUrls: params.mediaUrls, removedMediaUrls: [] };
  }
  const now = params.now ?? Date.now();
  pruneExpiredRecentMessageToolMedia(now);
  const keptMediaUrls: string[] = [];
  const removedMediaUrls: string[] = [];
  for (const mediaUrl of params.mediaUrls) {
    const normalizedMediaUrl = normalizeMediaForDedupe(mediaUrl);
    if (!normalizedMediaUrl) {
      keptMediaUrls.push(mediaUrl);
      continue;
    }
    const matchIndex = recentMessageToolMedia.findIndex(
      (entry) => entry.chatId === params.chatId && entry.mediaUrl === normalizedMediaUrl,
    );
    if (matchIndex === -1) {
      keptMediaUrls.push(mediaUrl);
      continue;
    }
    recentMessageToolMedia.splice(matchIndex, 1);
    removedMediaUrls.push(mediaUrl);
  }
  return { keptMediaUrls, removedMediaUrls };
}

export function resetRecentMessageToolMediaForTests(): void {
  getRecentMessageToolMediaStore().length = 0;
}
