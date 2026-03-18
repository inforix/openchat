import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import Fastify, { type FastifyInstance } from "fastify";
import {
  WebSocketServer,
  type RawData,
  type WebSocket,
} from "ws";

import type { RelayMain } from "./main";
import type { RelayBufferedEvent } from "./buffer";
import type { ClientConnection, EdgeConnection } from "./ws";

type ClientBotListRequestMessage = {
  type: "client.bot.list.request";
  requestId: string;
};

type ClientSessionSnapshotRequestMessage = {
  type: "client.session.snapshot.request";
  requestId: string;
  accountId: string;
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

type RelayEncryptedEventMessage = {
  type: "relay.encrypted.event";
  event: RelayBufferedEvent;
};

export type RelayServer = {
  readonly baseHttpUrl: string;
  readonly baseWebSocketUrl: string;
  start(): Promise<void>;
  close(): Promise<void>;
};

export type CreateRelayServerInput = {
  relay: RelayMain;
  host: string;
  port: number;
};

type ClientPeer = {
  socket: WebSocket;
  connection: ClientConnection;
};

type EdgePeer = {
  socket: WebSocket;
  connection: EdgeConnection;
};

const parseJsonMessage = (data: RawData): unknown => {
  const text =
    typeof data === "string"
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data.toString("utf8");

  return JSON.parse(text) as unknown;
};

const isClientBotListRequestMessage = (
  value: unknown,
): value is ClientBotListRequestMessage => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "client.bot.list.request" &&
    typeof candidate.requestId === "string"
  );
};

const isClientSessionSnapshotRequestMessage = (
  value: unknown,
): value is ClientSessionSnapshotRequestMessage => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "client.session.snapshot.request" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.accountId === "string"
  );
};

const isEdgePublishEncryptedEventMessage = (
  value: unknown,
): value is EdgePublishEncryptedEventMessage => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "edge.publish.encrypted.event" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.eventId === "string" &&
    typeof candidate.deviceId === "string" &&
    typeof candidate.cursor === "string" &&
    typeof candidate.eventType === "string" &&
    typeof candidate.encryptedPayload === "string"
  );
};

const toRelayEventMessage = (
  event: RelayBufferedEvent,
): RelayEncryptedEventMessage => ({
  type: "relay.encrypted.event",
  event,
});

