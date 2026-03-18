import {
  MessagePayloadSchema,
  type MessagePayload,
} from "../../../packages/protocol/src/index";
import {
  type ActiveSession,
  type ArchivedSessionSummary,
} from "../../../packages/openclaw-client/src/index";

type SessionCommandInput = {
  accountId: string;
  targetSessionId: string;
  payload: MessagePayload;
};

export type SessionSendResult =
  | {
      ok: true;
      activeSessionId: string;
      resultingSessionId?: string;
      forwarded: boolean;
      archivedSessions: ArchivedSessionSummary[];
    }
  | {
      ok: false;
      code: "session_busy" | "session_conflict";
      activeSessionId: string | null;
      archivedSessions: ArchivedSessionSummary[];
    };

export type SessionOpenClawAdapter = {
  getActiveSession(input: { accountId: string }): Promise<ActiveSession | null>;
  listArchivedSessions(input: {
    accountId: string;
  }): Promise<ArchivedSessionSummary[]>;
  createNextSession(input: {
    accountId: string;
    expectedActiveSessionId: string | null;
    commandId: string;
  }): Promise<ActiveSession>;
  sendMessage(input: {
    accountId: string;
    targetSessionId: string;
    payload: MessagePayload;
  }): Promise<void>;
  abortMessage(input: {
    accountId: string;
    targetSessionId: string;
  }): Promise<void>;
};

export type StreamStateSource = {
  hasActiveStream(input: { accountId: string }): Promise<boolean>;
};

export type SessionService = {
  handleMessage(input: SessionCommandInput): Promise<SessionSendResult>;
};

const waitForMutationToFinish = async (
  locks: Map<string, Promise<void>>,
  key: string,
): Promise<void> => {
  const pending = locks.get(key);
  if (pending) {
    await pending;
  }
};

const withMutex = async <T>(
  locks: Map<string, Promise<void>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> => {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry = previous.then(() => current);
  locks.set(key, entry);

  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === entry) {
      locks.delete(key);
    }
  }
};

const isSessionConflictLike = (
  error: unknown,
): error is { code: "session_conflict"; activeSessionId: string | null } => {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Record<string, unknown>;
  return (
    candidate.code === "session_conflict" &&
    (candidate.activeSessionId === null ||
      typeof candidate.activeSessionId === "string")
  );
};

const toConflictResult = (
  archivedSessions: ArchivedSessionSummary[],
  error: { code: "session_conflict"; activeSessionId: string | null },
): SessionSendResult => ({
  ok: false,
  code: "session_conflict",
  activeSessionId: error.activeSessionId,
  archivedSessions,
});

export const createSessionService = (
  openClaw: SessionOpenClawAdapter,
  streamState: StreamStateSource,
): SessionService => {
  const mutationLocks = new Map<string, Promise<void>>();

  return {
    async handleMessage(input): Promise<SessionSendResult> {
      const payload = MessagePayloadSchema.parse(input.payload);

      if (
        payload.kind === "systemCommand" &&
        payload.command.type === "session.new"
      ) {
        return withMutex(mutationLocks, input.accountId, async () => {
          if (await streamState.hasActiveStream({ accountId: input.accountId })) {
            const [activeSession, archivedSessions] = await Promise.all([
              openClaw.getActiveSession({
                accountId: input.accountId,
              }),
              openClaw.listArchivedSessions({
                accountId: input.accountId,
              }),
            ]);
            return {
              ok: false,
              code: "session_busy",
              activeSessionId: activeSession?.sessionId ?? null,
              archivedSessions,
            };
          }

          if (input.targetSessionId !== payload.command.expectedActiveSessionId) {
            const [activeSession, archivedSessions] = await Promise.all([
              openClaw.getActiveSession({
                accountId: input.accountId,
              }),
              openClaw.listArchivedSessions({
                accountId: input.accountId,
              }),
            ]);
            return {
              ok: false,
              code: "session_conflict",
              activeSessionId: activeSession?.sessionId ?? null,
              archivedSessions,
            };
          }

          try {
            const nextSession = await openClaw.createNextSession({
              accountId: input.accountId,
              expectedActiveSessionId:
                payload.command.expectedActiveSessionId,
              commandId: payload.command.commandId,
            });
            const archivedSessions = await openClaw.listArchivedSessions({
              accountId: input.accountId,
            });
            return {
              ok: true,
              activeSessionId: nextSession.sessionId,
              resultingSessionId: nextSession.sessionId,
              forwarded: false,
              archivedSessions,
            };
          } catch (error) {
            if (isSessionConflictLike(error)) {
              const archivedSessions = await openClaw.listArchivedSessions({
                accountId: input.accountId,
              });
              return toConflictResult(archivedSessions, error);
            }
            throw error;
          }
        });
      }

      await waitForMutationToFinish(mutationLocks, input.accountId);

      try {
        await openClaw.sendMessage({
          accountId: input.accountId,
          targetSessionId: input.targetSessionId,
          payload,
        });
        const archivedSessions = await openClaw.listArchivedSessions({
          accountId: input.accountId,
        });
        return {
          ok: true,
          activeSessionId: input.targetSessionId,
          forwarded: true,
          archivedSessions,
        };
      } catch (error) {
        if (isSessionConflictLike(error)) {
          const archivedSessions = await openClaw.listArchivedSessions({
            accountId: input.accountId,
          });
          return toConflictResult(archivedSessions, error);
        }
        throw error;
      }
    },
  };
};
