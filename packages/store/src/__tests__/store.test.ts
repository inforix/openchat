import { describe, expect, it } from "vitest";
import {
  RELAY_CURSOR_TTL_MS,
  RELAY_TABLE_NAMES,
  createRelayStore,
} from "../index";
import {
  adoptLegacyDeviceCredential,
  verifyDeviceCredential,
} from "../devices";
import { ensureUser, openRelayDatabase } from "../schema";

function createTestStore(initialNow = "2026-03-18T00:00:00.000Z") {
  let currentNow = Date.parse(initialNow);
  const store = createRelayStore({
    filename: ":memory:",
    now: () => new Date(currentNow),
  });

  return {
    store,
    advanceMs(ms: number) {
      currentNow += ms;
    },
  };
}

describe("relay metadata store", () => {
  it("rejects blank device credentials at registration", () => {
    const { store } = createTestStore();

    try {
      expect(() =>
        store.registerDevice({
          deviceId: "device-1",
          userId: "user-1",
          deviceCredential: "   ",
        }),
      ).toThrow(/credential/i);
    } finally {
      store.close();
    }
  });

  it("registers a device", () => {
    const { store } = createTestStore();

    try {
      const device = store.registerDevice({
        deviceId: "device-1",
        userId: "user-1",
        deviceCredential: "credential-1",
      });

      expect(device).toMatchObject({
        deviceId: "device-1",
        userId: "user-1",
      });
      expect(device.createdAt).toEqual(expect.any(String));
      expect(device.updatedAt).toEqual(expect.any(String));
      expect(store.getDevice("device-1")).toMatchObject({
        deviceId: "device-1",
        userId: "user-1",
      });
      expect(
        store.verifyDeviceCredential({
          deviceId: "device-1",
          deviceCredential: "credential-1",
        }),
      ).toBe(true);
      expect(
        store.verifyDeviceCredential({
          deviceId: "device-1",
          deviceCredential: "wrong-credential",
        }),
      ).toBe(false);
    } finally {
      store.close();
    }
  });

  it("adopts a credential for legacy device rows that predate credential hashes", () => {
    const database = openRelayDatabase(":memory:");

    try {
      ensureUser(database, "user-1", "2026-03-18T00:00:00.000Z");
      database
        .prepare(
          `
            INSERT INTO devices (
              device_id,
              user_id,
              credential_hash,
              created_at,
              updated_at
            )
            VALUES (
              @deviceId,
              @userId,
              '',
              @createdAt,
              @updatedAt
            )
          `,
        )
        .run({
          deviceId: "device-legacy",
          userId: "user-1",
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        });

      expect(
        adoptLegacyDeviceCredential(database, {
          deviceId: "device-legacy",
          deviceCredential: "credential-1",
        }),
      ).toBe(true);
      expect(
        verifyDeviceCredential(database, {
          deviceId: "device-legacy",
          deviceCredential: "credential-1",
        }),
      ).toBe(true);
      expect(
        verifyDeviceCredential(database, {
          deviceId: "device-legacy",
          deviceCredential: "wrong-credential",
        }),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it("binds a device to a host", () => {
    const { store } = createTestStore();

    try {
      store.registerDevice({
        deviceId: "device-1",
        userId: "user-1",
        deviceCredential: "credential-1",
      });
      store.registerHost({
        hostId: "host-1",
        userId: "user-1",
      });

      const binding = store.bindDeviceToHost({
        deviceId: "device-1",
        hostId: "host-1",
      });

      expect(binding).toMatchObject({
        deviceId: "device-1",
        hostId: "host-1",
      });
      expect(store.listDeviceHostBindings("device-1")).toEqual([
        expect.objectContaining({
          deviceId: "device-1",
          hostId: "host-1",
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("stores edge online state by device and host", () => {
    const { store } = createTestStore();

    try {
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

      store.setEdgeConnectionState({
        deviceId: "device-1",
        hostId: "host-1",
        edgeId: "edge-1",
        online: true,
      });

      expect(
        store.getEdgeConnectionState({
          deviceId: "device-1",
          hostId: "host-1",
        }),
      ).toMatchObject({
        deviceId: "device-1",
        hostId: "host-1",
        edgeId: "edge-1",
        online: true,
      });
    } finally {
      store.close();
    }
  });

  it("stores and reads short-lived event cursor records", () => {
    const { store, advanceMs } = createTestStore();

    try {
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

      store.appendEventCursorRecord({
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-1",
        eventId: "event-1",
        requestId: "request-1",
        eventType: "edge.hello",
      });
      store.appendEventCursorRecord({
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-2",
        eventId: "event-2",
        requestId: "request-2",
        eventType: "edge.stream.event",
      });

      expect(
        store.readEventCursorRecords({
          deviceId: "device-1",
          hostId: "host-1",
          afterCursor: "cursor-1",
        }),
      ).toEqual([
        expect.objectContaining({
          cursor: "cursor-2",
          eventId: "event-2",
          requestId: "request-2",
          eventType: "edge.stream.event",
          expiresAt: new Date(
            Date.parse("2026-03-18T00:00:00.000Z") + RELAY_CURSOR_TTL_MS,
          ).toISOString(),
        }),
      ]);

      advanceMs(RELAY_CURSOR_TTL_MS + 1);

      expect(
        store.readEventCursorRecords({
          deviceId: "device-1",
          hostId: "host-1",
          afterCursor: "cursor-1",
        }),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("persists only replay metadata for cursor records", () => {
    const { store } = createTestStore();

    try {
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

      store.appendEventCursorRecord({
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-0",
        eventId: "event-0",
        requestId: "request-0",
        eventType: "edge.hello",
      });

      store.appendEventCursorRecord({
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-1",
        eventId: "event-1",
        requestId: "request-1",
        eventType: "edge.stream.event",
        body: "cleartext transcript content",
      } as never);

      expect(
        store.readEventCursorRecords({
          deviceId: "device-1",
          hostId: "host-1",
          afterCursor: "cursor-0",
        }),
      ).toEqual([
        {
          deviceId: "device-1",
          hostId: "host-1",
          cursor: "cursor-1",
          eventId: "event-1",
          requestId: "request-1",
          eventType: "edge.stream.event",
          expiresAt: new Date(
            Date.parse("2026-03-18T00:00:00.000Z") + RELAY_CURSOR_TTL_MS,
          ).toISOString(),
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("does not replay from the start when afterCursor is unknown or expired", () => {
    const { store, advanceMs } = createTestStore();

    try {
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

      store.appendEventCursorRecord({
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-1",
        eventId: "event-1",
        requestId: "request-1",
        eventType: "edge.hello",
      });

      expect(
        store.readEventCursorRecords({
          deviceId: "device-1",
          hostId: "host-1",
          afterCursor: "missing-cursor",
        }),
      ).toEqual([]);

      advanceMs(RELAY_CURSOR_TTL_MS - 1_000);

      store.appendEventCursorRecord({
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-2",
        eventId: "event-2",
        requestId: "request-2",
        eventType: "edge.stream.event",
      });

      advanceMs(1_001);

      expect(
        store.readEventCursorRecords({
          deviceId: "device-1",
          hostId: "host-1",
          afterCursor: "cursor-1",
        }),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("persists only relay metadata tables and excludes bot config tables", () => {
    const { store } = createTestStore();

    try {
      expect(RELAY_TABLE_NAMES).toEqual([
        "device_host_bindings",
        "devices",
        "edge_connections",
        "event_cursors",
        "hosts",
        "push_tokens",
        "users",
      ]);
      expect(store.listTableNames()).toEqual(RELAY_TABLE_NAMES);
      expect(store.listTableNames()).not.toContain("bot_accounts");
      expect(store.listTableNames()).not.toContain("sessions");
      expect(store.listTableNames()).not.toContain("bot_configs");
    } finally {
      store.close();
    }
  });
});
