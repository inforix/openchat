import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createRelayStore } from "../../../../packages/store/src/index";
import { createRelayMain } from "../main";
import { createRelayServer } from "../server";
import { createRelayWebSocketClient } from "../../../edge/src/relay-websocket-client";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "relay-network-"));
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
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("relay network server", () => {
  it("serves auth bootstrap and routes bot-list traffic between real websocket peers", async () => {
    const directory = await createTempDir();
    const store = createRelayStore({
      filename: join(directory, "relay.sqlite"),
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

    try {
      const response = await fetch(`${server.baseHttpUrl}/auth/bootstrap`, {
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
      const auth = (await response.json()) as {
        ok: boolean;
        sessionToken?: string;
      };

      expect(auth.ok).toBe(true);
      expect(auth.sessionToken).toEqual(expect.any(String));

      const edge = createRelayWebSocketClient({
        relayWebSocketUrl: `${server.baseWebSocketUrl}/relay`,
      });
      await edge.registerEdge({
        hostId: "host-1",
        edgeId: "edge-1",
        edgePublicKey: "edge-public-key",
        edgeKeyFingerprint: "edge-fingerprint",
      });

      const client = new WebSocket(
        `${server.baseWebSocketUrl}/relay?role=client&sessionToken=${auth.sessionToken}`,
      );
      await waitForOpen(client);

      client.send(
        JSON.stringify({
          type: "client.bot.list.request",
          requestId: "request-list-1",
        }),
      );

      await expect(edge.takeClientRequests()).resolves.toEqual([
        {
          type: "client.bot.list.request",
          requestId: "request-list-1",
          deviceId: "device-1",
          hostId: "host-1",
        },
      ]);

      await edge.publishEncryptedEvent({
        requestId: "request-list-1",
        eventId: "event-1",
        deviceId: "device-1",
        cursor: "cursor-1",
        eventType: "edge.session.snapshot",
        encryptedPayload: "ciphertext-1",
      });

      await expect(
        waitForJsonMessage<{
          type: string;
          event: {
            requestId: string;
            eventId: string;
            encryptedPayload: string;
          };
        }>(client),
      ).resolves.toEqual({
        type: "relay.encrypted.event",
        event: {
          requestId: "request-list-1",
          eventId: "event-1",
          deviceId: "device-1",
          hostId: "host-1",
          cursor: "cursor-1",
          eventType: "edge.session.snapshot",
          encryptedPayload: "ciphertext-1",
        },
      });

      client.close();
      await edge.close();
    } finally {
      await server.close();
    }
  });
});
