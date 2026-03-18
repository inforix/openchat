import type {
  BotCreateRequest,
  BotAccount,
  BotListResultPayload,
  MessageSendRequest,
  MessageSendResult,
  ProtocolErrorCode,
  SessionHistoryResultPayload,
  SessionSnapshotResultPayload,
  StreamEvent,
} from "@openchat/protocol";
import {
  BotListResultPayloadSchema,
  deriveBotId,
  SessionHistoryResultPayloadSchema,
  SessionSnapshotResultPayloadSchema,
} from "@openchat/protocol";
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

export type ArchivedSessionRecord = {
  sessionId: string;
  archivedAt: string;
  summary?: string;
};

export type HostSnapshotRecord = {
  host: HostRecord;
  bots: BotRecord[];
  sessions: Record<string, SessionRecord>;
  archivedSessionsByBot?: Record<string, ArchivedSessionRecord[]>;
  sessionRecordsById?: Record<string, SessionRecord>;
};

export type SessionSnapshotRecord = {
  bot: BotRecord;
  activeSession: SessionRecord | null;
  archivedSessions: ArchivedSessionRecord[];
  sessionRecords?: Record<string, SessionRecord>;
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
  archivedSessionsByBot: Record<string, ArchivedSessionRecord[]>;
  sessionRecordsById: Record<string, SessionRecord>;
};

type ProtocolSeed = {
  hosts: HostRecord[];
  selectedHostId?: string | null;
  botsByHost: Record<string, BotRecord[]>;
  sessionsByBot: Record<string, SessionRecord>;
  archivedSessionsByBot?: Record<string, ArchivedSessionRecord[]>;
  sessionRecordsById?: Record<string, SessionRecord>;
};

type MessageCommandHandlerResult = {
  result: MessageSendResult;
  stream?: AsyncIterable<StreamEvent>;
};

type RelayBotListEventMessage = {
  type: "relay.encrypted.event";
  event: {
    requestId: string;
    eventType: string;
    encryptedPayload: string;
  };
};

type RelaySessionSnapshotEventMessage = RelayBotListEventMessage;
type RelaySessionHistoryEventMessage = RelayBotListEventMessage;

type RelayHostSnapshotLoaderOptions = {
  relayHttpUrl: string;
  relayWebSocketUrl: string;
  deviceId: string;
  deviceCredential: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => unknown;
};

type RelayWebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

const listeners = new Set<() => void>();
const E2E_PROTOCOL_STORAGE_KEY = "__openchat_e2e_protocol_seed";

let state: ProtocolState = {
  hosts: [],
  selectedHostId: null,
  botsByHost: {},
  sessionsByBot: {},
  archivedSessionsByBot: {},
  sessionRecordsById: {},
};

let createBotHandler: (request: BotCreateRequest) => Promise<CreateBotResult> = async () => ({
  ok: false,
  errorCode: "bot_create_failed",
  message: "Host creation handler is not configured.",
});

let messageCommandHandler: (
  request: MessageSendRequest,
) => Promise<MessageCommandHandlerResult> = async (request) => ({
  result: {
    ok: false,
    code: "session_conflict",
    activeSessionId: request.targetSessionId,
    archivedSessions: [],
  },
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
  archivedSessionsByBot: {},
  sessionRecordsById: {},
});

const createDefaultSessionSnapshotLoader = (): ((
  hostId: string,
  accountId: string,
) => Promise<SessionSnapshotRecord>) => {
  return async (hostId, accountId) => {
    const bot = getVisibleBotsForHost(hostId).find(
      (candidate) => candidate.accountId === accountId,
    );
    const botKey = getBotCacheKey({ hostId, accountId });

    if (!bot) {
      throw new Error(`bot ${accountId} not found for host ${hostId}`);
    }

    return {
      bot,
      activeSession: state.sessionsByBot[botKey] ?? null,
      archivedSessions: state.archivedSessionsByBot[botKey] ?? [],
      sessionRecords: Object.entries(state.sessionRecordsById).reduce<Record<string, SessionRecord>>(
        (result, [key, session]) => {
          if (key.startsWith(`${hostId}:${accountId}:`)) {
            result[key] = session;
          }
          return result;
        },
        {},
      ),
    };
  };
};

