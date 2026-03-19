import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  BotListResultPayloadSchema,
  SessionHistoryResultPayloadSchema,
  type BotListResultPayload,
  type SessionHistoryResultPayload,
} from "../../../../packages/protocol/src/index";
import { createRelayStore } from "../../../../packages/store/src/index";
import {
  createOpenClawClient,
  type CreateOpenChatBotInput,
  type MessagePayload,
  type OpenChatBot,
  type OpenClawClient,
  type OpenClawTransport,
  type SendMessageInput,
} from "../../../../packages/openclaw-client/src/index";
import { createEdgeMain } from "../main";
import { createRelayWebSocketClient } from "../relay-websocket-client";
import { createRelayMain } from "../../../relay/src/main";
import { createRelayServer } from "../../../relay/src/server";

type TransportSendCall = {
  accountId: string;
  sessionId: string;
  payload: MessagePayload;
};

type EdgeOpenClawAdapter = Pick<
  OpenClawClient,
  | "listOpenChatBots"
  | "createOpenChatBot"
  | "getActiveSession"
  | "listArchivedSessions"
  | "readSessionTranscript"
  | "createNextSession"
  | "sendMessage"
  | "abortMessage"
> & {
  confirmAccountCreated(input: CreateOpenChatBotInput): Promise<boolean>;
};

class FakeOpenClawTransport implements OpenClawTransport {
  readonly bindings: Array<{ agentId: string; binding: string }> = [];
  readonly createSessionCalls: string[] = [];
  readonly sendCalls: TransportSendCall[] = [];
  readonly abortCalls: Array<{ accountId: string; sessionId: string }> = [];

  private readonly config = new Map<string, unknown>();
  private readonly sessionTranscripts = new Map<
    string,
    {
      title: string;
      messages: Array<{
        id: string;
        role: "user" | "assistant" | "system";
        text: string;
      }>;
    }
  >();
  private nextSessionNumber = 1;

  async configGet(path: string): Promise<unknown> {
    return structuredClone(this.config.get(path));
  }

  async configSet(path: string, value: unknown): Promise<void> {
    this.config.set(path, structuredClone(value));
  }

  async configUnset(path: string): Promise<void> {
    this.config.delete(path);
  }

  async agentsBind(input: {
    agentId: string;
    binding: string;
  }): Promise<void> {
    this.bindings.push(input);
  }

  async createSession(input: { accountId: string }): Promise<{ sessionId: string }> {
    this.createSessionCalls.push(input.accountId);
    return { sessionId: `sess-${this.nextSessionNumber++}` };
  }

  async sendMessage(input: TransportSendCall): Promise<void> {
    this.sendCalls.push(structuredClone(input));
  }

  async abortMessage(input: {
    accountId: string;
    sessionId: string;
  }): Promise<void> {
    this.abortCalls.push(input);
  }

  seedSessionTranscript(input: {
    accountId: string;
    sessionId: string;
    title: string;
    messages: Array<{
      id: string;
      role: "user" | "assistant" | "system";
      text: string;
    }>;
  }): void {
    this.sessionTranscripts.set(
      `${input.accountId}:${input.sessionId}`,
      structuredClone({
        title: input.title,
        messages: input.messages,
      }),
    );
  }

  async readSession(input: {
    accountId: string;
    sessionId: string;
  }): Promise<{
    title: string;
    messages: Array<{
      id: string;
      role: "user" | "assistant" | "system";
      text: string;
    }>;
  } | null> {
    return (
      structuredClone(
        this.sessionTranscripts.get(`${input.accountId}:${input.sessionId}`),
      ) ?? null
    );
  }
}

class ConfirmingOpenClawAdapter implements EdgeOpenClawAdapter {
  constructor(private readonly client: OpenClawClient) {}

  async confirmAccountCreated(): Promise<boolean> {
    return true;
  }

  async listOpenChatBots(): Promise<OpenChatBot[]> {
    return this.client.listOpenChatBots();
  }

