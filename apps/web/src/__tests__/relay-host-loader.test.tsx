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
  installRelayHostSnapshotLoader,
  resetClientProtocol,
  seedClientProtocol,
  type HostRecord,
} from "../lib/client-protocol";
import { clearOfflineCache } from "../lib/offline-cache";
import { HomeScreen } from "../screens/home-screen";

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
  const directory = await mkdtemp(join(tmpdir(), "web-relay-loader-"));
  tempDirs.push(directory);
  return directory;
};

const hostAlpha: HostRecord = {
  hostId: "host-alpha",
  name: "North Relay",
  edgeKeyFingerprint: "fingerprint-alpha",
  status: "offline",
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

describe("relay-backed host snapshot loader", () => {
  it("refreshes HomeScreen bot roster from a real relay/edge connection", async () => {
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
    await adapter.createOpenChatBot({
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

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {},
      sessionsByBot: {},
    });
    installRelayHostSnapshotLoader({
      relayHttpUrl: server.baseHttpUrl,
      relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      deviceId: "device-1",
      deviceCredential: "credential-1",
      webSocketFactory: (url) => new NodeWebSocket(url),
    });

    try {
      render(<HomeScreen />);

      expect(screen.getByText(/no bots available/i)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /reconnect to host/i }));

      expect(
        await screen.findByRole("link", { name: /open acct-ledger/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("sess-1")).toBeInTheDocument();
      expect(screen.getByText(/live/i)).toBeInTheDocument();
    } finally {
      await edge.close();
      await server.close();
    }
  });

  it("falls back to offline mode when relay auth succeeds but no edge answers in time", async () => {
    const user = userEvent.setup();
    const relayDirectory = await createTempDir();
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

    seedClientProtocol({
      hosts: [
        {
          ...hostAlpha,
          status: "online",
        },
      ],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {},
      sessionsByBot: {},
    });
    installRelayHostSnapshotLoader({
      relayHttpUrl: server.baseHttpUrl,
      relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      deviceId: "device-1",
      deviceCredential: "credential-1",
      requestTimeoutMs: 50,
      webSocketFactory: (url) => new NodeWebSocket(url),
    });

    try {
      render(<HomeScreen />);

      await user.click(screen.getByRole("button", { name: /refresh from host/i }));

      expect(
        await screen.findByRole("button", { name: /reconnect to host/i }),
      ).toBeInTheDocument();
    } finally {
      await server.close();
    }
  });
});
