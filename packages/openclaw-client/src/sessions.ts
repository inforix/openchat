export type UserMessagePayload = {
  kind: "userMessage";
  text: string;
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
