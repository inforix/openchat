import { afterEach, describe, expect, it } from "vitest";

import {
  RELAY_CURSOR_TTL_MS,
  RELAY_TABLE_NAMES,
  createRelayStore,
} from "../../../../packages/store/src/index";

import { createRelayMain, type RelayMain } from "../index";

type TestRelay = {
  relay: RelayMain;
  advanceMs(ms: number): void;
};

const activeRelays: RelayMain[] = [];

const createTestRelay = (
  initialNow = "2026-03-18T00:00:00.000Z",
): TestRelay => {
  let nowMs = Date.parse(initialNow);
  const store = createRelayStore({
    filename: ":memory:",
    now: () => new Date(nowMs),
  });
  const relay = createRelayMain({
    store,
    now: () => new Date(nowMs),
  });
  activeRelays.push(relay);

  return {
    relay,
    advanceMs(ms: number) {
      nowMs += ms;
    },
  };
};

afterEach(() => {
  while (activeRelays.length > 0) {
    activeRelays.pop()?.close();
  }
});

const bindPairedDevice = (relay: RelayMain, input: {
  userId: string;
  deviceId: string;
  hostId: string;
}) => {
  relay.store.registerDevice({
    deviceId: input.deviceId,
    userId: input.userId,
  });
  relay.store.registerHost({
    hostId: input.hostId,
    userId: input.userId,
  });
  relay.store.bindDeviceToHost({
    deviceId: input.deviceId,
    hostId: input.hostId,
  });
};

