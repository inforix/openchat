import type { StoreClock, RelayStoreDatabase } from "./schema";
import { ensureUser, toTimestamp } from "./schema";

export type DeviceRecord = {
  deviceId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
};

export type RegisterDeviceInput = {
  deviceId: string;
  userId: string;
};

type DeviceRow = {
  device_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
};

export function registerDevice(
  database: RelayStoreDatabase,
  input: RegisterDeviceInput,
  clock: StoreClock,
) {
  const timestamp = toTimestamp(clock);

  ensureUser(database, input.userId, timestamp);
  database
    .prepare(
      `
        INSERT INTO devices (device_id, user_id, created_at, updated_at)
        VALUES (@deviceId, @userId, @timestamp, @timestamp)
        ON CONFLICT(device_id) DO UPDATE SET
          user_id = excluded.user_id,
          updated_at = excluded.updated_at
      `,
    )
    .run({
      deviceId: input.deviceId,
      userId: input.userId,
      timestamp,
    });

  const device = getDevice(database, input.deviceId);
  if (!device) {
    throw new Error(`device ${input.deviceId} was not persisted`);
  }

  return device;
}

export function getDevice(
  database: RelayStoreDatabase,
  deviceId: string,
): DeviceRecord | null {
  const row = database
    .prepare<{ deviceId: string }, DeviceRow>(
      `
        SELECT
          device_id,
          user_id,
          created_at,
          updated_at
        FROM devices
        WHERE device_id = @deviceId
      `,
    )
    .get({ deviceId });

  return row ? mapDeviceRow(row) : null;
}

function mapDeviceRow(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
