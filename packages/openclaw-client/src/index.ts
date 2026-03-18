import {
  emptyStoredAccountState,
  pruneExpiredCommandResults,
  readStoredAccountState,
  writeStoredAccountState,
  type ActiveSession,
  type ArchivedSessionSummary,
  type CommandSessionResult,
  type StoredAccountState,
} from "./account-state";
import {
  listConfiguredOpenChatAccounts,
  writeConfiguredOpenChatAccounts,
  type ConfiguredOpenChatAccount,
} from "./config";
import { OpenClawClientError, SessionConflictError } from "./errors";
import {
  abortTransportMessage,
  createTransportSession,
  readTransportSession,
  sendTransportMessage,
  type MessagePayload,
  type OpenClawTransport,
  type SessionTranscriptMessage,
} from "./sessions";

const COMMAND_RETENTION_MS = 10 * 60 * 1000;

export type OpenChatBot = {
  botId: string;
  channelType: "openchat";
  hostId: string;
  accountId: string;
  agentId: string;
  activeSessionId: string;
};

export type CreateOpenChatBotInput = {
  accountId: string;
  agentId: string;
};

export type CreateNextSessionInput = {
  accountId: string;
  expectedActiveSessionId: string | null;
  commandId: string;
};

export type SendMessageInput = {
  accountId: string;
  targetSessionId: string;
  payload: MessagePayload;
};

export type AbortMessageInput = {
  accountId: string;
  targetSessionId: string;
};

export type SessionTranscript = {
  hostId: string;
  accountId: string;
  sessionId: string;
  title: string;
  messages: SessionTranscriptMessage[];
};

export type OpenClawClient = {
  listOpenChatBots(): Promise<OpenChatBot[]>;
  createOpenChatBot(input: CreateOpenChatBotInput): Promise<OpenChatBot>;
  getActiveSession(input: { accountId: string }): Promise<ActiveSession | null>;
  listArchivedSessions(input: {
    accountId: string;
  }): Promise<ArchivedSessionSummary[]>;
  readSessionTranscript(input: {
    accountId: string;
    sessionId: string;
  }): Promise<SessionTranscript | null>;
  createNextSession(input: CreateNextSessionInput): Promise<ActiveSession>;
  sendMessage(input: SendMessageInput): Promise<void>;
  abortMessage(input: AbortMessageInput): Promise<void>;
};

export type CreateOpenClawClientOptions = {
  hostId: string;
  deviceId: string;
  stateDir: string;
  transport: OpenClawTransport;
  now?: () => number;
};

const requireNonEmpty = (value: string, fieldName: string): string => {
  if (value.trim().length === 0) {
    throw new OpenClawClientError(`${fieldName} is required`);
  }

  return value;
};

const toActiveSession = (
  hostId: string,
  accountId: string,
  sessionId: string,
): ActiveSession => ({
  hostId,
  accountId,
  sessionId,
});

const toBotId = (hostId: string, accountId: string): string =>
  `${encodeURIComponent(hostId)}:${encodeURIComponent(accountId)}`;

const toBot = (
  hostId: string,
  account: ConfiguredOpenChatAccount,
  activeSessionId: string,
): OpenChatBot => ({
  botId: toBotId(hostId, account.accountId),
  channelType: "openchat",
  hostId,
  accountId: account.accountId,
  agentId: account.agentId,
  activeSessionId,
});

const cloneCommandResults = (
  commandResults: CommandSessionResult[],
): CommandSessionResult[] => commandResults.map((result) => ({ ...result }));

const cloneArchivedSessions = (
  archivedSessions: ArchivedSessionSummary[],
): ArchivedSessionSummary[] =>
  archivedSessions.map((session) => ({ ...session }));

