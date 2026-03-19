import Database from "better-sqlite3";

export const RELAY_CURSOR_TTL_MS = 5 * 60 * 1000;

export const RELAY_TABLE_NAMES = [
  "device_host_bindings",
  "devices",
  "edge_connections",
  "event_cursors",
  "hosts",
  "push_tokens",
  "users",
] as const;

export type RelayTableName = (typeof RELAY_TABLE_NAMES)[number];
export type RelayStoreDatabase = Database.Database;
export type StoreClock = () => Date;

export function openRelayDatabase(filename: string): RelayStoreDatabase {
  const database = new Database(filename);

  database.pragma("foreign_keys = ON");
  initializeRelaySchema(database);

  return database;
}

export function initializeRelaySchema(database: RelayStoreDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hosts (
      host_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_host_bindings (
      device_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (device_id, host_id),
      FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
      FOREIGN KEY (host_id) REFERENCES hosts(host_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS edge_connections (
      device_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      online INTEGER NOT NULL,
      connected_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (device_id, host_id),
      FOREIGN KEY (device_id, host_id)
        REFERENCES device_host_bindings(device_id, host_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS event_cursors (
      device_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      event_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (device_id, host_id, cursor),
      FOREIGN KEY (device_id, host_id)
        REFERENCES device_host_bindings(device_id, host_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS push_tokens (
      device_id TEXT NOT NULL,
      token TEXT NOT NULL,
      platform TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (device_id, token),
      FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
    );
  `);

  ensureColumn(database, "devices", "credential_hash", "TEXT NOT NULL DEFAULT ''");
}

export function listRelayTableNames(database: RelayStoreDatabase): RelayTableName[] {
  const rows = database
    .prepare<[], { name: RelayTableName }>(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
      `,
    )
    .all();

  return rows.map((row) => row.name);
}

export function toTimestamp(clock: StoreClock) {
  return clock().toISOString();
}

export function ensureUser(
  database: RelayStoreDatabase,
  userId: string,
  timestamp: string,
) {
  database
    .prepare(
      `
        INSERT INTO users (user_id, created_at, updated_at)
        VALUES (@userId, @timestamp, @timestamp)
        ON CONFLICT(user_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `,
    )
    .run({
      userId,
      timestamp,
    });
}

function ensureColumn(
  database: RelayStoreDatabase,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const columns = database
    .prepare<{ tableName: string }, { name: string }>(
      `
        SELECT name
        FROM pragma_table_info(@tableName)
      `,
    )
    .all({
      tableName,
    });

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  database.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
  );
}
