import type { StoreClock, RelayStoreDatabase } from "./schema";
import { RELAY_CURSOR_TTL_MS, toTimestamp } from "./schema";

export type EventCursorRecord = {
  deviceId: string;
  hostId: string;
  cursor: string;
  eventId: string;
  payload: unknown;
  createdAt: string;
  expiresAt: string;
};

export type AppendEventCursorRecordInput = {
  deviceId: string;
  hostId: string;
  cursor: string;
  eventId: string;
  payload: unknown;
};

export type ReadEventCursorRecordsInput = {
  deviceId: string;
  hostId: string;
  afterCursor?: string;
};

type EventCursorRow = {
  device_id: string;
  host_id: string;
  cursor: string;
  event_id: string;
  payload_json: string;
  created_at: string;
  expires_at: string;
};

export function appendEventCursorRecord(
  database: RelayStoreDatabase,
  input: AppendEventCursorRecordInput,
  clock: StoreClock,
) {
  pruneExpiredEventCursorRecords(database, clock);

  const createdAt = toTimestamp(clock);
  const expiresAt = new Date(
    Date.parse(createdAt) + RELAY_CURSOR_TTL_MS,
  ).toISOString();

  database
    .prepare(
      `
        INSERT INTO event_cursors (
          device_id,
          host_id,
          cursor,
          event_id,
          payload_json,
          created_at,
          expires_at
        )
        VALUES (
          @deviceId,
          @hostId,
          @cursor,
          @eventId,
          @payloadJson,
          @createdAt,
          @expiresAt
        )
        ON CONFLICT(device_id, host_id, cursor) DO UPDATE SET
          event_id = excluded.event_id,
          payload_json = excluded.payload_json,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
      `,
    )
    .run({
      deviceId: input.deviceId,
      hostId: input.hostId,
      cursor: input.cursor,
      eventId: input.eventId,
      payloadJson: JSON.stringify(input.payload),
      createdAt,
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

  const rows = database
    .prepare<
      { deviceId: string; hostId: string; afterCursor: string | null },
      EventCursorRow
    >(
      `
        SELECT
          device_id,
          host_id,
          cursor,
          event_id,
          payload_json,
          created_at,
          expires_at
        FROM event_cursors
        WHERE device_id = @deviceId
          AND host_id = @hostId
          AND (
            @afterCursor IS NULL
            OR rowid > COALESCE(
              (
                SELECT rowid
                FROM event_cursors
                WHERE device_id = @deviceId
                  AND host_id = @hostId
                  AND cursor = @afterCursor
              ),
              0
            )
          )
        ORDER BY rowid ASC
      `,
    )
    .all({
      deviceId: input.deviceId,
      hostId: input.hostId,
      afterCursor: input.afterCursor ?? null,
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
          payload_json,
          created_at,
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

function mapEventCursorRow(row: EventCursorRow): EventCursorRecord {
  return {
    deviceId: row.device_id,
    hostId: row.host_id,
    cursor: row.cursor,
    eventId: row.event_id,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
