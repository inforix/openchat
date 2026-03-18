import type { StoreClock, RelayStoreDatabase } from "./schema";
import { RELAY_CURSOR_TTL_MS, toTimestamp } from "./schema";

export type EventCursorRecord = {
  deviceId: string;
  hostId: string;
  cursor: string;
  eventId: string;
  requestId: string;
  eventType: string;
  expiresAt: string;
};

export type AppendEventCursorRecordInput = {
  deviceId: string;
  hostId: string;
  cursor: string;
  eventId: string;
  requestId: string;
  eventType: string;
};

export type ReadEventCursorRecordsInput = {
  deviceId: string;
  hostId: string;
  afterCursor: string;
};

type EventCursorRow = {
  device_id: string;
  host_id: string;
  cursor: string;
  event_id: string;
  request_id: string;
  event_type: string;
  expires_at: string;
};

export function appendEventCursorRecord(
  database: RelayStoreDatabase,
  input: AppendEventCursorRecordInput,
  clock: StoreClock,
) {
  pruneExpiredEventCursorRecords(database, clock);

  const expiresAt = new Date(
    clock().getTime() + RELAY_CURSOR_TTL_MS,
  ).toISOString();

  database
    .prepare(
      `
        INSERT INTO event_cursors (
          device_id,
          host_id,
          cursor,
          event_id,
          request_id,
          event_type,
          expires_at
        )
        VALUES (
          @deviceId,
          @hostId,
          @cursor,
          @eventId,
          @requestId,
          @eventType,
          @expiresAt
        )
        ON CONFLICT(device_id, host_id, cursor) DO UPDATE SET
          event_id = excluded.event_id,
          request_id = excluded.request_id,
          event_type = excluded.event_type,
          expires_at = excluded.expires_at
      `,
    )
    .run({
      deviceId: input.deviceId,
      hostId: input.hostId,
      cursor: input.cursor,
      eventId: input.eventId,
      requestId: input.requestId,
      eventType: input.eventType,
      expiresAt,
    });

  const record = getEventCursorRecord(database, input.deviceId, input.hostId, input.cursor);
  if (!record) {
    throw new Error(`event cursor ${input.cursor} was not persisted`);
  }

  return record;
}

export function readEventCursorRecords(
  database: RelayStoreDatabase,
  input: ReadEventCursorRecordsInput,
  clock: StoreClock,
) {
  pruneExpiredEventCursorRecords(database, clock);

  const anchorRowId = getEventCursorRowId(
    database,
    input.deviceId,
    input.hostId,
    input.afterCursor,
  );

  if (anchorRowId === null) {
    return [];
  }

  const rows = database
    .prepare<
      { deviceId: string; hostId: string; anchorRowId: number },
      EventCursorRow
    >(
      `
        SELECT
          device_id,
          host_id,
          cursor,
          event_id,
          request_id,
          event_type,
          expires_at
        FROM event_cursors
        WHERE device_id = @deviceId
          AND host_id = @hostId
          AND rowid > @anchorRowId
        ORDER BY rowid ASC
      `,
    )
    .all({
      deviceId: input.deviceId,
      hostId: input.hostId,
      anchorRowId,
    });

  return rows.map(mapEventCursorRow);
}

export function pruneExpiredEventCursorRecords(
  database: RelayStoreDatabase,
  clock: StoreClock,
) {
  database
    .prepare(
      `
        DELETE FROM event_cursors
        WHERE expires_at <= @now
      `,
    )
    .run({
      now: toTimestamp(clock),
    });
}

function getEventCursorRecord(
  database: RelayStoreDatabase,
  deviceId: string,
  hostId: string,
  cursor: string,
) {
  const row = database
    .prepare<{ deviceId: string; hostId: string; cursor: string }, EventCursorRow>(
      `
        SELECT
          device_id,
          host_id,
          cursor,
          event_id,
          request_id,
          event_type,
          expires_at
        FROM event_cursors
        WHERE device_id = @deviceId
          AND host_id = @hostId
          AND cursor = @cursor
      `,
    )
    .get({
      deviceId,
      hostId,
      cursor,
    });

  return row ? mapEventCursorRow(row) : null;
}

function getEventCursorRowId(
  database: RelayStoreDatabase,
  deviceId: string,
  hostId: string,
  cursor: string,
) {
  const row = database
    .prepare<
      { deviceId: string; hostId: string; cursor: string },
      { rowid: number }
    >(
      `
        SELECT rowid
        FROM event_cursors
        WHERE device_id = @deviceId
          AND host_id = @hostId
          AND cursor = @cursor
      `,
    )
    .get({
      deviceId,
      hostId,
      cursor,
    });

  return row?.rowid ?? null;
}

function mapEventCursorRow(row: EventCursorRow): EventCursorRecord {
  return {
    deviceId: row.device_id,
    hostId: row.host_id,
    cursor: row.cursor,
    eventId: row.event_id,
    requestId: row.request_id,
    eventType: row.event_type,
    expiresAt: row.expires_at,
  };
}
