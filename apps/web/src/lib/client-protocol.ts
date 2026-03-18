import type {
  BotCreateRequest,
  BotAccount,
  MessageSendRequest,
  MessageSendResult,
  ProtocolErrorCode,
  StreamEvent,
} from "@openchat/protocol";
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

export function setMessageCommandHandler(
  handler: (request: MessageSendRequest) => Promise<MessageCommandHandlerResult>,
): void {
  messageCommandHandler = handler;
}

export function setSessionSnapshotLoader(
  loader: (hostId: string, accountId: string) => Promise<SessionSnapshotRecord>,
): void {
  sessionSnapshotLoader = loader;
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
