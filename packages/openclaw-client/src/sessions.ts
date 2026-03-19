export type UserMessagePayload = {
  kind: "userMessage";
  text: string;
};

export type SessionTranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

export type ReadSessionResult = {
  title: string;
  messages: SessionTranscriptMessage[];
};

export type SessionNewCommandPayload = {
  kind: "systemCommand";
  command: {
    type: "session.new";
    expectedActiveSessionId: string | null;
    commandId: string;
  };
};

export type MessagePayload = UserMessagePayload | SessionNewCommandPayload;

export interface OpenClawTransport {
  configGet(path: string): Promise<unknown>;
  configSet(path: string, value: unknown): Promise<void>;
  configUnset(path: string): Promise<void>;
  agentsBind(input: { agentId: string; binding: string }): Promise<void>;
  createSession(input: { accountId: string }): Promise<{ sessionId: string }>;
  readSession?(input: {
    accountId: string;
    sessionId: string;
  }): Promise<ReadSessionResult | null>;
  sendMessage(input: {
    accountId: string;
    sessionId: string;
    payload: MessagePayload;
  }): Promise<void>;
  abortMessage(input: { accountId: string; sessionId: string }): Promise<void>;
}

export const createTransportSession = async (
  transport: OpenClawTransport,
  accountId: string,
): Promise<string> => {
  const { sessionId } = await transport.createSession({ accountId });
  return sessionId;
};

export const sendTransportMessage = async (
  transport: OpenClawTransport,
  input: {
    accountId: string;
    sessionId: string;
    payload: MessagePayload;
  },
): Promise<void> => {
  await transport.sendMessage(input);
};

export const abortTransportMessage = async (
  transport: OpenClawTransport,
  input: {
    accountId: string;
    sessionId: string;
  },
): Promise<void> => {
  await transport.abortMessage(input);
};

export const readTransportSession = async (
  transport: OpenClawTransport,
  input: {
    accountId: string;
    sessionId: string;
  },
): Promise<ReadSessionResult | null> => {
  if (typeof transport.readSession !== "function") {
    return null;
  }

  return await transport.readSession(input);
};
