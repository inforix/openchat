import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { createRelayTunnel } from "../relay-tunnel";

describe("relay tunnel runtime lifecycle", () => {
  it("stops polling when the relay request stream closes", async () => {
    let takeCalls = 0;

    const tunnel = createRelayTunnel(
      {
        hostId: "host-1",
        deviceId: "device-1",
        stateDir: "/tmp/openchat-edge",
        edgeId: "edge:device-1",
        edgePublicKey: "public-key",
        edgeKeyFingerprint: "fingerprint",
        now: () => new Date("2026-03-19T00:00:00.000Z"),
        generatePairingNonce: () => "nonce-1",
        paths: {
          edgeDirectory: "/tmp/openchat-edge/edge",
          keyPairPath: "/tmp/openchat-edge/edge/device-keypair.json",
          trustedDevicesPath: "/tmp/openchat-edge/edge/trusted-devices.json",
        },
      },
      {
        registerEdge: vi.fn(async () => {}),
        takeClientRequests: vi.fn(async () => {
          takeCalls += 1;
          return [];
        }),
        publishEncryptedEvent: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
      {
        listBots: vi.fn(async () => []),
        getSessionSnapshot: vi.fn(async () => ({
          accountId: "acct-1",
          activeSessionId: null,
          archivedSessions: [],
        })),
        getSessionTranscript: vi.fn(async () => null),
      },
    );

    await tunnel.start();
    await delay(20);

    expect(takeCalls).toBe(1);

    await tunnel.close();
  });
});
