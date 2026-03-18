import type { BotCreateRequest, BotAccount, ProtocolErrorCode } from "@openchat/protocol";
import { deriveBotId } from "@openchat/protocol";
import { useEffect, useState } from "react";

import {
  cacheBotSessionSnapshot,
  cacheHostBotsSnapshot,
  getBotCacheKey,
  readBotSessionSnapshot,
  readHostBotsSnapshot,
} from "./offline-cache";

export type HostRecord = {
  hostId: string;
  name: string;
  edgeKeyFingerprint: string;
  status: "online" | "offline";
};

export type BotRecord = BotAccount & {
  title: string;
  backing: "openclaw";
};

export type SessionRecord = {
  hostId: string;
  accountId: string;
  sessionId: string;
  title: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
  }>;
};

export type HostSnapshotRecord = {
  host: HostRecord;
  bots: BotRecord[];
  sessions: Record<string, SessionRecord>;
};

export type CreateBotResult =
  | {
      ok: true;
      bot: BotRecord;
    }
  | {
      ok: false;
      errorCode: ProtocolErrorCode;
      message: string;
    };

type ProtocolState = {
  hosts: HostRecord[];
  selectedHostId: string | null;
  botsByHost: Record<string, BotRecord[]>;
  sessionsByBot: Record<string, SessionRecord>;
};

type ProtocolSeed = {
  hosts: HostRecord[];
  selectedHostId?: string | null;
  botsByHost: Record<string, BotRecord[]>;
  sessionsByBot: Record<string, SessionRecord>;
};

const listeners = new Set<() => void>();

let state: ProtocolState = {
  hosts: [],
  selectedHostId: null,
  botsByHost: {},
  sessionsByBot: {},
};

let createBotHandler: (request: BotCreateRequest) => Promise<CreateBotResult> = async () => ({
  ok: false,
  errorCode: "bot_create_failed",
  message: "Host creation handler is not configured.",
});

let hostSnapshotLoader: (hostId: string) => Promise<HostSnapshotRecord> = async (hostId) => ({
  host:
    findHost(hostId) ??
    ({
      hostId,
      name: hostId,
      edgeKeyFingerprint: "unavailable",
      status: "online",
    } satisfies HostRecord),
  bots: getVisibleBotsForHost(hostId),
  sessions: getVisibleBotsForHost(hostId).reduce<Record<string, SessionRecord>>(
    (result, bot) => {
      const session = state.sessionsByBot[getBotCacheKey(bot)];
      if (session) {
        result[getBotCacheKey(bot)] = session;
      }
      return result;
    },
    {},
  ),
});

export function seedClientProtocol(input: ProtocolSeed): void {
  state = {
    hosts: [...input.hosts],
    selectedHostId:
      input.selectedHostId ?? input.hosts[0]?.hostId ?? null,
    botsByHost: { ...input.botsByHost },
    sessionsByBot: { ...input.sessionsByBot },
  };
  emitChange();
}

export function resetClientProtocol(): void {
  state = {
    hosts: [],
    selectedHostId: null,
    botsByHost: {},
    sessionsByBot: {},
  };
  createBotHandler = async () => ({
    ok: false,
    errorCode: "bot_create_failed",
    message: "Host creation handler is not configured.",
  });
  hostSnapshotLoader = async (hostId) => ({
    host:
      findHost(hostId) ??
      ({
        hostId,
        name: hostId,
        edgeKeyFingerprint: "unavailable",
        status: "online",
      } satisfies HostRecord),
    bots: [],
    sessions: {},
  });
  emitChange();
}

export function setCreateBotHandler(
  handler: (request: BotCreateRequest) => Promise<CreateBotResult>,
): void {
  createBotHandler = handler;
}

export function setHostSnapshotLoader(
  loader: (hostId: string) => Promise<HostSnapshotRecord>,
): void {
  hostSnapshotLoader = loader;
}

