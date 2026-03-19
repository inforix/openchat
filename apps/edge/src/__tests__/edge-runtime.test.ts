import { describe, expect, it, vi } from "vitest";

import {
  readEdgeRuntimeConfig,
  startEdgeRuntime,
} from "../runtime";

describe("edge runtime", () => {
  it("requires host, device, and relay websocket configuration", () => {
    expect(() =>
      readEdgeRuntimeConfig({}, "/workspace/openchat"),
    ).toThrow("OPENCHAT_EDGE_HOST_ID");
  });

  it("derives defaults for state and openclaw cli settings", () => {
    const config = readEdgeRuntimeConfig(
      {
        OPENCHAT_EDGE_HOST_ID: "host-1",
        OPENCHAT_EDGE_DEVICE_ID: "device-1",
        OPENCHAT_EDGE_RELAY_WS_URL: "ws://127.0.0.1:3001/relay",
      },
      "/workspace/openchat",
    );

    expect(config).toEqual({
      hostId: "host-1",
      deviceId: "device-1",
      relayWebSocketUrl: "ws://127.0.0.1:3001/relay",
      stateDir: "/workspace/openchat/.openchat-state",
      openClawBin: "openclaw",
      openClawProfile: undefined,
    });
  });

  it("starts edge main with a real relay client and an openclaw-backed adapter", async () => {
    const relay = {
      registerEdge: vi.fn(async () => {}),
      takeClientRequests: vi.fn(async () => []),
      publishEncryptedEvent: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const transport = {
      configGet: vi.fn(async () => undefined),
      configSet: vi.fn(async () => {}),
      configUnset: vi.fn(async () => {}),
      agentsBind: vi.fn(async () => {}),
      createSession: vi.fn(async () => ({ sessionId: "session-1" })),
      sendMessage: vi.fn(async () => {}),
      abortMessage: vi.fn(async () => {}),
    };
    const openClaw = {
      listOpenChatBots: vi.fn(async () => []),
      createOpenChatBot: vi.fn(async () => ({
        botId: "bot-1",
        channelType: "openchat" as const,
        hostId: "host-1",
        accountId: "acct-1",
        agentId: "agent-1",
        activeSessionId: "session-1",
      })),
      getActiveSession: vi.fn(async () => null),
      listArchivedSessions: vi.fn(async () => []),
      readSessionTranscript: vi.fn(async () => null),
      createNextSession: vi.fn(async () => ({
        hostId: "host-1",
        accountId: "acct-1",
        sessionId: "session-2",
      })),
      sendMessage: vi.fn(async () => {}),
      abortMessage: vi.fn(async () => {}),
    };
    const edgeMain = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      createPairingResponse: vi.fn(),
      confirmPairing: vi.fn(),
      listBots: vi.fn(),
      createBot: vi.fn(),
      handleMessage: vi.fn(),
    };

    const runtime = await startEdgeRuntime(
      {
        hostId: "host-1",
        deviceId: "device-1",
        relayWebSocketUrl: "ws://127.0.0.1:3001/relay",
        stateDir: "/tmp/openchat-edge",
        openClawBin: "openclaw",
        openClawProfile: "dev",
      },
      {
        createRelayClient: () => relay,
        createTransport: () => transport,
        createOpenClawClient: () => openClaw,
        createEdgeMain: () => edgeMain,
      },
    );

    expect(edgeMain.start).toHaveBeenCalledTimes(1);
    expect(runtime.config.openClawProfile).toBe("dev");
    await runtime.close();
    await runtime.close();
    expect(edgeMain.close).toHaveBeenCalledTimes(1);
  });
});