const sendJson = (socket: WebSocket, payload: unknown): void => {
  if (socket.readyState !== socket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
};

const closeForProtocolError = (socket: WebSocket, reason: string): void => {
  socket.close(1008, reason);
};

export const createRelayServer = (
  input: CreateRelayServerInput,
): RelayServer => {
  const app = Fastify();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientPeer>();
  const edgePeers = new Map<string, EdgePeer>();
  let baseHttpUrl = "";
  let baseWebSocketUrl = "";

  const flushClientPeer = (peer: ClientPeer): void => {
    for (const event of peer.connection.takeEvents()) {
      sendJson(peer.socket, toRelayEventMessage(event));
    }
  };

  const flushAllClients = (): void => {
    for (const peer of clients) {
      flushClientPeer(peer);
    }
  };

  const flushEdgePeer = (peer: EdgePeer): void => {
    for (const request of peer.connection.takeClientRequests()) {
      sendJson(peer.socket, request);
    }
  };

  const cleanupClientPeer = (peer: ClientPeer): void => {
    clients.delete(peer);
    peer.connection.disconnect();
  };

  const cleanupEdgePeer = (peer: EdgePeer): void => {
    const current = edgePeers.get(peer.connection.hostId);
    if (current === peer) {
      edgePeers.delete(peer.connection.hostId);
    }
    peer.connection.disconnect();
  };

  const handleClientSocket = (
    socket: WebSocket,
    requestUrl: URL,
  ): void => {
    const sessionToken = requestUrl.searchParams.get("sessionToken");
    if (!sessionToken) {
      closeForProtocolError(socket, "missing sessionToken");
      return;
    }

    let connection: ClientConnection;
    try {
      connection = input.relay.ws.connectClient({
        sessionToken,
      });
    } catch {
      closeForProtocolError(socket, "invalid sessionToken");
      return;
    }

    const peer: ClientPeer = {
      socket,
      connection,
    };
    clients.add(peer);

    const replayCursor = requestUrl.searchParams.get("cursor");
    if (replayCursor) {
      for (const event of connection.replayFromCursor(replayCursor)) {
        sendJson(socket, toRelayEventMessage(event));
      }
    }

    socket.on("message", (raw) => {
      let payload: unknown;
      try {
        payload = parseJsonMessage(raw);
      } catch {
        closeForProtocolError(socket, "invalid json");
        return;
      }

      if (isClientBotListRequestMessage(payload)) {
        connection.requestBotList({
          requestId: payload.requestId,
        });
        const edgePeer = edgePeers.get(connection.session.hostId);
        if (edgePeer) {
          flushEdgePeer(edgePeer);
        }
        return;
      }

      if (isClientSessionSnapshotRequestMessage(payload)) {
        connection.requestSessionSnapshot({
          requestId: payload.requestId,
          accountId: payload.accountId,
        });
        const edgePeer = edgePeers.get(connection.session.hostId);
        if (edgePeer) {
          flushEdgePeer(edgePeer);
        }
        return;
      }

      if (!isClientBotListRequestMessage(payload)) {
        closeForProtocolError(socket, "unsupported client message");
        return;
      }
    });

    socket.on("close", () => {
      cleanupClientPeer(peer);
    });
  };

  const handleEdgeSocket = (socket: WebSocket, requestUrl: URL): void => {
    const hostId = requestUrl.searchParams.get("hostId");
    const edgeId = requestUrl.searchParams.get("edgeId");
    if (!hostId || !edgeId) {
      closeForProtocolError(socket, "missing hostId or edgeId");
      return;
    }

    const connection = input.relay.ws.connectEdge({
      hostId,
      edgeId,
    });
    const peer: EdgePeer = {
      socket,
      connection,
    };
    const previous = edgePeers.get(hostId);
    if (previous) {
      previous.socket.close(1012, "edge replaced");
      cleanupEdgePeer(previous);
    }
    edgePeers.set(hostId, peer);

    socket.on("message", (raw) => {
      let payload: unknown;
      try {
        payload = parseJsonMessage(raw);
      } catch {
        closeForProtocolError(socket, "invalid json");
        return;
      }

      if (!isEdgePublishEncryptedEventMessage(payload)) {
        closeForProtocolError(socket, "unsupported edge message");
        return;
      }

      connection.publishEncryptedEvent({
        requestId: payload.requestId,
        eventId: payload.eventId,
        deviceId: payload.deviceId,
        cursor: payload.cursor,
        eventType: payload.eventType,
        encryptedPayload: payload.encryptedPayload,
      });
      flushAllClients();
    });

    socket.on("close", () => {
      cleanupEdgePeer(peer);
    });
  };

  const handleUpgrade = (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? input.host}`);
    if (requestUrl.pathname !== "/relay") {
      socket.destroy();
      return;
    }

    const role = requestUrl.searchParams.get("role");
    if (role !== "client" && role !== "edge") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      if (role === "client") {
        handleClientSocket(websocket, requestUrl);
        return;
      }

      handleEdgeSocket(websocket, requestUrl);
    });
  };

  app.post("/auth/bootstrap", async (request, reply) => {
    const result = input.relay.http.bootstrapAuth(request.body as {
      deviceId: string;
      hostId: string;
      deviceCredential: string;
      claimedEdgeKeyFingerprint?: string;
    });
    return reply.send(result);
  });

  app.server.on("upgrade", handleUpgrade);

  return {
    get baseHttpUrl() {
      return baseHttpUrl;
    },

    get baseWebSocketUrl() {
      return baseWebSocketUrl;
    },

    async start(): Promise<void> {
      await app.listen({
        host: input.host,
        port: input.port,
      });

      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("relay server did not expose a TCP address");
      }

      baseHttpUrl = `http://${address.address}:${address.port}`;
      baseWebSocketUrl = `ws://${address.address}:${address.port}`;
    },

    async close(): Promise<void> {
      for (const peer of clients) {
        peer.socket.close();
        cleanupClientPeer(peer);
      }
      for (const peer of edgePeers.values()) {
        peer.socket.close();
        cleanupEdgePeer(peer);
      }
      wss.close();
      app.server.off("upgrade", handleUpgrade);
      await app.close();
      input.relay.close();
    },
  };
};