export const createOpenClawClient = (
  options: CreateOpenClawClientOptions,
): OpenClawClient => {
  const now = options.now ?? Date.now;

  const readAccountState = async (
    accountId: string,
  ): Promise<StoredAccountState | null> => {
    const state = await readStoredAccountState({
      stateDir: options.stateDir,
      hostId: options.hostId,
      accountId,
    });

    if (!state) {
      return null;
    }

    const pruned = pruneExpiredCommandResults(
      state,
      now(),
      COMMAND_RETENTION_MS,
    );

    if (pruned.commandResults.length !== state.commandResults.length) {
      await writeStoredAccountState({
        stateDir: options.stateDir,
        state: pruned,
      });
    }

    return pruned;
  };

  const writeAccountState = async (state: StoredAccountState): Promise<void> => {
    await writeStoredAccountState({
      stateDir: options.stateDir,
      state,
    });
  };

  const getActiveSession = async (input: {
    accountId: string;
  }): Promise<ActiveSession | null> => {
    const state = await readAccountState(input.accountId);
    if (!state?.activeSessionId) {
      return null;
    }

    return toActiveSession(
      options.hostId,
      input.accountId,
      state.activeSessionId,
    );
  };

  const ensureMatchingActiveSession = async (
    accountId: string,
    targetSessionId: string,
  ): Promise<void> => {
    const activeSession = await getActiveSession({ accountId });
    if (activeSession?.sessionId !== targetSessionId) {
      throw new SessionConflictError(activeSession?.sessionId ?? null);
    }
  };

  return {
    async listOpenChatBots(): Promise<OpenChatBot[]> {
      const configuredAccounts = await listConfiguredOpenChatAccounts(
        options.transport,
      );
      const bots: OpenChatBot[] = [];

      for (const account of configuredAccounts) {
        const activeSession = await getActiveSession({
          accountId: account.accountId,
        });
        if (!activeSession) {
          continue;
        }

        bots.push(toBot(options.hostId, account, activeSession.sessionId));
      }

      return bots;
    },

    async createOpenChatBot(input: CreateOpenChatBotInput): Promise<OpenChatBot> {
      const accountId = requireNonEmpty(input.accountId, "accountId");
      const agentId = requireNonEmpty(input.agentId, "agentId");
      const configuredAccounts = await listConfiguredOpenChatAccounts(
        options.transport,
      );
      if (
        configuredAccounts.some((account) => account.accountId === accountId)
      ) {
        throw new OpenClawClientError(
          `openchat account ${accountId} already exists`,
        );
      }

      const nextConfiguredAccounts = [
        ...configuredAccounts,
        { accountId, agentId },
      ];
      await writeConfiguredOpenChatAccounts(
        options.transport,
        nextConfiguredAccounts,
      );

      try {
        await options.transport.agentsBind({
          agentId,
          binding: `openchat:${accountId}`,
        });

        const initialSessionId = await createTransportSession(
          options.transport,
          accountId,
        );
        await writeAccountState({
          hostId: options.hostId,
          accountId,
          activeSessionId: initialSessionId,
          archivedSessions: [],
          commandResults: [],
        });

        return toBot(options.hostId, { accountId, agentId }, initialSessionId);
      } catch (error) {
        await writeConfiguredOpenChatAccounts(
          options.transport,
          configuredAccounts,
        );
        throw error;
      }
    },

    getActiveSession,

    async listArchivedSessions(input: {
      accountId: string;
    }): Promise<ArchivedSessionSummary[]> {
      const state = await readAccountState(input.accountId);
      return cloneArchivedSessions(state?.archivedSessions ?? []);
    },

    async readSessionTranscript(input: {
      accountId: string;
      sessionId: string;
    }): Promise<SessionTranscript | null> {
      const accountId = requireNonEmpty(input.accountId, "accountId");
      const sessionId = requireNonEmpty(input.sessionId, "sessionId");
      const session = await readTransportSession(options.transport, {
        accountId,
        sessionId,
      });

      if (!session) {
        return null;
      }

      return {
        hostId: options.hostId,
        accountId,
        sessionId,
        title: session.title,
        messages: session.messages.map((message) => ({ ...message })),
      };
    },

    async createNextSession(input: CreateNextSessionInput): Promise<ActiveSession> {
      const accountId = requireNonEmpty(input.accountId, "accountId");
      const commandId = requireNonEmpty(input.commandId, "commandId");
      const state =
        (await readAccountState(accountId)) ??
        emptyStoredAccountState(options.hostId, accountId);
      const existingCommandResult = state.commandResults.find(
        (result) =>
          result.deviceId === options.deviceId && result.commandId === commandId,
      );

      if (existingCommandResult) {
        return toActiveSession(
          options.hostId,
          accountId,
          existingCommandResult.resultingSessionId,
        );
      }

      if (state.activeSessionId !== input.expectedActiveSessionId) {
        throw new SessionConflictError(state.activeSessionId);
      }

      const sessionId = await createTransportSession(options.transport, accountId);
      const archivedSessions = cloneArchivedSessions(state.archivedSessions);
      if (state.activeSessionId) {
        archivedSessions.unshift({
          sessionId: state.activeSessionId,
          archivedAt: new Date(now()).toISOString(),
        });
      }

      const commandResults = cloneCommandResults(state.commandResults);
      commandResults.push({
        deviceId: options.deviceId,
        commandId,
        resultingSessionId: sessionId,
        createdAt: now(),
      });

      await writeAccountState({
        hostId: options.hostId,
        accountId,
        activeSessionId: sessionId,
        archivedSessions,
        commandResults,
      });

      return toActiveSession(options.hostId, accountId, sessionId);
    },

    async sendMessage(input: SendMessageInput): Promise<void> {
      await ensureMatchingActiveSession(input.accountId, input.targetSessionId);
      await sendTransportMessage(options.transport, {
        accountId: input.accountId,
        sessionId: input.targetSessionId,
        payload: input.payload,
      });
    },

    async abortMessage(input: AbortMessageInput): Promise<void> {
      await ensureMatchingActiveSession(input.accountId, input.targetSessionId);
      await abortTransportMessage(options.transport, {
        accountId: input.accountId,
        sessionId: input.targetSessionId,
      });
    },
  };
};

export { SessionConflictError, OpenClawClientError } from "./errors";
export type {
  ActiveSession,
  ArchivedSessionSummary,
  CommandSessionResult,
} from "./account-state";
export type { MessagePayload, OpenClawTransport } from "./sessions";
