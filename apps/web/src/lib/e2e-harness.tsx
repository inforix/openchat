"use client";

import { buildBotAccount, type MessageSendRequest, type StreamEvent } from "@openchat/protocol";
import { useEffect } from "react";

import {
  resetClientProtocol,
  seedClientProtocol,
  setCreateBotHandler,
  setHostSnapshotLoader,
  setMessageCommandHandler,
  setSessionSnapshotLoader,
  type ArchivedSessionRecord,
  type BotRecord,
  type CreateBotResult,
  type HostRecord,
  type SessionRecord,
} from "./client-protocol";
import { resetDeviceStore, trustHost, getTrustedHost } from "./device-store";
import {
  cacheBotSessionSnapshot,
  cacheHostBotsSnapshot,
  clearOfflineCache,
  getBotCacheKey,
} from "./offline-cache";

type ScenarioMessage = SessionRecord["messages"][number];

type ScenarioArchivedSession = ArchivedSessionRecord & {
  messages: ScenarioMessage[];
};

type ScenarioBot = {
  accountId: string;
  agentId: string;
  title: string;
  activeSessionId: string;
  activeMessages: ScenarioMessage[];
  archivedSessions: ScenarioArchivedSession[];
};

type ScenarioHost = HostRecord & {
  bots: ScenarioBot[];
};

type OpenChatE2EScenario = {
  hosts: ScenarioHost[];
};

type OpenChatE2EApi = {
  installScenario: (scenario: OpenChatE2EScenario) => void;
  trustHost: (hostId: string) => void;
  setHostStatus: (hostId: string, status: "online" | "offline", syncClient?: boolean) => void;
  setCreateBotMode: (hostId: string, mode: "instant" | "deferred") => void;
  resolvePendingCreate: (input: {
    hostId: string;
    accountId: string;
    title?: string;
    syncClient?: boolean;
  }) => void;
  addAuthoritativeBot: (input: {
    hostId: string;
    accountId: string;
    agentId: string;
    title: string;
    assistantText?: string;
    syncClient?: boolean;
  }) => void;
  setAuthoritativeSession: (input: {
    hostId: string;
    accountId: string;
    sessionId: string;
    assistantText: string;
    syncClient?: boolean;
  }) => void;
  getTrustedFingerprint: (hostId: string) => string | null;
};

declare global {
  interface Window {
    __openchatE2E?: OpenChatE2EApi;
  }
}

let scenarioState: OpenChatE2EScenario = {
  hosts: [],
};

const SCENARIO_STORAGE_KEY = "__openchat_e2e_scenario";
const createBotModes = new Map<string, "instant" | "deferred">();
const pendingBotCreates = new Map<
  string,
  {
    request: {
      hostId: string;
      accountId: string;
      agentId: string;
    };
    resolve: (result: CreateBotResult) => void;
  }
>();

export function OpenChatE2EHarness() {
  useEffect(() => {
    window.__openchatE2E = {
      installScenario,
      trustHost: (hostId) => {
        const host = scenarioState.hosts.find((candidate) => candidate.hostId === hostId);
        if (!host) {
          throw new Error(`unknown host ${hostId}`);
        }
        trustHost(hostId, host.edgeKeyFingerprint);
      },
      setHostStatus,
      setCreateBotMode,
      resolvePendingCreate,
      addAuthoritativeBot,
      setAuthoritativeSession,
      getTrustedFingerprint: (hostId) => getTrustedHost(hostId)?.edgeKeyFingerprint ?? null,
    };

    queueMicrotask(() => {
      restoreScenarioFromStorage();
    });

    return () => {
      delete window.__openchatE2E;
    };
  }, []);

  return null;
}

function installScenario(input: OpenChatE2EScenario): void {
  scenarioState = structuredClone(input);
  createBotModes.clear();
  pendingBotCreates.clear();
  clearOfflineCache();
  resetDeviceStore();
  resetClientProtocol();
  configureHandlers();
  syncClientFromScenario();
  persistScenario();
}