  async createOpenChatBot(input: CreateOpenChatBotInput): Promise<OpenChatBot> {
    return this.client.createOpenChatBot(input);
  }

  async getActiveSession(input: { accountId: string }) {
    return this.client.getActiveSession(input);
  }

  async listArchivedSessions(input: { accountId: string }) {
    return this.client.listArchivedSessions(input);
  }

  async readSessionTranscript(input: {
    accountId: string;
    sessionId: string;
  }) {
    return this.client.readSessionTranscript(input);
  }

  async createNextSession(input: {
    accountId: string;
    expectedActiveSessionId: string | null;
    commandId: string;
  }) {
    return this.client.createNextSession(input);
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    return this.client.sendMessage(input);
  }

  async abortMessage(input: {
    accountId: string;
    targetSessionId: string;
  }): Promise<void> {
    return this.client.abortMessage(input);
  }
}

class FakeStreamStateSource {
  async hasActiveStream(): Promise<boolean> {
    return false;
  }
}

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "edge-network-"));
  tempDirs.push(directory);
  return directory;
};

const waitForOpen = async (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };

    socket.on("open", handleOpen);
    socket.on("error", handleError);
  });

const waitForJsonMessage = async <T>(socket: WebSocket): Promise<T> =>
  new Promise((resolve, reject) => {
    const handleMessage = (data: Buffer) => {
      cleanup();
      resolve(JSON.parse(data.toString("utf8")) as T);
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", handleMessage);
      socket.off("error", handleError);
    };

    socket.on("message", handleMessage);
    socket.on("error", handleError);
  });

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("edge relay integration", () => {
  it("answers a real relay bot-list request with authoritative bots", async () => {
    const relayDirectory = await createTempDir();
    const edgeStateDirectory = await createTempDir();
    const transport = new FakeOpenClawTransport();
    const client = createOpenClawClient({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      transport,
    });
    const adapter = new ConfirmingOpenClawAdapter(client);

    await adapter.createOpenChatBot({
      accountId: "acct-ledger",
      agentId: "agent-ledger",
    });
    await adapter.createOpenChatBot({
      accountId: "acct-notes",
      agentId: "agent-notes",
    });

    const store = createRelayStore({
      filename: join(relayDirectory, "relay.sqlite"),
    });
    store.registerDevice({
      deviceId: "device-1",
      userId: "user-1",
      deviceCredential: "credential-1",
    });
    store.registerHost({
      hostId: "host-1",
      userId: "user-1",
    });
    store.bindDeviceToHost({
      deviceId: "device-1",
      hostId: "host-1",
    });

    const relay = createRelayMain({ store });
    const server = createRelayServer({
      relay,
      host: "127.0.0.1",
      port: 0,
    });
    await server.start();

    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      relay: createRelayWebSocketClient({
        relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      }),
      openClaw: adapter,
      streamState: new FakeStreamStateSource(),
    });

    try {
      await edge.start();

      const authResponse = await fetch(`${server.baseHttpUrl}/auth/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceId: "device-1",
          hostId: "host-1",
          deviceCredential: "credential-1",
        }),
      });
      const auth = (await authResponse.json()) as {
        ok: boolean;
        sessionToken?: string;
      };

      expect(auth.ok).toBe(true);

      const clientSocket = new WebSocket(
        `${server.baseWebSocketUrl}/relay?role=client&sessionToken=${auth.sessionToken}`,
      );
      await waitForOpen(clientSocket);

      clientSocket.send(
        JSON.stringify({
          type: "client.bot.list.request",
          requestId: "request-bot-list-1",
        }),
      );

      const message = await waitForJsonMessage<{
        type: string;
        event: {
          requestId: string;
          eventType: string;
          encryptedPayload: string;
        };
      }>(clientSocket);

      expect(message.type).toBe("relay.encrypted.event");
      expect(message.event.requestId).toBe("request-bot-list-1");
      expect(message.event.eventType).toBe("edge.bot.list.result");

      const payload = BotListResultPayloadSchema.parse(
        JSON.parse(message.event.encryptedPayload) as BotListResultPayload,
      );
      expect(payload).toEqual({
        type: "bot.list.result",
        bots: [
          expect.objectContaining({
            hostId: "host-1",
            accountId: "acct-ledger",
            agentId: "agent-ledger",
          }),
          expect.objectContaining({
            hostId: "host-1",
            accountId: "acct-notes",
            agentId: "agent-notes",
          }),
        ],
      });

      clientSocket.close();
    } finally {
      await edge.close();
      await server.close();
    }
  });

  it("answers a real relay session-history request with the authoritative transcript", async () => {
    const relayDirectory = await createTempDir();
    const edgeStateDirectory = await createTempDir();
    const transport = new FakeOpenClawTransport();
    const client = createOpenClawClient({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      transport,
    });
    const adapter = new ConfirmingOpenClawAdapter(client);

    const bot = await adapter.createOpenChatBot({
      accountId: "acct-ledger",
      agentId: "agent-ledger",
    });
    transport.seedSessionTranscript({
      accountId: bot.accountId,
      sessionId: bot.activeSessionId,
      title: `Session ${bot.activeSessionId}`,
      messages: [
        {
          id: `${bot.activeSessionId}-message-1`,
          role: "assistant",
          text: "Transcript from OpenClaw.",
        },
      ],
    });

    const store = createRelayStore({
      filename: join(relayDirectory, "relay.sqlite"),
    });
    store.registerDevice({
      deviceId: "device-1",
      userId: "user-1",
      deviceCredential: "credential-1",
    });
    store.registerHost({
      hostId: "host-1",
      userId: "user-1",
    });
    store.bindDeviceToHost({
      deviceId: "device-1",
      hostId: "host-1",
    });

    const relay = createRelayMain({ store });
    const server = createRelayServer({
      relay,
      host: "127.0.0.1",
      port: 0,
    });
    await server.start();

    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      relay: createRelayWebSocketClient({
        relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      }),
      openClaw: adapter,
      streamState: new FakeStreamStateSource(),
    });

    try {
      await edge.start();

      const authResponse = await fetch(`${server.baseHttpUrl}/auth/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceId: "device-1",
          hostId: "host-1",
          deviceCredential: "credential-1",
        }),
      });
      const auth = (await authResponse.json()) as {
        ok: boolean;
        sessionToken?: string;
      };

      expect(auth.ok).toBe(true);

      const clientSocket = new WebSocket(
        `${server.baseWebSocketUrl}/relay?role=client&sessionToken=${auth.sessionToken}`,
      );
      await waitForOpen(clientSocket);

      clientSocket.send(
        JSON.stringify({
          type: "client.session.history.request",
          requestId: "request-history-1",
          accountId: bot.accountId,
          sessionId: bot.activeSessionId,
        }),
      );

      const message = await waitForJsonMessage<{
        type: string;
        event: {
          requestId: string;
          eventType: string;
          encryptedPayload: string;
        };
      }>(clientSocket);

      expect(message.type).toBe("relay.encrypted.event");
      expect(message.event.requestId).toBe("request-history-1");
      expect(message.event.eventType).toBe("edge.session.history.result");

      const payload = SessionHistoryResultPayloadSchema.parse(
        JSON.parse(message.event.encryptedPayload) as SessionHistoryResultPayload,
      );
      expect(payload).toEqual({
        type: "session.history.result",
        accountId: bot.accountId,
        sessionId: bot.activeSessionId,
        title: `Session ${bot.activeSessionId}`,
        messages: [
          {
            id: `${bot.activeSessionId}-message-1`,
            role: "assistant",
            text: "Transcript from OpenClaw.",
          },
        ],
      });

      clientSocket.close();
    } finally {
      await edge.close();
      await server.close();
    }
  });
});
