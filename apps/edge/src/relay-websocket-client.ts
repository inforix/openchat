import { WebSocket } from "ws";

import type { RelayRegistration } from "./relay-tunnel";

export type RelayClientBotListRequest = {
  type: "client.bot.list.request";
  requestId: string;
  deviceId: string;
  hostId: string;
};

export type RelayWebSocketClient = {
  registerEdge(input: RelayRegistration): Promise<void>;
  takeClientRequests(): Promise<RelayClientBotListRequest[]>;
  publishEncryptedEvent(input: {
    requestId: string;
    eventId: string;
    deviceId: string;
    cursor: string;
    eventType: string;
    encryptedPayload: string;
  }): Promise<void>;
  close(): Promise<void>;
};

export type CreateRelayWebSocketClientInput = {
  relayWebSocketUrl: string;
};

type EdgePublishEncryptedEventMessage = {
  type: "edge.publish.encrypted.event";
  requestId: string;
  eventId: string;
  deviceId: string;
  cursor: string;
  eventType: string;
  encryptedPayload: string;
};

const isClientBotListRequest = (
  value: unknown,
): value is RelayClientBotListRequest => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "client.bot.list.request" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.deviceId === "string" &&
    typeof candidate.hostId === "string"
  );
};

const toPublishMessage = (input: {
  requestId: string;
  eventId: string;
  deviceId: string;
  cursor: string;
  eventType: string;
  encryptedPayload: string;
}): EdgePublishEncryptedEventMessage => ({
  type: "edge.publish.encrypted.event",
  requestId: input.requestId,
  eventId: input.eventId,
  deviceId: input.deviceId,
  cursor: input.cursor,
  eventType: input.eventType,
  encryptedPayload: input.encryptedPayload,
});

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

const waitForClosed = async (socket: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (socket.readyState === socket.CLOSED) {
      resolve();
      return;
    }

    socket.once("close", () => {
      resolve();
    });
  });

export const createRelayWebSocketClient = (
  input: CreateRelayWebSocketClientInput,
): RelayWebSocketClient => {
  let socket: WebSocket | null = null;
  const requestQueue: RelayClientBotListRequest[] = [];
  const pendingTakeResolvers: Array<
    (requests: RelayClientBotListRequest[]) => void
  > = [];

  const drainQueuedRequests = (): RelayClientBotListRequest[] => {
    const requests = [...requestQueue];
    requestQueue.length = 0;
    return requests;
  };

  const resolvePendingTake = (): void => {
    if (requestQueue.length === 0 || pendingTakeResolvers.length === 0) {
      return;
    }

    const resolve = pendingTakeResolvers.shift();
    resolve?.(drainQueuedRequests());
  };

  return {
    async registerEdge(registration): Promise<void> {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        throw new Error("relay websocket client is already registered");
      }

      const url = new URL(input.relayWebSocketUrl);
      url.searchParams.set("role", "edge");
      url.searchParams.set("hostId", registration.hostId);
      url.searchParams.set("edgeId", registration.edgeId);
      url.searchParams.set("edgePublicKey", registration.edgePublicKey);
      url.searchParams.set(
        "edgeKeyFingerprint",
        registration.edgeKeyFingerprint,
      );

      socket = new WebSocket(url);
      socket.on("message", (raw) => {
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8")) as unknown;
        } catch {
          return;
        }

        if (!isClientBotListRequest(payload)) {
          return;
        }

        requestQueue.push(payload);
        resolvePendingTake();
      });

      await waitForOpen(socket);
    },

    async takeClientRequests(): Promise<RelayClientBotListRequest[]> {
      if (requestQueue.length > 0) {
        return drainQueuedRequests();
      }

      return new Promise((resolve) => {
        pendingTakeResolvers.push(resolve);
      });
    },

    async publishEncryptedEvent(event): Promise<void> {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("relay websocket client is not connected");
      }

      socket.send(JSON.stringify(toPublishMessage(event)));
    },

    async close(): Promise<void> {
      if (!socket) {
        return;
      }

      const current = socket;
      socket = null;
      current.close();
      await waitForClosed(current);
    },
  };
};