function configureHandlers(): void {
  setCreateBotHandler(async ({ hostId, accountId, agentId }) => {
    const host = requireHost(hostId);
    if (host.status === "offline") {
      return {
        ok: false,
        errorCode: "offline_read_only",
        message: "Host offline. Cached views are read-only.",
      };
    }

    if (getCreateBotMode(hostId) === "deferred") {
      return await new Promise<CreateBotResult>((resolve) => {
        pendingBotCreates.set(pendingBotCreateKey(hostId, accountId), {
          request: {
            hostId,
            accountId,
            agentId,
          },
          resolve,
        });
      });
    }

    const bot = createScenarioBot({
      accountId,
      agentId,
      title: accountId,
      assistantText: `Ready on ${accountId}.`,
    });
    host.bots.push(bot);
    persistScenario();
    return {
      ok: true,
      bot: toBotRecord(host, bot),
    };
  });

  setHostSnapshotLoader(async (hostId) => toHostSnapshot(requireHost(hostId)));

  setSessionSnapshotLoader(async (hostId, accountId) => {
    const host = requireHost(hostId);
    const bot = requireBot(host, accountId);
    return {
      bot: toBotRecord(host, bot),
      activeSession: toActiveSessionRecord(host, bot),
      archivedSessions: bot.archivedSessions.map(({ messages: _messages, ...archivedSession }) => archivedSession),
      sessionRecords: bot.archivedSessions.reduce<Record<string, SessionRecord>>((result, archivedSession) => {
        result[sessionRecordKey(host.hostId, bot.accountId, archivedSession.sessionId)] =
          toArchivedSessionRecord(host, bot, archivedSession);
        return result;
      }, {}),
    };
  });

  setMessageCommandHandler(async (request) => handleMessage(request));
}

function syncClientFromScenario(): void {
  const hosts = scenarioState.hosts.map<HostRecord>((host) => ({
    hostId: host.hostId,
    name: host.name,
    edgeKeyFingerprint: host.edgeKeyFingerprint,
    status: host.status,
  }));
  const botsByHost: Record<string, BotRecord[]> = {};
  const sessionsByBot: Record<string, SessionRecord> = {};
  const archivedSessionsByBot: Record<string, ArchivedSessionRecord[]> = {};
  const sessionRecordsById: Record<string, SessionRecord> = {};

  for (const host of scenarioState.hosts) {
    botsByHost[host.hostId] = host.bots.map((bot) => toBotRecord(host, bot));
    cacheHostBotsSnapshot(host.hostId, botsByHost[host.hostId]);

    for (const bot of host.bots) {
      const botKey = getBotCacheKey({
        hostId: host.hostId,
        accountId: bot.accountId,
      });
      const activeSession = toActiveSessionRecord(host, bot);
      sessionsByBot[botKey] = activeSession;
      archivedSessionsByBot[botKey] = bot.archivedSessions.map(({ messages: _messages, ...archivedSession }) => archivedSession);
      sessionRecordsById[sessionRecordKey(host.hostId, bot.accountId, bot.activeSessionId)] = activeSession;
      cacheBotSessionSnapshot(
        {
          hostId: host.hostId,
          accountId: bot.accountId,
        },
        activeSession,
      );

      for (const archivedSession of bot.archivedSessions) {
        sessionRecordsById[sessionRecordKey(host.hostId, bot.accountId, archivedSession.sessionId)] =
          toArchivedSessionRecord(host, bot, archivedSession);
      }
    }
  }

  seedClientProtocol({
    hosts,
    selectedHostId: hosts[0]?.hostId ?? null,
    botsByHost,
    sessionsByBot,
    archivedSessionsByBot,
    sessionRecordsById,
  });
}

function setHostStatus(hostId: string, status: "online" | "offline", syncClient = true): void {
  const host = requireHost(hostId);
  host.status = status;
  persistScenario();
  if (syncClient) {
    syncClientFromScenario();
  }
}

function setCreateBotMode(hostId: string, mode: "instant" | "deferred"): void {
  requireHost(hostId);
  createBotModes.set(hostId, mode);
}

function resolvePendingCreate(input: {
  hostId: string;
  accountId: string;
  title?: string;
  syncClient?: boolean;
}): void {
  const host = requireHost(input.hostId);
  const pending = pendingBotCreates.get(pendingBotCreateKey(input.hostId, input.accountId));

  if (!pending) {
    throw new Error(`no pending bot creation for ${input.hostId}/${input.accountId}`);
  }

  const bot = createScenarioBot({
    accountId: pending.request.accountId,
    agentId: pending.request.agentId,
    title: input.title ?? pending.request.accountId,
    assistantText: `Ready on ${pending.request.accountId}.`,
  });

  host.bots.push(bot);
  pendingBotCreates.delete(pendingBotCreateKey(input.hostId, input.accountId));
  persistScenario();
  pending.resolve({
    ok: true,
    bot: toBotRecord(host, bot),
  });

  if (input.syncClient ?? false) {
    syncClientFromScenario();
  }
}

