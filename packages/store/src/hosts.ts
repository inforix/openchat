import type { StoreClock, RelayStoreDatabase } from "./schema";
import { ensureUser, toTimestamp } from "./schema";

export type HostRecord = {
  hostId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
};

export type RegisterHostInput = {
  hostId: string;
  userId: string;
};

export type DeviceHostBindingRecord = {
  deviceId: string;
  hostId: string;
  createdAt: string;
  updatedAt: string;
};

export type BindDeviceToHostInput = {
  deviceId: string;
  hostId: string;
};

export type EdgeConnectionRecord = {
  deviceId: string;
  hostId: string;
  edgeId: string;
  online: boolean;
  connectedAt: string | null;
  updatedAt: string;
};

export type SetEdgeConnectionStateInput = {
  deviceId: string;
  hostId: string;
  edgeId: string;
  online: boolean;
};

export type GetEdgeConnectionStateInput = {
  deviceId: string;
  hostId: string;
};

type HostRow = {
  host_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
};

type DeviceHostBindingRow = {
  device_id: string;
  host_id: string;
  created_at: string;
  updated_at: string;
};

type EdgeConnectionRow = {
  device_id: string;
  host_id: string;
  edge_id: string;
  online: number;
  connected_at: string | null;
  updated_at: string;
};

export function registerHost(
  database: RelayStoreDatabase,
  input: RegisterHostInput,
  clock: StoreClock,
) {
  const timestamp = toTimestamp(clock);

  ensureUser(database, input.userId, timestamp);
  database
    .prepare(
      `
        INSERT INTO hosts (host_id, user_id, created_at, updated_at)
        VALUES (@hostId, @userId, @timestamp, @timestamp)
        ON CONFLICT(host_id) DO UPDATE SET
          user_id = excluded.user_id,
          updated_at = excluded.updated_at
      `,
    )
    .run({
      hostId: input.hostId,
      userId: input.userId,
      timestamp,
    });

  const host = getHost(database, input.hostId);
  if (!host) {
    throw new Error(`host ${input.hostId} was not persisted`);
  }

  return host;
}

export function bindDeviceToHost(
  database: RelayStoreDatabase,
  input: BindDeviceToHostInput,
  clock: StoreClock,
) {
  const timestamp = toTimestamp(clock);

  database
    .prepare(
      `
        INSERT INTO device_host_bindings (device_id, host_id, created_at, updated_at)
        VALUES (@deviceId, @hostId, @timestamp, @timestamp)
        ON CONFLICT(device_id, host_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `,
    )
    .run({
      deviceId: input.deviceId,
      hostId: input.hostId,
      timestamp,
    });

  const binding = getDeviceHostBinding(database, input);
  if (!binding) {
    throw new Error(
      `device ${input.deviceId} was not bound to host ${input.hostId}`,
    );
  }

  return binding;
}

export function listDeviceHostBindings(
  database: RelayStoreDatabase,
  deviceId: string,
) {
  const rows = database
    .prepare<{ deviceId: string }, DeviceHostBindingRow>(
      `
        SELECT
          device_id,
          host_id,
          created_at,
          updated_at
        FROM device_host_bindings
        WHERE device_id = @deviceId
        ORDER BY host_id ASC
      `,
    )
    .all({ deviceId });

  return rows.map(mapDeviceHostBindingRow);
}

export function setEdgeConnectionState(
  database: RelayStoreDatabase,
  input: SetEdgeConnectionStateInput,
  clock: StoreClock,
) {
  const timestamp = toTimestamp(clock);

  database
    .prepare(
      `
        INSERT INTO edge_connections (
          device_id,
          host_id,
          edge_id,
          online,
          connected_at,
          updated_at
        )
        VALUES (
          @deviceId,
          @hostId,
          @edgeId,
          @online,
          @connectedAt,
          @updatedAt
        )
        ON CONFLICT(device_id, host_id) DO UPDATE SET
          edge_id = excluded.edge_id,
          online = excluded.online,
          connected_at = excluded.connected_at,
          updated_at = excluded.updated_at
      `,
    )
    .run({
      deviceId: input.deviceId,
      hostId: input.hostId,
      edgeId: input.edgeId,
      online: Number(input.online),
      connectedAt: input.online ? timestamp : null,
      updatedAt: timestamp,
    });

  const state = getEdgeConnectionState(database, input);
  if (!state) {
    throw new Error(
      `edge connection state missing for device ${input.deviceId} and host ${input.hostId}`,
    );
  }

  return state;
}

export function getEdgeConnectionState(
  database: RelayStoreDatabase,
  input: GetEdgeConnectionStateInput,
): EdgeConnectionRecord | null {
  const row = database
    .prepare<GetEdgeConnectionStateInput, EdgeConnectionRow>(
      `
        SELECT
          device_id,
          host_id,
          edge_id,
          online,
          connected_at,
          updated_at
        FROM edge_connections
        WHERE device_id = @deviceId
          AND host_id = @hostId
      `,
    )
    .get(input);

  return row ? mapEdgeConnectionRow(row) : null;
}

function getHost(
  database: RelayStoreDatabase,
  hostId: string,
): HostRecord | null {
  const row = database
    .prepare<{ hostId: string }, HostRow>(
      `
        SELECT
          host_id,
          user_id,
          created_at,
          updated_at
        FROM hosts
        WHERE host_id = @hostId
      `,
    )
    .get({ hostId });

  return row ? mapHostRow(row) : null;
}

function getDeviceHostBinding(
  database: RelayStoreDatabase,
  input: BindDeviceToHostInput,
): DeviceHostBindingRecord | null {
  const row = database
    .prepare<BindDeviceToHostInput, DeviceHostBindingRow>(
      `
        SELECT
          device_id,
          host_id,
          created_at,
          updated_at
        FROM device_host_bindings
        WHERE device_id = @deviceId
          AND host_id = @hostId
      `,
    )
    .get(input);

  return row ? mapDeviceHostBindingRow(row) : null;
}

function mapHostRow(row: HostRow): HostRecord {
  return {
    hostId: row.host_id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeviceHostBindingRow(
  row: DeviceHostBindingRow,
): DeviceHostBindingRecord {
  return {
    deviceId: row.device_id,
    hostId: row.host_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEdgeConnectionRow(row: EdgeConnectionRow): EdgeConnectionRecord {
  return {
    deviceId: row.device_id,
    hostId: row.host_id,
    edgeId: row.edge_id,
    online: Boolean(row.online),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}
