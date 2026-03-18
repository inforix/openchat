import {
  RELAY_CURSOR_TTL_MS,
  type EventCursorRecord,
  type RelayStore,
} from "../../../packages/store/src/index";

export type RelayBufferedEvent = {
  requestId: string;
  eventId: string;
  deviceId: string;
  hostId: string;
  cursor: string;
  eventType: string;
  encryptedPayload: string;
};

type AppendRelayEventInput = {
  requestId: string;
  eventId: string;
  deviceId: string;
  hostId: string;
  cursor: string;
  eventType: string;
  encryptedPayload: string;
};

type ReplayRelayEventInput = {
  deviceId: string;
  hostId: string;
  cursor: string;
};

export type RelayEventBuffer = {
  append(input: AppendRelayEventInput): RelayBufferedEvent;
  replay(input: ReplayRelayEventInput): RelayBufferedEvent[];
  readMetadata(input: {
    deviceId: string;
    hostId: string;
    afterCursor?: string;
  }): EventCursorRecord[];
};

type CreateRelayEventBufferInput = {
  store: RelayStore;
  now: () => Date;
};

type InMemoryBufferedEvent = {
  event: RelayBufferedEvent;
  expiresAtMs: number;
};

const toBufferKey = (input: {
  deviceId: string;
  hostId: string;
  cursor: string;
}): string => `${input.deviceId}\u0000${input.hostId}\u0000${input.cursor}`;

export const createRelayEventBuffer = (
  input: CreateRelayEventBufferInput,
): RelayEventBuffer => {
  const encryptedEvents = new Map<string, InMemoryBufferedEvent>();

  const pruneExpired = () => {
    const nowMs = input.now().getTime();
    for (const [key, entry] of encryptedEvents.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        encryptedEvents.delete(key);
      }
    }
  };

  return {
    append(payload) {
      pruneExpired();
      const createdAtMs = input.now().getTime();
      const expiresAtMs = createdAtMs + RELAY_CURSOR_TTL_MS;
      const event: RelayBufferedEvent = {
        requestId: payload.requestId,
        eventId: payload.eventId,
        deviceId: payload.deviceId,
        hostId: payload.hostId,
        cursor: payload.cursor,
        eventType: payload.eventType,
        encryptedPayload: payload.encryptedPayload,
      };
      input.store.appendEventCursorRecord({
        deviceId: event.deviceId,
        hostId: event.hostId,
        cursor: event.cursor,
        eventId: event.eventId,
        requestId: event.requestId,
        eventType: event.eventType,
      });
      encryptedEvents.set(toBufferKey(event), {
        event,
        expiresAtMs,
      });

      return event;
    },

    replay(payload) {
      pruneExpired();
      const metadata = input.store.readEventCursorRecords({
        deviceId: payload.deviceId,
        hostId: payload.hostId,
        afterCursor: payload.cursor,
      });
      const replayed: RelayBufferedEvent[] = [];
      for (const record of metadata) {
        const key = toBufferKey(record);
        const entry = encryptedEvents.get(key);
        if (!entry) {
          continue;
        }
        replayed.push(entry.event);
      }

      return replayed;
    },

    readMetadata(payload) {
      pruneExpired();
      return input.store.readEventCursorRecords(payload);
    },
  };
};