let sessionSnapshotLoader: (
  hostId: string,
  accountId: string,
) => Promise<SessionSnapshotRecord> = createDefaultSessionSnapshotLoader();
let relaySessionSnapshotAutoSyncEnabled = false;
let sessionHistoryLoader: (
  hostId: string,
  accountId: string,
  sessionId: string,
) => Promise<SessionRecord | null> = async () => null;
let relaySessionHistoryAutoSyncEnabled = false;

const pendingNewSessionCommands = new Map<string, Promise<MessageSendResult>>();
let commandSequence = 0;

export function seedClientProtocol(input: ProtocolSeed): void {
  const sessionRecordsById = {
    ...(input.sessionRecordsById ?? {}),
  };

  for (const session of Object.values(input.sessionsByBot)) {
    sessionRecordsById[getSessionRecordKey(session)] = session;
  }

  state = {
    hosts: [...input.hosts],
    selectedHostId:
      input.selectedHostId ?? input.hosts[0]?.hostId ?? null,
    botsByHost: { ...input.botsByHost },
    sessionsByBot: { ...input.sessionsByBot },
    archivedSessionsByBot: { ...(input.archivedSessionsByBot ?? {}) },
    sessionRecordsById,
  };
  persistProtocolState();
  emitChange();
}

export function resetClientProtocol(): void {
  state = {
    hosts: [],
    selectedHostId: null,
    botsByHost: {},
    sessionsByBot: {},
    archivedSessionsByBot: {},
    sessionRecordsById: {},
  };
  createBotHandler = async () => ({
    ok: false,
    errorCode: "bot_create_failed",
    message: "Host creation handler is not configured.",
  });
  messageCommandHandler = async (request) => ({
    result: {
      ok: false,
      code: "session_conflict",
      activeSessionId: request.targetSessionId,
      archivedSessions: [],
    },
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
    archivedSessionsByBot: {},
    sessionRecordsById: {},
  });
  sessionSnapshotLoader = createDefaultSessionSnapshotLoader();
  relaySessionSnapshotAutoSyncEnabled = false;
  sessionHistoryLoader = async () => null;
  relaySessionHistoryAutoSyncEnabled = false;
  pendingNewSessionCommands.clear();
  commandSequence = 0;
  clearPersistedProtocolState();
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

export function installRelayHostSnapshotLoader(
  input: RelayHostSnapshotLoaderOptions,
): void {
  const fetchImpl = input.fetchImpl ?? fetch;
  const requestTimeoutMs = input.requestTimeoutMs ?? 5_000;
  const webSocketFactory =
    input.webSocketFactory ??
    ((url: string) => {
      if (typeof WebSocket === "undefined") {
        throw new Error("WebSocket is not available in this environment.");
      }
      return new WebSocket(url);
    });

  setHostSnapshotLoader(async (hostId) => {
    const currentHost = findHost(hostId) ?? {
      hostId,
      name: hostId,
      edgeKeyFingerprint: "unavailable",
      status: "offline" as const,
    };

    try {
      const authResponse = await fetchImpl(`${input.relayHttpUrl}/auth/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceId: input.deviceId,
          hostId,
          deviceCredential: input.deviceCredential,
        }),
      });
      const auth = (await authResponse.json()) as {
        ok: boolean;
        sessionToken?: string;
      };

      if (!authResponse.ok || !auth.ok || !auth.sessionToken) {
        return createOfflineHostSnapshot(currentHost);
      }

      const requestId = `relay-bot-list-${hostId}-${createCommandId()}`;
      const socket = webSocketFactory(
        `${input.relayWebSocketUrl}?role=client&sessionToken=${encodeURIComponent(auth.sessionToken)}`,
      ) as RelayWebSocketLike;
      const payload = await requestRelayBotList({
        socket,
        requestId,
        timeoutMs: requestTimeoutMs,
      });
      const existingBots = getVisibleBotsForHost(hostId);

      return {
        host: {
          ...currentHost,
          status: "online",
        },
        bots: payload.bots.map((bot) => {
          const existing =
            existingBots.find((candidate) => candidate.accountId === bot.accountId) ?? null;
          return toRelayBotRecord(bot, existing);
        }),
        sessions: {},
        archivedSessionsByBot: {},
        sessionRecordsById: {},
      };
    } catch {
      return createOfflineHostSnapshot(currentHost);
    }
  });
}

export function installRelaySessionSnapshotLoader(
  input: RelayHostSnapshotLoaderOptions,
): void {
  const fetchImpl = input.fetchImpl ?? fetch;
  const requestTimeoutMs = input.requestTimeoutMs ?? 5_000;
  const webSocketFactory =
    input.webSocketFactory ??
    ((url: string) => {
      if (typeof WebSocket === "undefined") {
        throw new Error("WebSocket is not available in this environment.");
      }
      return new WebSocket(url);
    });

  const loader = async (hostId: string, accountId: string) => {
    const fallbackSnapshot = await createDefaultSessionSnapshotLoader()(hostId, accountId);

    try {
      const authResponse = await fetchImpl(`${input.relayHttpUrl}/auth/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceId: input.deviceId,
          hostId,
          deviceCredential: input.deviceCredential,
        }),
      });
      const auth = (await authResponse.json()) as {
        ok: boolean;
        sessionToken?: string;
      };

      if (!authResponse.ok || !auth.ok || !auth.sessionToken) {
        return fallbackSnapshot;
      }

      const requestId = `relay-session-snapshot-${hostId}-${accountId}-${createCommandId()}`;
      const socket = webSocketFactory(
        `${input.relayWebSocketUrl}?role=client&sessionToken=${encodeURIComponent(auth.sessionToken)}`,
      ) as RelayWebSocketLike;
      const payload = await requestRelaySessionSnapshot({
        socket,
        requestId,
        accountId,
        timeoutMs: requestTimeoutMs,
      });
      const currentSession = getSessionForBot(hostId, accountId);
      const nextActiveSessionId = payload.activeSessionId ?? fallbackSnapshot.bot.activeSessionId;

      return {
        bot: {
          ...fallbackSnapshot.bot,
          activeSessionId: nextActiveSessionId,
        },
        activeSession:
          currentSession.session?.sessionId === payload.activeSessionId
            ? currentSession.session
            : null,
        archivedSessions: payload.archivedSessions,
        sessionRecords: fallbackSnapshot.sessionRecords,
      };
    } catch {
      return fallbackSnapshot;
    }
  };

  setSessionSnapshotLoader(loader);
  relaySessionSnapshotAutoSyncEnabled = true;
}