describe("relay service", () => {
  it("device can authenticate and connect", () => {
    const { relay } = createTestRelay();
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
    });

    const auth = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });

    expect(auth).toMatchObject({
      ok: true,
      sessionToken: expect.any(String),
    });
    if (!auth.ok) {
      throw new Error("expected successful auth bootstrap");
    }

    const client = relay.ws.connectClient({
      sessionToken: auth.sessionToken,
    });
    expect(client.session).toEqual({
      deviceId: "device-1",
      hostId: "host-1",
    });
  });

  it("accepts only paired device credentials and never vouches for edge keys", () => {
    const { relay } = createTestRelay();
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
    });

    const paired = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
      claimedEdgeKeyFingerprint: "forged-edge-key",
    });
    const unpaired = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-unpaired",
      deviceCredential: "credential-1",
      claimedEdgeKeyFingerprint: "forged-edge-key",
    });

    expect(paired.ok).toBe(true);
    expect(paired).not.toHaveProperty("trustedEdgeKeyFingerprint");
    expect(unpaired).toEqual({
      ok: false,
      reason: "device_host_not_paired",
    });
  });

  it("routes a bot list request to the correct host", () => {
    const { relay } = createTestRelay();
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
    });
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-2",
    });

    const auth = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });
    if (!auth.ok) {
      throw new Error("expected successful auth bootstrap");
    }

    const host1Edge = relay.ws.connectEdge({
      hostId: "host-1",
      edgeId: "edge-1",
    });
    const host2Edge = relay.ws.connectEdge({
      hostId: "host-2",
      edgeId: "edge-2",
    });
    const client = relay.ws.connectClient({
      sessionToken: auth.sessionToken,
    });

    client.requestBotList({
      requestId: "request-list-1",
    });

    expect(host1Edge.takeClientRequests()).toEqual([
      {
        type: "client.bot.list.request",
        requestId: "request-list-1",
        deviceId: "device-1",
        hostId: "host-1",
      },
    ]);
    expect(host2Edge.takeClientRequests()).toEqual([]);
  });

  it("buffers encrypted events for short reconnect windows", () => {
    const { relay } = createTestRelay();
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
    });

    const auth = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });
    if (!auth.ok) {
      throw new Error("expected successful auth bootstrap");
    }

    const edge = relay.ws.connectEdge({
      hostId: "host-1",
      edgeId: "edge-1",
    });
    const client = relay.ws.connectClient({
      sessionToken: auth.sessionToken,
    });

    edge.publishEncryptedEvent({
      requestId: "request-stream-1",
      eventId: "event-1",
      deviceId: "device-1",
      cursor: "cursor-1",
      eventType: "edge.stream.event",
      encryptedPayload: "ciphertext-1",
    });
    expect(client.takeEvents()).toEqual([
      {
        requestId: "request-stream-1",
        eventId: "event-1",
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-1",
        eventType: "edge.stream.event",
        encryptedPayload: "ciphertext-1",
      },
    ]);

    client.disconnect();
    edge.publishEncryptedEvent({
      requestId: "request-stream-2",
      eventId: "event-2",
      deviceId: "device-1",
      cursor: "cursor-2",
      eventType: "edge.stream.event",
      encryptedPayload: "ciphertext-2",
    });

    const reconnected = relay.ws.connectClient({
      sessionToken: auth.sessionToken,
    });
    expect(reconnected.replayFromCursor("cursor-1")).toEqual([
      {
        requestId: "request-stream-2",
        eventId: "event-2",
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-2",
        eventType: "edge.stream.event",
        encryptedPayload: "ciphertext-2",
      },
    ]);
  });

  it("never persists bot config data", () => {
    const { relay } = createTestRelay();
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
    });

    expect(relay.listRelayTableNames()).toEqual([...RELAY_TABLE_NAMES]);
    expect(relay.listRelayTableNames()).not.toContain("bots");
    expect(relay.listRelayTableNames()).not.toContain("bot_configs");
    expect(relay.listRelayTableNames()).not.toContain("sessions");
    expect(relay.listRelayTableNames()).not.toContain("transcripts");
  });

  it("buffer entries expire after 5 minutes", () => {
    const { relay, advanceMs } = createTestRelay();
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
    });

    const auth = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });
    if (!auth.ok) {
      throw new Error("expected successful auth bootstrap");
    }

    const edge = relay.ws.connectEdge({
      hostId: "host-1",
      edgeId: "edge-1",
    });
    const client = relay.ws.connectClient({
      sessionToken: auth.sessionToken,
    });

    edge.publishEncryptedEvent({
      requestId: "request-stream-1",
      eventId: "event-1",
      deviceId: "device-1",
      cursor: "cursor-1",
      eventType: "edge.stream.event",
      encryptedPayload: "ciphertext-1",
    });
    edge.publishEncryptedEvent({
      requestId: "request-stream-2",
      eventId: "event-2",
      deviceId: "device-1",
      cursor: "cursor-2",
      eventType: "edge.stream.event",
      encryptedPayload: "ciphertext-2",
    });

    advanceMs(RELAY_CURSOR_TTL_MS + 1);

    expect(client.replayFromCursor("cursor-1")).toEqual([]);
    expect(
      relay.inspectReplayMetadata({
        deviceId: "device-1",
        hostId: "host-1",
      }),
    ).toEqual([]);
  });

  it("replay works only by deviceId + hostId + cursor", () => {
    const { relay } = createTestRelay();
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
    });
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-2",
      hostId: "host-1",
    });
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-2",
    });

    const authDevice1Host1 = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });
    const authDevice2Host1 = relay.http.bootstrapAuth({
      deviceId: "device-2",
      hostId: "host-1",
      deviceCredential: "credential-2",
    });
    const authDevice1Host2 = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-2",
      deviceCredential: "credential-3",
    });
    if (!authDevice1Host1.ok || !authDevice2Host1.ok || !authDevice1Host2.ok) {
      throw new Error("expected successful auth bootstrap");
    }

    const edgeHost1 = relay.ws.connectEdge({
      hostId: "host-1",
      edgeId: "edge-1",
    });
    edgeHost1.publishEncryptedEvent({
      requestId: "request-stream-1",
      eventId: "event-1",
      deviceId: "device-1",
      cursor: "cursor-1",
      eventType: "edge.stream.event",
      encryptedPayload: "ciphertext-1",
    });
    edgeHost1.publishEncryptedEvent({
      requestId: "request-stream-2",
      eventId: "event-2",
      deviceId: "device-1",
      cursor: "cursor-2",
      eventType: "edge.stream.event",
      encryptedPayload: "ciphertext-2",
    });

    const clientDevice1Host1 = relay.ws.connectClient({
      sessionToken: authDevice1Host1.sessionToken,
    });
    const clientDevice2Host1 = relay.ws.connectClient({
      sessionToken: authDevice2Host1.sessionToken,
    });
    const clientDevice1Host2 = relay.ws.connectClient({
      sessionToken: authDevice1Host2.sessionToken,
    });

    expect(clientDevice1Host1.replayFromCursor("cursor-1")).toEqual([
      expect.objectContaining({
        cursor: "cursor-2",
      }),
    ]);
    expect(clientDevice2Host1.replayFromCursor("cursor-1")).toEqual([]);
    expect(clientDevice1Host2.replayFromCursor("cursor-1")).toEqual([]);
    expect(clientDevice1Host1.replayFromCursor("unknown-cursor")).toEqual([]);
  });

  it("never stores agentId, message body, or transcript text as cleartext", () => {
    const { relay } = createTestRelay();
    bindPairedDevice(relay, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
    });

    const auth = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });
    if (!auth.ok) {
      throw new Error("expected successful auth bootstrap");
    }

    const client = relay.ws.connectClient({
      sessionToken: auth.sessionToken,
    });
    const edge = relay.ws.connectEdge({
      hostId: "host-1",
      edgeId: "edge-1",
    });
    edge.publishEncryptedEvent({
      requestId: "request-stream-1",
      eventId: "event-1",
      deviceId: "device-1",
      cursor: "cursor-1",
      eventType: "edge.stream.event",
      encryptedPayload: "ciphertext-1",
      agentId: "agent-cleartext",
      messageBody: "hello cleartext body",
      transcriptText: "cleartext transcript",
    } as never);

    const delivered = client.takeEvents();
    const metadata = relay.inspectReplayMetadata({
      deviceId: "device-1",
      hostId: "host-1",
    });
    const serialized = JSON.stringify({
      delivered,
      metadata,
    });

    expect(serialized).not.toContain("agent-cleartext");
    expect(serialized).not.toContain("hello cleartext body");
    expect(serialized).not.toContain("cleartext transcript");
    expect(delivered).toEqual([
      {
        requestId: "request-stream-1",
        eventId: "event-1",
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-1",
        eventType: "edge.stream.event",
        encryptedPayload: "ciphertext-1",
      },
    ]);
  });
});
