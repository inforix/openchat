import {
  MessagePayloadSchema,
  type MessagePayload,
} from "../../../packages/protocol/src/index";
import {
  SessionConflictError,
  type ActiveSession,
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
  locks.set(
    key,
    previous.then(() => current),
  );

  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
};

const toConflictResult = (error: SessionConflictError): SessionSendResult => ({
  ok: false,
  code: "session_conflict",
  activeSessionId: error.activeSessionId,
});

export const createSessionService = (
  openClaw: SessionOpenClawAdapter,
): SessionService => {
  const activeStreams = new Set<string>();
  const mutationLocks = new Map<string, Promise<void>>();

  return {
    async handleMessage(input): Promise<SessionSendResult> {
      const payload = MessagePayloadSchema.parse(input.payload);

      if (
        payload.kind === "systemCommand" &&
        payload.command.type === "session.new"
      ) {
        return withMutex(mutationLocks, input.accountId, async () => {
          if (activeStreams.has(input.accountId)) {
            const activeSession = await openClaw.getActiveSession({
              accountId: input.accountId,
            });
            return {
              ok: false,
              code: "session_busy",
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
            if (error instanceof SessionConflictError) {
              return toConflictResult(error);
            }
            throw error;
          }
        });
      }

      activeStreams.add(input.accountId);
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
        if (error instanceof SessionConflictError) {
          return toConflictResult(error);
        }
        throw error;
      } finally {
        activeStreams.delete(input.accountId);
      }
    },
  };
};