export function installRelaySessionHistoryLoader(
  input: RelayHostSnapshotLoaderOptions,
): void {
  const fetchImpl = input.fetchImpl ?? fetch;
  const requestTimeoutMs = input.requestTimeoutMs ?? 5_000;
  const webSocketFactory =
    input.webSocketFactory ??
    ((url: string) => {
      if (typeof WebSocket === "undefined") {
        throw new Error("WebSocket is not available in this environment.");
      }
      return new WebSocket(url);
    });

  setSessionHistoryLoader(async (hostId, accountId, sessionId) => {
    try {
      const authResponse = await fetchImpl(`${input.relayHttpUrl}/auth/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceId: input.deviceId,
          hostId,
          deviceCredential: input.deviceCredential,
        }),
      });
      const auth = (await authResponse.json()) as {
        ok: boolean;
        sessionToken?: string;
      };

      if (!authResponse.ok || !auth.ok || !auth.sessionToken) {
        return null;
      }

      const requestId = `relay-session-history-${hostId}-${accountId}-${sessionId}-${createCommandId()}`;
      const socket = webSocketFactory(
        `${input.relayWebSocketUrl}?role=client&sessionToken=${encodeURIComponent(auth.sessionToken)}`,
      ) as RelayWebSocketLike;
      const payload = await requestRelaySessionHistory({
        socket,
        requestId,
        accountId,
        sessionId,
        timeoutMs: requestTimeoutMs,
      });

      return {
        hostId,
        accountId,
        sessionId,
        title: payload.title,
        messages: payload.messages,
      };
    } catch {
      return null;
    }
  });
  relaySessionHistoryAutoSyncEnabled = true;
}

export function setMessageCommandHandler(
  handler: (request: MessageSendRequest) => Promise<MessageCommandHandlerResult>,
): void {
  messageCommandHandler = handler;
}

export function setSessionSnapshotLoader(
  loader: (hostId: string, accountId: string) => Promise<SessionSnapshotRecord>,
): void {
  sessionSnapshotLoader = loader;
  relaySessionSnapshotAutoSyncEnabled = false;
}

export function shouldAutoSyncSessionSnapshots(): boolean {
  return relaySessionSnapshotAutoSyncEnabled;
}

export function setSessionHistoryLoader(
  loader: (
    hostId: string,
    accountId: string,
    sessionId: string,
  ) => Promise<SessionRecord | null>,
): void {
  sessionHistoryLoader = loader;
  relaySessionHistoryAutoSyncEnabled = false;
}

export function shouldAutoSyncSessionHistory(): boolean {
  return relaySessionHistoryAutoSyncEnabled;
}

export function useClientShell(requestedHostId?: string) {
  const [snapshot, setSnapshot] = useState<ProtocolState>(() => getSnapshot());

  useEffect(() => {
    setSnapshot(getSnapshot());
    return subscribe(() => setSnapshot(getSnapshot()));
  }, []);
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
    sendMessageForBot,
    getBotById: (hostId: string, botId: string) => getBotById(hostId, botId, snapshot),
    getSessionForBot: (hostId: string, accountId: string) =>
      getSessionForBot(hostId, accountId, snapshot),
    getSessionRecordById: (hostId: string, accountId: string, sessionId: string) =>
      getSessionRecordById(hostId, accountId, sessionId, snapshot),
    getArchivedSessionsForBot: (hostId: string, accountId: string) =>
      getArchivedSessionsForBot(hostId, accountId, snapshot),
  };
}

export function selectHost(hostId: string): void {
  state = {
    ...state,
    selectedHostId: hostId,
  };
  persistProtocolState();
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
  persistProtocolState();
  cacheHostBotsSnapshot(input.hostId, state.botsByHost[input.hostId]);
  emitChange();
  return result;
}

export async function reconnectHost(hostId: string): Promise<void> {
  const snapshot = await hostSnapshotLoader(hostId);
  const sessionsByBot = { ...state.sessionsByBot };
  const sessionRecordsById = { ...state.sessionRecordsById };
  const archivedSessionsByBot = {
    ...state.archivedSessionsByBot,
    ...(snapshot.archivedSessionsByBot ?? {}),
  };

  for (const [cacheKey, session] of Object.entries(snapshot.sessions)) {
    sessionsByBot[cacheKey] = session;
    sessionRecordsById[getSessionRecordKey(session)] = session;
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
    archivedSessionsByBot,
    sessionRecordsById: {
      ...sessionRecordsById,
      ...(snapshot.sessionRecordsById ?? {}),
    },
  };

  persistProtocolState();
  cacheHostBotsSnapshot(hostId, snapshot.bots);
  emitChange();
}

export async function syncSessionForBot(
  hostId: string,
  accountId: string,
): Promise<void> {
  await refreshSessionState(hostId, accountId);
}

export async function syncSessionTranscript(
  hostId: string,
  accountId: string,
  sessionId: string,
): Promise<boolean> {
  const nextSession = await sessionHistoryLoader(hostId, accountId, sessionId);
  if (!nextSession) {
    return false;
  }

  const botKey = getBotCacheKey({ hostId, accountId });
  const activeBot = (state.botsByHost[hostId] ?? []).find(
    (bot) => bot.accountId === accountId,
  );
  const sessionsByBot =
    state.sessionsByBot[botKey]?.sessionId === sessionId ||
    activeBot?.activeSessionId === sessionId
      ? {
          ...state.sessionsByBot,
          [botKey]: nextSession,
        }
      : state.sessionsByBot;
  const sessionRecordsById = {
    ...state.sessionRecordsById,
    [getSessionRecordKey(nextSession)]: nextSession,
  };

  state = {
    ...state,
    sessionsByBot,
    sessionRecordsById,
  };

  if (activeBot?.activeSessionId === sessionId) {
    cacheBotSessionSnapshot(
      {
        hostId,
        accountId,
      },
      nextSession,
    );
  }

  persistProtocolState();
  emitChange();
  return true;
}

export async function sendMessageForBot(input: {
  hostId: string;
  accountId: string;
  text: string;
}): Promise<MessageSendResult> {
  const host = findHost(input.hostId);
  const bot = getVisibleBotsForHost(input.hostId).find(
    (candidate) => candidate.accountId === input.accountId,
  );

  if (!host || !bot) {
    return {
      ok: false,
      code: "session_conflict",
      activeSessionId: null,
      archivedSessions: [],
    };
  }

  if (host.status === "offline") {
    return {
      ok: false,
      code: "offline_read_only",
      activeSessionId: bot.activeSessionId,
      archivedSessions: getArchivedSessionsForBot(input.hostId, input.accountId),
    };
  }

  const trimmed = input.text.trim();
  const targetSessionId = bot.activeSessionId;
  const botKey = getBotCacheKey({
    hostId: input.hostId,
    accountId: input.accountId,
  });

  if (trimmed === "/new") {
    const existing = pendingNewSessionCommands.get(botKey);
    if (existing) {
      return existing;
    }

    const commandId = createCommandId();
    const promise = performSend({
      hostId: input.hostId,
      accountId: input.accountId,
      text: input.text,
      targetSessionId,
      payload: {
        kind: "systemCommand",
        command: {
          type: "session.new",
          expectedActiveSessionId: targetSessionId,
          commandId,
        },
      },
    }).finally(() => {
      pendingNewSessionCommands.delete(botKey);
    });

    pendingNewSessionCommands.set(botKey, promise);
    return promise;
  }

  return performSend({
    hostId: input.hostId,
    accountId: input.accountId,
    text: input.text,
    targetSessionId,
    payload: {
      kind: "userMessage",
      text: input.text,
    },
  });
}

async function performSend(input: {
  hostId: string;
  accountId: string;
  targetSessionId: string;
  text: string;
  payload: MessageSendRequest["payload"];
}): Promise<MessageSendResult> {
  const response = await messageCommandHandler({
    requestId: `message-${input.hostId}-${input.accountId}-${createCommandId()}`,
    hostId: input.hostId,
    accountId: input.accountId,
    targetSessionId: input.targetSessionId,
    payload: input.payload,
  });

  if (!response.result.ok) {
    if (response.result.code === "session_conflict") {
      await refreshSessionState(input.hostId, input.accountId);
    } else {
      syncArchivedSessions(input.hostId, input.accountId, response.result.archivedSessions);
    }
    return response.result;
  }

  syncArchivedSessions(input.hostId, input.accountId, response.result.archivedSessions);

  if (input.payload.kind === "userMessage") {
    appendConfirmedUserMessage(
      input.hostId,
      input.accountId,
      input.targetSessionId,
      input.text,
    );
    if (response.stream) {
      await applyStreamEvents(
        input.hostId,
        input.accountId,
        input.targetSessionId,
        response.stream,
      );
    }
    return response.result;
  }

  await refreshSessionState(input.hostId, input.accountId);
  return response.result;
}

async function refreshSessionState(hostId: string, accountId: string): Promise<void> {
  const snapshot = await sessionSnapshotLoader(hostId, accountId);
  const botKey = getBotCacheKey({ hostId, accountId });
  const nextBots = (state.botsByHost[hostId] ?? []).map((candidate) =>
    candidate.accountId === accountId ? snapshot.bot : candidate,
  );
  const sessionRecordsById = {
    ...state.sessionRecordsById,
    ...(snapshot.sessionRecords ?? {}),
  };

  if (snapshot.activeSession) {
    sessionRecordsById[getSessionRecordKey(snapshot.activeSession)] = snapshot.activeSession;
    cacheBotSessionSnapshot(
      {
        hostId,
        accountId,
      },
      snapshot.activeSession,
    );
  }

  state = {
    ...state,
    botsByHost: {
      ...state.botsByHost,
      [hostId]: nextBots,
    },
    sessionsByBot:
      snapshot.activeSession === null
        ? Object.fromEntries(
            Object.entries(state.sessionsByBot).filter(([key]) => key !== botKey),
          )
        : {
            ...state.sessionsByBot,
            [botKey]: snapshot.activeSession,
          },
    archivedSessionsByBot: {
      ...state.archivedSessionsByBot,
      [botKey]: snapshot.archivedSessions,
    },
    sessionRecordsById,
  };

  persistProtocolState();
  cacheHostBotsSnapshot(hostId, nextBots);
  emitChange();
}

async function applyStreamEvents(
  hostId: string,
  accountId: string,
  sessionId: string,
  stream: AsyncIterable<StreamEvent>,
): Promise<void> {
  const assistantMessageId = `${sessionId}-assistant-stream`;

  updateSessionRecord(hostId, accountId, sessionId, (session) => ({
    ...session,
    messages: [
      ...session.messages,
      {
        id: assistantMessageId,
        role: "assistant",
        text: "",
      },
    ],
  }));

  for await (const event of stream) {
    if (event.type === "chunk") {
      updateSessionRecord(hostId, accountId, sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                text: `${message.text}${event.delta}`,
              }
            : message,
        ),
      }));
      continue;
    }

    if (event.type === "error") {
      updateSessionRecord(hostId, accountId, sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                role: "system",
                text: event.message,
              }
            : message,
        ),
      }));
    }
  }
}

function appendConfirmedUserMessage(
  hostId: string,
  accountId: string,
  sessionId: string,
  text: string,
): void {
  updateSessionRecord(hostId, accountId, sessionId, (session) => ({
    ...session,
    messages: [
      ...session.messages,
      {
        id: `${sessionId}-user-${session.messages.length + 1}`,
        role: "user",
        text,
      },
    ],
  }));
}

function getSnapshot(): ProtocolState {
  hydrateProtocolStateFromStorage();
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

function createOfflineHostSnapshot(host: HostRecord): HostSnapshotRecord {
  return {
    host: {
      ...host,
      status: "offline",
    },
    bots: getVisibleBotsForHost(host.hostId),
    sessions: {},
    archivedSessionsByBot: {},
    sessionRecordsById: {},
  };
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

function getArchivedSessionsForBot(
  hostId: string,
  accountId: string,
  snapshot = state,
): ArchivedSessionRecord[] {
  const cacheKey = getBotCacheKey({ hostId, accountId });
  return snapshot.archivedSessionsByBot[cacheKey] ?? [];
}

function getSessionRecordById(
  hostId: string,
  accountId: string,
  sessionId: string,
  snapshot = state,
): SessionRecord | null {
  return snapshot.sessionRecordsById[`${hostId}:${accountId}:${sessionId}`] ?? null;
}

function updateSessionRecord(
  hostId: string,
  accountId: string,
  sessionId: string,
  updater: (session: SessionRecord) => SessionRecord,
): void {
  const existing =
    getSessionRecordById(hostId, accountId, sessionId) ??
    state.sessionsByBot[getBotCacheKey({ hostId, accountId })];

  if (!existing) {
    return;
  }

  const nextSession = updater(existing);
  const sessionRecordsById = {
    ...state.sessionRecordsById,
    [getSessionRecordKey(nextSession)]: nextSession,
  };
  const botKey = getBotCacheKey({ hostId, accountId });
  const sessionsByBot =
    state.sessionsByBot[botKey]?.sessionId === sessionId
      ? {
          ...state.sessionsByBot,
          [botKey]: nextSession,
        }
      : state.sessionsByBot;

  state = {
    ...state,
    sessionsByBot,
    sessionRecordsById,
  };

  persistProtocolState();
  cacheBotSessionSnapshot(
    {
      hostId,
      accountId,
    },
    nextSession,
  );
  emitChange();
}

function syncArchivedSessions(
  hostId: string,
  accountId: string,
  archivedSessions: ArchivedSessionRecord[],
): void {
  const botKey = getBotCacheKey({ hostId, accountId });
  state = {
    ...state,
    archivedSessionsByBot: {
      ...state.archivedSessionsByBot,
      [botKey]: archivedSessions,
    },
  };
  persistProtocolState();
  emitChange();
}

function getSessionRecordKey(session: SessionRecord): string {
  return `${session.hostId}:${session.accountId}:${session.sessionId}`;
}

function createCommandId(): string {
  commandSequence += 1;
  return `cmd-${commandSequence}`;
}

function toRelayBotRecord(bot: BotAccount, existing: BotRecord | null): BotRecord {
  return {
    ...bot,
    title: existing?.title ?? bot.accountId,
    backing: "openclaw",
  };
}

async function requestRelayBotList(input: {
  socket: RelayWebSocketLike;
  requestId: string;
  timeoutMs: number;
}): Promise<BotListResultPayload> {
  const socket = input.socket;
  await waitForSocketOpen(socket);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(() => {
        socket.close();
        reject(new Error("Relay bot list request timed out."));
      });
    }, input.timeoutMs);

    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      action();
    };

    socket.onmessage = (event) => {
      let payload: RelayBotListEventMessage;
      try {
        payload = JSON.parse(readSocketDataAsText(event.data)) as RelayBotListEventMessage;
      } catch {
        return;
      }

      if (
        payload.type !== "relay.encrypted.event" ||
        payload.event.requestId !== input.requestId ||
        payload.event.eventType !== "edge.bot.list.result"
      ) {
        return;
      }

      try {
        const botListPayload = BotListResultPayloadSchema.parse(
          JSON.parse(payload.event.encryptedPayload) as BotListResultPayload,
        );
        finish(() => {
          socket.close();
          resolve(botListPayload);
        });
      } catch (error) {
        finish(() => {
          socket.close();
          reject(error);
        });
      }
    };

    socket.onerror = () => {
      finish(() => {
        socket.close();
        reject(new Error("Unable to reach relay websocket."));
      });
    };

    socket.onclose = () => {
      finish(() => {
        reject(new Error("Relay websocket closed before bot list arrived."));
      });
    };

    socket.send(
      JSON.stringify({
        type: "client.bot.list.request",
        requestId: input.requestId,
      }),
    );
  });
}

async function requestRelaySessionSnapshot(input: {
  socket: RelayWebSocketLike;
  requestId: string;
  accountId: string;
  timeoutMs: number;
}): Promise<SessionSnapshotResultPayload> {
  const socket = input.socket;
  await waitForSocketOpen(socket);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(() => {
        socket.close();
        reject(new Error("Relay session snapshot request timed out."));
      });
    }, input.timeoutMs);

    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      action();
    };

    socket.onmessage = (event) => {
      let payload: RelaySessionSnapshotEventMessage;
      try {
        payload = JSON.parse(readSocketDataAsText(event.data)) as RelaySessionSnapshotEventMessage;
      } catch {
        return;
      }

      if (
        payload.type !== "relay.encrypted.event" ||
        payload.event.requestId !== input.requestId ||
        payload.event.eventType !== "edge.session.snapshot.result"
      ) {
        return;
      }

      try {
        const sessionSnapshotPayload = SessionSnapshotResultPayloadSchema.parse(
          JSON.parse(payload.event.encryptedPayload) as SessionSnapshotResultPayload,
        );

        if (sessionSnapshotPayload.accountId !== input.accountId) {
          throw new Error("Relay session snapshot account mismatch.");
        }

        finish(() => {
          socket.close();
          resolve(sessionSnapshotPayload);
        });
      } catch (error) {
        finish(() => {
          socket.close();
          reject(error);
        });
      }
    };

    socket.onerror = () => {
      finish(() => {
        socket.close();
        reject(new Error("Unable to reach relay websocket."));
      });
    };

    socket.onclose = () => {
      finish(() => {
        reject(new Error("Relay websocket closed before session snapshot arrived."));
      });
    };

    socket.send(
      JSON.stringify({
        type: "client.session.snapshot.request",
        requestId: input.requestId,
        accountId: input.accountId,
      }),
    );
  });
}

async function requestRelaySessionHistory(input: {
  socket: RelayWebSocketLike;
  requestId: string;
  accountId: string;
  sessionId: string;
  timeoutMs: number;
}): Promise<SessionHistoryResultPayload> {
  const socket = input.socket;
  await waitForSocketOpen(socket);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(() => {
        socket.close();
        reject(new Error("Relay session history request timed out."));
      });
    }, input.timeoutMs);

    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      action();
    };

    socket.onmessage = (event) => {
      let payload: RelaySessionHistoryEventMessage;
      try {
        payload = JSON.parse(readSocketDataAsText(event.data)) as RelaySessionHistoryEventMessage;
      } catch {
        return;
      }

      if (
        payload.type !== "relay.encrypted.event" ||
        payload.event.requestId !== input.requestId ||
        payload.event.eventType !== "edge.session.history.result"
      ) {
        return;
      }

      try {
        const sessionHistoryPayload = SessionHistoryResultPayloadSchema.parse(
          JSON.parse(payload.event.encryptedPayload) as SessionHistoryResultPayload,
        );

        if (
          sessionHistoryPayload.accountId !== input.accountId ||
          sessionHistoryPayload.sessionId !== input.sessionId
        ) {
          throw new Error("Relay session history identity mismatch.");
        }

        finish(() => {
          socket.close();
          resolve(sessionHistoryPayload);
        });
      } catch (error) {
        finish(() => {
          socket.close();
          reject(error);
        });
      }
    };

    socket.onerror = () => {
      finish(() => {
        socket.close();
        reject(new Error("Unable to reach relay websocket."));
      });
    };

    socket.onclose = () => {
      finish(() => {
        reject(new Error("Relay websocket closed before session history arrived."));
      });
    };

    socket.send(
      JSON.stringify({
        type: "client.session.history.request",
        requestId: input.requestId,
        accountId: input.accountId,
        sessionId: input.sessionId,
      }),
    );
  });
}

async function waitForSocketOpen(socket: RelayWebSocketLike): Promise<void> {
  if (socket.readyState === 1) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      socket.onopen = null;
      socket.onerror = null;
      resolve();
    };
    const handleError = () => {
      socket.onopen = null;
      socket.onerror = null;
      reject(new Error("Unable to open relay websocket."));
    };

    socket.onopen = handleOpen;
    socket.onerror = handleError;
  });
}

function readSocketDataAsText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  return String(data);
}

export function botRouteId(input: { hostId: string; accountId: string }): string {
  return deriveBotId(input);
}

function persistProtocolState(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(E2E_PROTOCOL_STORAGE_KEY, JSON.stringify(state));
}

function clearPersistedProtocolState(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(E2E_PROTOCOL_STORAGE_KEY);
}

function hydrateProtocolStateFromStorage(): void {
  if (
    typeof window === "undefined" ||
    state.hosts.length > 0 ||
    state.selectedHostId !== null
  ) {
    return;
  }

  const raw = window.sessionStorage.getItem(E2E_PROTOCOL_STORAGE_KEY);

  if (!raw) {
    return;
  }

  state = JSON.parse(raw) as ProtocolState;
}
