import type { BotRecord, SessionRecord } from "./client-protocol";

type CachedBotList = {
  cachedAt: string;
  bots: BotRecord[];
};

type CachedSession = {
  cachedAt: string;
  session: SessionRecord;
};

const hostBotsCache = new Map<string, CachedBotList>();
const botSessionCache = new Map<string, CachedSession>();

export function getBotCacheKey(input: { hostId: string; accountId: string }): string {
  return `${encodeURIComponent(input.hostId)}:${encodeURIComponent(input.accountId)}`;
}

export function cacheHostBotsSnapshot(hostId: string, bots: BotRecord[]): void {
  hostBotsCache.set(hostId, {
    cachedAt: new Date().toISOString(),
    bots: [...bots],
  });
}

export function readHostBotsSnapshot(hostId: string): CachedBotList | null {
  return hostBotsCache.get(hostId) ?? null;
}

export function cacheBotSessionSnapshot(
  input: { hostId: string; accountId: string },
  session: SessionRecord,
): void {
  botSessionCache.set(getBotCacheKey(input), {
    cachedAt: new Date().toISOString(),
    session,
  });
}

export function readBotSessionSnapshot(input: {
  hostId: string;
  accountId: string;
}): CachedSession | null {
  return botSessionCache.get(getBotCacheKey(input)) ?? null;
}

export function clearOfflineCache(): void {
  hostBotsCache.clear();
  botSessionCache.clear();
}
