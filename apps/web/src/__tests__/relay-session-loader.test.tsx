// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";

import { buildBotAccount } from "@openchat/protocol";
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
import { createEdgeMain } from "../../../edge/src/main";
import { createRelayWebSocketClient } from "../../../edge/src/relay-websocket-client";
import { createRelayMain } from "../../../relay/src/main";
import { createRelayServer } from "../../../relay/src/server";
import {
  installRelaySessionHistoryLoader,
  installRelaySessionSnapshotLoader,
  resetClientProtocol,
  seedClientProtocol,
  type BotRecord,
  type HostRecord,
  type SessionRecord,
} from "../lib/client-protocol";
import { clearOfflineCache } from "../lib/offline-cache";
import { BotScreen } from "../screens/bot-screen";

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
  const directory = await mkdtemp(join(tmpdir(), "web-relay-session-loader-"));
  tempDirs.push(directory);
  return directory;
};

const hostAlpha: HostRecord = {
  hostId: "host-alpha",
  name: "North Relay",
  edgeKeyFingerprint: "fingerprint-alpha",
  status: "online",
};

beforeEach(() => {
  resetClientProtocol();
  clearOfflineCache();
});

afterEach(async () => {
  cleanup();
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("relay-backed session snapshot loader", () => {
  it("refreshes a bot page to the authoritative active session id", async () => {
    const relayDirectory = await createTempDir();
    const edgeStateDirectory = await createTempDir();
    const transport = new FakeOpenClawTransport();
    const client = createOpenClawClient({
      hostId: hostAlpha.hostId,
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      transport,
    });
    const adapter = new ConfirmingOpenClawAdapter(client);
    const authoritativeBot = await adapter.createOpenChatBot({
      accountId: "acct-ledger",
      agentId: "agent-ledger",
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
      hostId: hostAlpha.hostId,
      userId: "user-1",
    });
    store.bindDeviceToHost({
      deviceId: "device-1",
      hostId: hostAlpha.hostId,
    });

    const relay = createRelayMain({ store });
    const server = createRelayServer({
      relay,
      host: "127.0.0.1",
      port: 0,
    });
    await server.start();

    const edge = createEdgeMain({
      hostId: hostAlpha.hostId,
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      relay: createRelayWebSocketClient({
        relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      }),
      openClaw: adapter,
      streamState: new FakeStreamStateSource(),
    });
    await edge.start();

    const staleBot = createBotRecord(
      authoritativeBot.accountId,
      authoritativeBot.agentId,
      "Ledger Room",
      "sess-stale",
    );
    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [staleBot],
      },
      sessionsByBot: {
        [`${hostAlpha.hostId}:${staleBot.accountId}`]: createSession(
          hostAlpha.hostId,
          staleBot.accountId,
          staleBot.activeSessionId,
          "Stale active",
        ),
      },
    });
    installRelaySessionSnapshotLoader({
      relayHttpUrl: server.baseHttpUrl,
      relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      deviceId: "device-1",
      deviceCredential: "credential-1",
      webSocketFactory: (url) => new NodeWebSocket(url),
    });

    try {
      render(<BotScreen hostId={hostAlpha.hostId} botId={staleBot.botId} />);

      expect(await screen.findByText(/active session sess-1/i)).toBeInTheDocument();
      expect(screen.queryByText("Stale active")).not.toBeInTheDocument();
      expect(screen.getByText(/no active session is available/i)).toBeInTheDocument();
    } finally {
      await edge.close();
      await server.close();
    }
  });

  it("loads the authoritative active transcript over relay when the client has only session metadata", async () => {
    const relayDirectory = await createTempDir();
    const edgeStateDirectory = await createTempDir();
    const transport = new FakeOpenClawTransport();
    const client = createOpenClawClient({
      hostId: hostAlpha.hostId,
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
          text: "Authoritative transcript",
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
      hostId: hostAlpha.hostId,
      userId: "user-1",
    });
    store.bindDeviceToHost({
      deviceId: "device-1",
      hostId: hostAlpha.hostId,
    });

    const relay = createRelayMain({ store });
    const server = createRelayServer({
      relay,
      host: "127.0.0.1",
      port: 0,
    });
    await server.start();

    const edge = createEdgeMain({
      hostId: hostAlpha.hostId,
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      relay: createRelayWebSocketClient({
        relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      }),
      openClaw: adapter,
      streamState: new FakeStreamStateSource(),
    });
    await edge.start();

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [createBotRecord(bot.accountId, bot.agentId, "Ledger Room", bot.activeSessionId)],
      },
      sessionsByBot: {},
    });
    installRelaySessionSnapshotLoader({
      relayHttpUrl: server.baseHttpUrl,
      relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      deviceId: "device-1",
      deviceCredential: "credential-1",
      webSocketFactory: (url) => new NodeWebSocket(url),
    });
    installRelaySessionHistoryLoader({
      relayHttpUrl: server.baseHttpUrl,
      relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      deviceId: "device-1",
      deviceCredential: "credential-1",
      webSocketFactory: (url) => new NodeWebSocket(url),
    });

    try {
      render(<BotScreen hostId={hostAlpha.hostId} botId={bot.botId} />);

      expect(await screen.findByText("Authoritative transcript")).toBeInTheDocument();
      expect(screen.queryByText(/no active session is available/i)).not.toBeInTheDocument();
    } finally {
      await edge.close();
      await server.close();
    }
  });

  it("loads an archived transcript over relay after the user selects it", async () => {
    const user = userEvent.setup();
    const relayDirectory = await createTempDir();
    const edgeStateDirectory = await createTempDir();
    const transport = new FakeOpenClawTransport();
    const client = createOpenClawClient({
      hostId: hostAlpha.hostId,
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      transport,
    });
    const adapter = new ConfirmingOpenClawAdapter(client);
    const bot = await adapter.createOpenChatBot({
      accountId: "acct-ledger",
      agentId: "agent-ledger",
    });
    const nextSession = await adapter.createNextSession({
      accountId: bot.accountId,
      expectedActiveSessionId: bot.activeSessionId,
      commandId: "cmd-archived-seed",
    });

    transport.seedSessionTranscript({
      accountId: bot.accountId,
      sessionId: nextSession.sessionId,
      title: `Session ${nextSession.sessionId}`,
      messages: [
        {
          id: `${nextSession.sessionId}-message-1`,
          role: "assistant",
          text: "Current transcript",
        },
      ],
    });
    transport.seedSessionTranscript({
      accountId: bot.accountId,
      sessionId: "sess-1",
      title: "Session sess-1",
      messages: [
        {
          id: "sess-1-message-1",
          role: "assistant",
          text: "Archived transcript from host",
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
      hostId: hostAlpha.hostId,
      userId: "user-1",
    });
    store.bindDeviceToHost({
      deviceId: "device-1",
      hostId: hostAlpha.hostId,
    });

    const relay = createRelayMain({ store });
    const server = createRelayServer({
      relay,
      host: "127.0.0.1",
      port: 0,
    });
    await server.start();

    const edge = createEdgeMain({
      hostId: hostAlpha.hostId,
      deviceId: "device-1",
      stateDir: edgeStateDirectory,
      relay: createRelayWebSocketClient({
        relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      }),
      openClaw: adapter,
      streamState: new FakeStreamStateSource(),
    });
    await edge.start();

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [createBotRecord(bot.accountId, bot.agentId, "Ledger Room", nextSession.sessionId)],
      },
      sessionsByBot: {},
      archivedSessionsByBot: {
        [`${hostAlpha.hostId}:${bot.accountId}`]: [
          {
            sessionId: "sess-1",
            archivedAt: "2026-03-18T10:00:00.000Z",
          },
        ],
      },
    });
    installRelaySessionSnapshotLoader({
      relayHttpUrl: server.baseHttpUrl,
      relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      deviceId: "device-1",
      deviceCredential: "credential-1",
      webSocketFactory: (url) => new NodeWebSocket(url),
    });
    installRelaySessionHistoryLoader({
      relayHttpUrl: server.baseHttpUrl,
      relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      deviceId: "device-1",
      deviceCredential: "credential-1",
      webSocketFactory: (url) => new NodeWebSocket(url),
    });

    try {
      render(<BotScreen hostId={hostAlpha.hostId} botId={bot.botId} />);

      await user.click(screen.getByRole("button", { name: /archived sess-1/i }));

      expect(await screen.findByText("Archived transcript from host")).toBeInTheDocument();
      expect(screen.getByText(/archived sessions are read-only/i)).toBeInTheDocument();
    } finally {
      await edge.close();
      await server.close();
    }
  });
});

function createBotRecord(
  accountId: string,
  agentId: string,
  title: string,
  activeSessionId: string,
): BotRecord {
  return {
    ...buildBotAccount({
      hostId: hostAlpha.hostId,
      accountId,
      agentId,
      activeSessionId,
    }),
    title,
    backing: "openclaw",
  };
}

function createSession(
  hostId: string,
  accountId: string,
  sessionId: string,
  text: string,
): SessionRecord {
  return {
    hostId,
    accountId,
    sessionId,
    title: `Session ${sessionId}`,
    messages: [
      {
        id: `${sessionId}-message-1`,
        role: "assistant",
        text,
      },
    ],
  };
}
