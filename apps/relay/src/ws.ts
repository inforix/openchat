import type { RelayStore } from "../../../packages/store/src/index";

import type { RelayAuth } from "./auth";
import type { RelayBufferedEvent, RelayEventBuffer } from "./buffer";
import type {
  ClientBotListRequest,
  ClientHostRequest,
  HostAwareRouter,
} from "./router";

export type ClientConnection = {
  session: {
    deviceId: string;
    hostId: string;
  };
  requestBotList(input: { requestId: string }): void;
  requestSessionSnapshot(input: { requestId: string; accountId: string }): void;
  replayFromCursor(cursor: string): RelayBufferedEvent[];
  takeEvents(): RelayBufferedEvent[];
  disconnect(): void;
};

export type EdgeConnection = {
  hostId: string;
  edgeId: string;
  publishEncryptedEvent(input: {
    requestId: string;
    eventId: string;
    deviceId: string;
    cursor: string;
    eventType: string;
    encryptedPayload: string;
  }): RelayBufferedEvent;
  takeClientRequests(): ClientHostRequest[];
  disconnect(): void;
};

export type RelayWsService = {
  connectClient(input: { sessionToken: string }): ClientConnection;
  connectEdge(input: { hostId: string; edgeId: string }): EdgeConnection;
};

export type CreateRelayWsServiceInput = {
  auth: RelayAuth;
  router: HostAwareRouter;
  buffer: RelayEventBuffer;
  store: RelayStore;
};

type LiveClient = {
  deviceId: string;
  hostId: string;
  events: RelayBufferedEvent[];
};

const forwardEvent = (
  clients: Set<LiveClient>,
  event: RelayBufferedEvent,
): void => {
  for (const client of clients) {
    if (client.deviceId !== event.deviceId || client.hostId !== event.hostId) {
      continue;
    }
    client.events.push(event);
  }
};

export const createRelayWsService = (
  input: CreateRelayWsServiceInput,
): RelayWsService => {
  const clients = new Set<LiveClient>();

  return {
    connectClient(payload) {
      const session = input.auth.resolveSession(payload.sessionToken);
      if (!session) {
        throw new Error("invalid relay session token");
      }

      const client: LiveClient = {
        deviceId: session.deviceId,
        hostId: session.hostId,
        events: [],
      };
      clients.add(client);

      return {
        session: {
          deviceId: session.deviceId,
          hostId: session.hostId,
        },
        requestBotList(request) {
          input.router.routeBotListRequest({
            type: "client.bot.list.request",
            requestId: request.requestId,
            deviceId: session.deviceId,
            hostId: session.hostId,
          });
        },
        requestSessionSnapshot(request) {
          input.router.routeSessionSnapshotRequest({
            type: "client.session.snapshot.request",
            requestId: request.requestId,
            deviceId: session.deviceId,
            hostId: session.hostId,
            accountId: request.accountId,
          });
        },
        replayFromCursor(cursor) {
          return input.buffer.replay({
            deviceId: session.deviceId,
            hostId: session.hostId,
            cursor,
          });
        },
        takeEvents() {
          const events = [...client.events];
          client.events.length = 0;
          return events;
        },
        disconnect() {
          clients.delete(client);
        },
      };
    },

    connectEdge(payload) {
      const clientRequests: ClientHostRequest[] = [];
      const detach = input.router.attachHost(payload.hostId, (request) => {
        clientRequests.push(request);
      });

      return {
        hostId: payload.hostId,
        edgeId: payload.edgeId,
        publishEncryptedEvent(event) {
          const buffered = input.buffer.append({
            requestId: event.requestId,
            eventId: event.eventId,
            deviceId: event.deviceId,
            hostId: payload.hostId,
            cursor: event.cursor,
            eventType: event.eventType,
            encryptedPayload: event.encryptedPayload,
          });
          input.store.setEdgeConnectionState({
            deviceId: event.deviceId,
            hostId: payload.hostId,
            edgeId: payload.edgeId,
            online: true,
          });
          forwardEvent(clients, buffered);
          return buffered;
        },
        takeClientRequests() {
          const requests = [...clientRequests];
          clientRequests.length = 0;
          return requests;
        },
        disconnect() {
          detach();
        },
      };
    },
  };
};