function addAuthoritativeBot(input: {
  hostId: string;
  accountId: string;
  agentId: string;
  title: string;
  assistantText?: string;
  syncClient?: boolean;
}): void {
  const host = requireHost(input.hostId);
  host.bots.push(
    createScenarioBot({
      accountId: input.accountId,
      agentId: input.agentId,
      title: input.title,
      assistantText: input.assistantText ?? `Ready on ${input.accountId}.`,
    }),
  );
  persistScenario();

  if (input.syncClient ?? true) {
    syncClientFromScenario();
  }
}

function setAuthoritativeSession(input: {
  hostId: string;
  accountId: string;
  sessionId: string;
  assistantText: string;
  syncClient?: boolean;
}): void {
  const host = requireHost(input.hostId);
  const bot = requireBot(host, input.accountId);
  bot.archivedSessions.unshift({
    sessionId: bot.activeSessionId,
    archivedAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
    messages: structuredClone(bot.activeMessages),
  });
  bot.activeSessionId = input.sessionId;
  bot.activeMessages = [
    {
      id: `${input.sessionId}-message-1`,
      role: "assistant",
      text: input.assistantText,
    },
  ];

  if (input.syncClient ?? false) {
    persistScenario();
    syncClientFromScenario();
    return;
  }

  persistScenario();
}

async function handleMessage(request: MessageSendRequest): Promise<{
  result: import("@openchat/protocol").MessageSendResult;
  stream?: AsyncIterable<StreamEvent>;
}> {
  const host = requireHost(request.hostId);
  const bot = requireBot(host, request.accountId);

  if (request.payload.kind === "systemCommand") {
    if (
      request.targetSessionId !== bot.activeSessionId ||
      request.payload.command.expectedActiveSessionId !== bot.activeSessionId
    ) {
      return {
        result: {
          ok: false,
          code: "session_conflict",
          activeSessionId: bot.activeSessionId,
          archivedSessions: bot.archivedSessions.map(({ messages: _messages, ...archivedSession }) => archivedSession),
        },
      };
    }

    const previousSession: ScenarioArchivedSession = {
      sessionId: bot.activeSessionId,
      archivedAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
      messages: structuredClone(bot.activeMessages),
    };
    const nextSessionId = `${bot.accountId}-session-${bot.archivedSessions.length + 2}`;
    bot.archivedSessions.unshift(previousSession);
    bot.activeSessionId = nextSessionId;
    bot.activeMessages = [
      {
        id: `${nextSessionId}-message-1`,
        role: "assistant",
        text: `Started ${nextSessionId}.`,
      },
    ];
    persistScenario();

    return {
      result: {
        ok: true,
        activeSessionId: nextSessionId,
        resultingSessionId: nextSessionId,
        forwarded: false,
        archivedSessions: bot.archivedSessions.map(({ messages: _messages, ...archivedSession }) => archivedSession),
      },
    };
  }

  if (request.targetSessionId !== bot.activeSessionId) {
    return {
      result: {
        ok: false,
        code: "session_conflict",
        activeSessionId: bot.activeSessionId,
        archivedSessions: bot.archivedSessions.map(({ messages: _messages, ...archivedSession }) => archivedSession),
      },
    };
  }

  const replyText = `Assistant reply for ${request.payload.text}`;
  bot.activeMessages.push({
    id: `${bot.activeSessionId}-user-${bot.activeMessages.length + 1}`,
    role: "user",
    text: request.payload.text,
  });
  bot.activeMessages.push({
    id: `${bot.activeSessionId}-assistant-${bot.activeMessages.length + 1}`,
    role: "assistant",
    text: replyText,
  });
  persistScenario();

  return {
    result: {
      ok: true,
      activeSessionId: bot.activeSessionId,
      forwarded: true,
      archivedSessions: bot.archivedSessions.map(({ messages: _messages, ...archivedSession }) => archivedSession),
    },
    stream: createReplyStream(replyText),
  };
}

function createReplyStream(text: string): AsyncIterable<StreamEvent> {
  const chunks = text.split(" ");
  return {
    async *[Symbol.asyncIterator]() {
      for (const [index, chunk] of chunks.entries()) {
        yield {
          type: "chunk",
          delta: index === chunks.length - 1 ? chunk : `${chunk} `,
        };
      }
      yield {
        type: "done",
      };
    },
  };
}

