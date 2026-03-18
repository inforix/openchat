import {
  type StoreClock,
  RELAY_CURSOR_TTL_MS,
  RELAY_TABLE_NAMES,
  listRelayTableNames,
  openRelayDatabase,
} from "./schema";
import {
  type AdoptLegacyDeviceCredentialInput,
  type DeviceRecord,
  type RegisterDeviceInput,
  type VerifyDeviceCredentialInput,
  adoptLegacyDeviceCredential,
  getDevice,
  registerDevice,
  verifyDeviceCredential,
} from "./devices";
import {
  type BindDeviceToHostInput,
  type DeviceHostBindingRecord,
  type EdgeConnectionRecord,
  type GetEdgeConnectionStateInput,
  type HostRecord,
  type RegisterHostInput,
  type SetEdgeConnectionStateInput,
  bindDeviceToHost,
  getEdgeConnectionState,
  listDeviceHostBindings,
  registerHost,
  setEdgeConnectionState,
} from "./hosts";
import {
  type AppendEventCursorRecordInput,
  type EventCursorRecord,
  type ReadEventCursorRecordsInput,
  appendEventCursorRecord,
  readEventCursorRecords,
} from "./cursors";

export type CreateRelayStoreOptions = {
  filename: string;
  now?: StoreClock;
};

export type RelayStore = {
  registerDevice(input: RegisterDeviceInput): DeviceRecord;
  getDevice(deviceId: string): DeviceRecord | null;
  verifyDeviceCredential(input: VerifyDeviceCredentialInput): boolean;
  adoptLegacyDeviceCredential(input: AdoptLegacyDeviceCredentialInput): boolean;
  registerHost(input: RegisterHostInput): HostRecord;
  bindDeviceToHost(input: BindDeviceToHostInput): DeviceHostBindingRecord;
  listDeviceHostBindings(deviceId: string): DeviceHostBindingRecord[];
  setEdgeConnectionState(
    input: SetEdgeConnectionStateInput,
  ): EdgeConnectionRecord;
  getEdgeConnectionState(
    input: GetEdgeConnectionStateInput,
  ): EdgeConnectionRecord | null;
  appendEventCursorRecord(
    input: AppendEventCursorRecordInput,
  ): EventCursorRecord;
  readEventCursorRecords(
    input: ReadEventCursorRecordsInput,
  ): EventCursorRecord[];
  listTableNames(): string[];
  close(): void;
};

export function createRelayStore(options: CreateRelayStoreOptions): RelayStore {
  const database = openRelayDatabase(options.filename);
  const clock = options.now ?? (() => new Date());

  return {
    registerDevice(input) {
      return registerDevice(database, input, clock);
    },
    getDevice(deviceId) {
      return getDevice(database, deviceId);
    },
    verifyDeviceCredential(input) {
      return verifyDeviceCredential(database, input);
    },
    adoptLegacyDeviceCredential(input) {
      return adoptLegacyDeviceCredential(database, input);
    },
    registerHost(input) {
      return registerHost(database, input, clock);
    },
    bindDeviceToHost(input) {
      return bindDeviceToHost(database, input, clock);
    },
    listDeviceHostBindings(deviceId) {
      return listDeviceHostBindings(database, deviceId);
    },
    setEdgeConnectionState(input) {
      return setEdgeConnectionState(database, input, clock);
    },
    getEdgeConnectionState(input) {
      return getEdgeConnectionState(database, input);
    },
    appendEventCursorRecord(input) {
      return appendEventCursorRecord(database, input, clock);
    },
    readEventCursorRecords(input) {
      return readEventCursorRecords(database, input, clock);
    },
    listTableNames() {
      return listRelayTableNames(database);
    },
    close() {
      database.close();
    },
  };
}

export { RELAY_CURSOR_TTL_MS, RELAY_TABLE_NAMES } from "./schema";
export type {
  AdoptLegacyDeviceCredentialInput,
  DeviceRecord,
  RegisterDeviceInput,
  VerifyDeviceCredentialInput,
} from "./devices";
export type {
  BindDeviceToHostInput,
  DeviceHostBindingRecord,
  EdgeConnectionRecord,
  GetEdgeConnectionStateInput,
  HostRecord,
  RegisterHostInput,
  SetEdgeConnectionStateInput,
} from "./hosts";
export type {
  AppendEventCursorRecordInput,
  EventCursorRecord,
  ReadEventCursorRecordsInput,
} from "./cursors";