export function useClientShell(requestedHostId?: string) {
  const [snapshot, setSnapshot] = useState<ProtocolState>(() => getSnapshot());

  useEffect(() => subscribe(() => setSnapshot(getSnapshot())), []);
  const selectedHostId =
    requestedHostId ?? snapshot.selectedHostId ?? snapshot.hosts[0]?.hostId ?? null;
  const host = selectedHostId ? findHost(selectedHostId, snapshot) : null;
  const bots = selectedHostId ? getVisibleBotsForHost(selectedHostId, snapshot) : [];

  return {
    hosts: snapshot.hosts,
    selectedHostId,
    host,
    bots,
    selectHost,
    reconnectHost,
    createBotForHost,
    getBotById: (hostId: string, botId: string) => getBotById(hostId, botId, snapshot),
    getSessionForBot: (hostId: string, accountId: string) =>
      getSessionForBot(hostId, accountId, snapshot),
  };
}

export function selectHost(hostId: string): void {
  state = {
    ...state,
    selectedHostId: hostId,
  };
  emitChange();
}

export async function createBotForHost(input: {
  hostId: string;
  accountId: string;
  agentId: string;
}): Promise<CreateBotResult> {
  const host = findHost(input.hostId);

  if (!host) {
    return {
      ok: false,
      errorCode: "bot_create_failed",
      message: "Host not found.",
    };
  }

  if (host.status === "offline") {
    return {
      ok: false,
      errorCode: "offline_read_only",
      message: "Host offline. Cached views are read-only.",
    };
  }

  const result = await createBotHandler({
    requestId: `create-${input.hostId}-${input.accountId}`,
    hostId: input.hostId,
    accountId: input.accountId,
    agentId: input.agentId,
  });

  if (!result.ok) {
    return result;
  }

  const existingBots = state.botsByHost[input.hostId] ?? [];
  state = {
    ...state,
    botsByHost: {
      ...state.botsByHost,
      [input.hostId]: [...existingBots, result.bot],
    },
  };
  cacheHostBotsSnapshot(input.hostId, state.botsByHost[input.hostId]);
  emitChange();
  return result;
}

export async function reconnectHost(hostId: string): Promise<void> {
  const snapshot = await hostSnapshotLoader(hostId);
  const sessionsByBot = { ...state.sessionsByBot };

  for (const [cacheKey, session] of Object.entries(snapshot.sessions)) {
    sessionsByBot[cacheKey] = session;
    cacheBotSessionSnapshot(
      {
        hostId: session.hostId,
        accountId: session.accountId,
      },
      session,
    );
  }

  state = {
    ...state,
    hosts: state.hosts.map((host) =>
      host.hostId === hostId ? snapshot.host : host,
    ),
    botsByHost: {
      ...state.botsByHost,
      [hostId]: snapshot.bots,
    },
    sessionsByBot,
  };

  cacheHostBotsSnapshot(hostId, snapshot.bots);
  emitChange();
}

function getSnapshot(): ProtocolState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function findHost(hostId: string, snapshot = state): HostRecord | null {
  return snapshot.hosts.find((host) => host.hostId === hostId) ?? null;
}

function getVisibleBotsForHost(hostId: string, snapshot = state): BotRecord[] {
  const host = findHost(hostId, snapshot);

  if (!host) {
    return [];
  }

  if (host.status === "offline") {
    return readHostBotsSnapshot(hostId)?.bots ?? snapshot.botsByHost[hostId] ?? [];
  }

  return snapshot.botsByHost[hostId] ?? [];
}

function getBotById(
  hostId: string,
  botId: string,
  snapshot = state,
): BotRecord | null {
  return (
    getVisibleBotsForHost(hostId, snapshot).find((bot) => bot.botId === botId) ?? null
  );
}

function getSessionForBot(
  hostId: string,
  accountId: string,
  snapshot = state,
): { session: SessionRecord | null; fromCache: boolean } {
  const host = findHost(hostId, snapshot);
  const cacheKey = getBotCacheKey({ hostId, accountId });

  if (host?.status === "offline") {
    const cachedSession = readBotSessionSnapshot({ hostId, accountId })?.session ?? null;
    return {
      session: cachedSession,
      fromCache: cachedSession !== null,
    };
  }

  return {
    session: snapshot.sessionsByBot[cacheKey] ?? null,
    fromCache: false,
  };
}

export function botRouteId(input: { hostId: string; accountId: string }): string {
  return deriveBotId(input);
}
