import { createHash } from "node:crypto";

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
  deviceCredential: string;
};

export type VerifyDeviceCredentialInput = {
  deviceId: string;
  deviceCredential: string;
};

export type AdoptLegacyDeviceCredentialInput = VerifyDeviceCredentialInput;

type DeviceRow = {
  device_id: string;
  user_id: string;
  credential_hash: string;
  created_at: string;
  updated_at: string;
};

export function registerDevice(
  database: RelayStoreDatabase,
  input: RegisterDeviceInput,
  clock: StoreClock,
) {
  const credential = normalizeDeviceCredential(input.deviceCredential);
  const timestamp = toTimestamp(clock);

  ensureUser(database, input.userId, timestamp);
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
          @credentialHash,
          @timestamp,
          @timestamp
        )
        ON CONFLICT(device_id) DO UPDATE SET
          user_id = excluded.user_id,
          credential_hash = excluded.credential_hash,
          updated_at = excluded.updated_at
      `,
    )
    .run({
      deviceId: input.deviceId,
      userId: input.userId,
      credentialHash: hashDeviceCredential(credential),
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
          credential_hash,
          created_at,
          updated_at
        FROM devices
        WHERE device_id = @deviceId
      `,
    )
    .get({ deviceId });

  return row ? mapDeviceRow(row) : null;
}

export function verifyDeviceCredential(
  database: RelayStoreDatabase,
  input: VerifyDeviceCredentialInput,
): boolean {
  const credential = input.deviceCredential.trim();
  if (credential.length === 0) {
    return false;
  }

  const row = database
    .prepare<{ deviceId: string }, Pick<DeviceRow, "credential_hash">>(
      `
        SELECT credential_hash
        FROM devices
        WHERE device_id = @deviceId
      `,
    )
    .get({
      deviceId: input.deviceId,
    });

  if (!row) {
    return false;
  }

  return row.credential_hash === hashDeviceCredential(credential);
}

export function adoptLegacyDeviceCredential(
  database: RelayStoreDatabase,
  input: AdoptLegacyDeviceCredentialInput,
): boolean {
  const credential = input.deviceCredential.trim();
  if (credential.length === 0) {
    return false;
  }

  const result = database
    .prepare(
      `
        UPDATE devices
        SET credential_hash = @credentialHash
        WHERE device_id = @deviceId
          AND credential_hash = ''
      `,
    )
    .run({
      deviceId: input.deviceId,
      credentialHash: hashDeviceCredential(credential),
    });

  return result.changes > 0;
}

function mapDeviceRow(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hashDeviceCredential(deviceCredential: string): string {
  return createHash("sha256")
    .update(deviceCredential)
    .digest("hex");
}

function normalizeDeviceCredential(deviceCredential: string): string {
  const normalized = deviceCredential.trim();
  if (normalized.length === 0) {
    throw new Error("deviceCredential must not be blank");
  }
  return normalized;
}