function toHostSnapshot(host: ScenarioHost) {
  const bots = host.bots.map((bot) => toBotRecord(host, bot));
  const sessions = host.bots.reduce<Record<string, SessionRecord>>((result, bot) => {
    result[getBotCacheKey({ hostId: host.hostId, accountId: bot.accountId })] =
      toActiveSessionRecord(host, bot);
    return result;
  }, {});
  const archivedSessionsByBot = host.bots.reduce<Record<string, ArchivedSessionRecord[]>>((result, bot) => {
    result[getBotCacheKey({ hostId: host.hostId, accountId: bot.accountId })] =
      bot.archivedSessions.map(({ messages: _messages, ...archivedSession }) => archivedSession);
    return result;
  }, {});
  const sessionRecordsById = host.bots.reduce<Record<string, SessionRecord>>((result, bot) => {
    result[sessionRecordKey(host.hostId, bot.accountId, bot.activeSessionId)] =
      toActiveSessionRecord(host, bot);
    for (const archivedSession of bot.archivedSessions) {
      result[sessionRecordKey(host.hostId, bot.accountId, archivedSession.sessionId)] =
        toArchivedSessionRecord(host, bot, archivedSession);
    }
    return result;
  }, {});

  return {
    host: {
      hostId: host.hostId,
      name: host.name,
      edgeKeyFingerprint: host.edgeKeyFingerprint,
      status: host.status,
    },
    bots,
    sessions,
    archivedSessionsByBot,
    sessionRecordsById,
  };
}

function toBotRecord(host: ScenarioHost, bot: ScenarioBot): BotRecord {
  return {
    ...buildBotAccount({
      hostId: host.hostId,
      accountId: bot.accountId,
      agentId: bot.agentId,
      activeSessionId: bot.activeSessionId,
    }),
    title: bot.title,
    backing: "openclaw",
  };
}

function toActiveSessionRecord(host: ScenarioHost, bot: ScenarioBot): SessionRecord {
  return {
    hostId: host.hostId,
    accountId: bot.accountId,
    sessionId: bot.activeSessionId,
    title: `Session ${bot.activeSessionId}`,
    messages: structuredClone(bot.activeMessages),
  };
}

function toArchivedSessionRecord(
  host: ScenarioHost,
  bot: ScenarioBot,
  archivedSession: ScenarioArchivedSession,
): SessionRecord {
  return {
    hostId: host.hostId,
    accountId: bot.accountId,
    sessionId: archivedSession.sessionId,
    title: `Session ${archivedSession.sessionId}`,
    messages: structuredClone(archivedSession.messages),
  };
}

function requireHost(hostId: string): ScenarioHost {
  const host = scenarioState.hosts.find((candidate) => candidate.hostId === hostId);
  if (!host) {
    throw new Error(`unknown host ${hostId}`);
  }
  return host;
}

function requireBot(host: ScenarioHost, accountId: string): ScenarioBot {
  const bot = host.bots.find((candidate) => candidate.accountId === accountId);
  if (!bot) {
    throw new Error(`unknown bot ${accountId}`);
  }
  return bot;
}

function createScenarioBot(input: {
  accountId: string;
  agentId: string;
  title: string;
  assistantText: string;
}): ScenarioBot {
  const activeSessionId = `${input.accountId}-active`;

  return {
    accountId: input.accountId,
    agentId: input.agentId,
    title: input.title,
    activeSessionId,
    activeMessages: [
      {
        id: `${activeSessionId}-message-1`,
        role: "assistant",
        text: input.assistantText,
      },
    ],
    archivedSessions: [],
  };
}

function getCreateBotMode(hostId: string): "instant" | "deferred" {
  return createBotModes.get(hostId) ?? "instant";
}

function pendingBotCreateKey(hostId: string, accountId: string): string {
  return `${hostId}:${accountId}`;
}

function persistScenario(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(scenarioState));
}

function restoreScenarioFromStorage(): void {
  if (typeof window === "undefined") {
    return;
  }

  const raw = window.sessionStorage.getItem(SCENARIO_STORAGE_KEY);

  if (!raw) {
    return;
  }

  scenarioState = JSON.parse(raw) as OpenChatE2EScenario;
  configureHandlers();
}

function sessionRecordKey(hostId: string, accountId: string, sessionId: string): string {
  return `${hostId}:${accountId}:${sessionId}`;
}
