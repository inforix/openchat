import { afterEach, describe, expect, it } from "vitest";

import {
  RELAY_CURSOR_TTL_MS,
  RELAY_TABLE_NAMES,
  createRelayStore,
  type RelayStore,
} from "../../../../packages/store/src/index";

import { createRelayAuth } from "../auth";
import { createRelayMain, type RelayMain } from "../index";

type TestRelay = {
  relay: RelayMain;
  store: RelayStore;
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
    store,
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

const bindPairedDevice = (store: RelayStore, input: {
  userId: string;
  deviceId: string;
  hostId: string;
  deviceCredential: string;
}) => {
  store.registerDevice({
    deviceId: input.deviceId,
    userId: input.userId,
    deviceCredential: input.deviceCredential,
  });
  store.registerHost({
    hostId: input.hostId,
    userId: input.userId,
  });
  store.bindDeviceToHost({
    deviceId: input.deviceId,
    hostId: input.hostId,
  });
};

describe("relay service", () => {
  it("device can authenticate and connect", () => {
    const { relay, store } = createTestRelay();
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
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
    const { relay, store } = createTestRelay();
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });

    const paired = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
      claimedEdgeKeyFingerprint: "forged-edge-key",
    });
    const invalidCredential = relay.http.bootstrapAuth({
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "wrong-credential",
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
    expect(invalidCredential).toEqual({
      ok: false,
      reason: "invalid_device_credential",
    });
    expect(unpaired).toEqual({
      ok: false,
      reason: "device_host_not_paired",
    });
  });

  it("does not adopt a legacy credential before confirming device-host pairing", () => {
    const calls: string[] = [];
    const store = {
      registerDevice() {
        throw new Error("not used");
      },
      getDevice() {
        return null;
      },
      verifyDeviceCredential() {
        calls.push("verify");
        return false;
      },
      adoptLegacyDeviceCredential() {
        calls.push("adopt");
        return true;
      },
      registerHost() {
        throw new Error("not used");
      },
      bindDeviceToHost() {
        throw new Error("not used");
      },
      listDeviceHostBindings() {
        calls.push("listBindings");
        return [];
      },
      setEdgeConnectionState() {
        throw new Error("not used");
      },
      getEdgeConnectionState() {
        return null;
      },
      appendEventCursorRecord() {
        throw new Error("not used");
      },
      readEventCursorRecords() {
        return [];
      },
      listTableNames() {
        return [...RELAY_TABLE_NAMES];
      },
      close() {},
    } satisfies RelayStore;

    const auth = createRelayAuth({
      store,
      now: () => new Date("2026-03-18T00:00:00.000Z"),
    });

    expect(
      auth.bootstrap({
        deviceId: "device-legacy",
        hostId: "host-unpaired",
        deviceCredential: "credential-1",
      }),
    ).toEqual({
      ok: false,
      reason: "device_host_not_paired",
    });
    expect(calls).toEqual(["listBindings"]);
  });

  it("routes a bot list request to the correct host", () => {
    const { relay, store } = createTestRelay();
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-2",
      deviceCredential: "credential-1",
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
    const { relay, store } = createTestRelay();
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
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
    const { store } = createTestRelay();
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });

    expect(store.listTableNames()).toEqual([...RELAY_TABLE_NAMES]);
    expect(store.listTableNames()).not.toContain("bots");
    expect(store.listTableNames()).not.toContain("bot_configs");
    expect(store.listTableNames()).not.toContain("sessions");
    expect(store.listTableNames()).not.toContain("transcripts");
  });

  it("buffer entries expire after 5 minutes", () => {
    const { relay, store, advanceMs } = createTestRelay();
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
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
      store.readEventCursorRecords({
        deviceId: "device-1",
        hostId: "host-1",
        afterCursor: "cursor-1",
      }),
    ).toEqual([]);
  });

  it("replay works only by deviceId + hostId + cursor", () => {
    const { relay, store } = createTestRelay();
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
    });
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-2",
      hostId: "host-1",
      deviceCredential: "credential-2",
    });
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-2",
      deviceCredential: "credential-1",
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
      deviceCredential: "credential-1",
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
    const { relay, store } = createTestRelay();
    bindPairedDevice(store, {
      userId: "user-1",
      deviceId: "device-1",
      hostId: "host-1",
      deviceCredential: "credential-1",
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
      requestId: "request-stream-0",
      eventId: "event-0",
      deviceId: "device-1",
      cursor: "cursor-0",
      eventType: "edge.stream.event",
      encryptedPayload: "ciphertext-0",
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
    const metadata = store.readEventCursorRecords({
      deviceId: "device-1",
      hostId: "host-1",
      afterCursor: "cursor-0",
    });
    const serialized = JSON.stringify({
      delivered,
      metadata,
    });

    expect(serialized).not.toContain("agent-cleartext");
    expect(serialized).not.toContain("hello cleartext body");
    expect(serialized).not.toContain("cleartext transcript");
    expect(serialized).not.toContain("createdAt");
    expect(delivered).toEqual([
      {
        requestId: "request-stream-0",
        eventId: "event-0",
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-0",
        eventType: "edge.stream.event",
        encryptedPayload: "ciphertext-0",
      },
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
