import { describe, expect, it } from "vitest";
import {
  RELAY_CURSOR_TTL_MS,
  RELAY_TABLE_NAMES,
  createRelayStore,
} from "../index";

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
  it("registers a device", () => {
    const { store } = createTestStore();

    try {
      const device = store.registerDevice({
        deviceId: "device-1",
        userId: "user-1",
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
    } finally {
      store.close();
    }
  });

  it("binds a device to a host", () => {
    const { store } = createTestStore();

    try {
      store.registerDevice({
        deviceId: "device-1",
        userId: "user-1",
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
        payload: { text: "first" },
      });
      store.appendEventCursorRecord({
        deviceId: "device-1",
        hostId: "host-1",
        cursor: "cursor-2",
        eventId: "event-2",
        payload: { text: "second" },
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
          expiresAt: new Date(
            Date.parse("2026-03-18T00:00:00.000Z") + RELAY_CURSOR_TTL_MS,
          ).toISOString(),
          payload: { text: "second" },
        }),
      ]);

      advanceMs(RELAY_CURSOR_TTL_MS + 1);

      expect(
        store.readEventCursorRecords({
          deviceId: "device-1",
          hostId: "host-1",
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
