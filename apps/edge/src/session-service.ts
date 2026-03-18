import {
  MessagePayloadSchema,
  type MessagePayload,
} from "../../../packages/protocol/src/index";
import { type ActiveSession } from "../../../packages/openclaw-client/src/index";

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
    }
  | {
      ok: false;
      code: "session_busy" | "session_conflict";
      activeSessionId: string | null;
    };

export type SessionOpenClawAdapter = {
  getActiveSession(input: { accountId: string }): Promise<ActiveSession | null>;
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
  error: { code: "session_conflict"; activeSessionId: string | null },
): SessionSendResult => ({
  ok: false,
  code: "session_conflict",
  activeSessionId: error.activeSessionId,
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
            const activeSession = await openClaw.getActiveSession({
              accountId: input.accountId,
            });
            return {
              ok: false,
              code: "session_busy",
              activeSessionId: activeSession?.sessionId ?? null,
            };
          }

          if (input.targetSessionId !== payload.command.expectedActiveSessionId) {
            const activeSession = await openClaw.getActiveSession({
              accountId: input.accountId,
            });
            return {
              ok: false,
              code: "session_conflict",
              activeSessionId: activeSession?.sessionId ?? null,
            };
          }

          try {
            const nextSession = await openClaw.createNextSession({
              accountId: input.accountId,
              expectedActiveSessionId:
                payload.command.expectedActiveSessionId,
              commandId: payload.command.commandId,
            });
            return {
              ok: true,
              activeSessionId: nextSession.sessionId,
              resultingSessionId: nextSession.sessionId,
              forwarded: false,
            };
          } catch (error) {
            if (isSessionConflictLike(error)) {
              return toConflictResult(error);
            }
            throw error;
          }
        });
      }

      try {
        await openClaw.sendMessage({
          accountId: input.accountId,
          targetSessionId: input.targetSessionId,
          payload,
        });
        return {
          ok: true,
          activeSessionId: input.targetSessionId,
          forwarded: true,
        };
      } catch (error) {
        if (isSessionConflictLike(error)) {
          return toConflictResult(error);
        }
        throw error;
      }
    },
  };
};
