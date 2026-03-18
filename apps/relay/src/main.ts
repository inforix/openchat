import type {
  EventCursorRecord,
  RelayStore,
} from "../../../packages/store/src/index";

import { createRelayAuth } from "./auth";
import { createRelayEventBuffer } from "./buffer";
import { createRelayHttpService, type RelayHttpService } from "./http";
import { createHostAwareRouter } from "./router";
import { createRelayWsService, type RelayWsService } from "./ws";

export type CreateRelayMainInput = {
  store: RelayStore;
  now?: () => Date;
};

export type RelayMain = {
  store: RelayStore;
  http: RelayHttpService;
  ws: RelayWsService;
  inspectReplayMetadata(input: {
    deviceId: string;
    hostId: string;
    afterCursor?: string;
  }): EventCursorRecord[];
  listRelayTableNames(): string[];
  close(): void;
};

export const createRelayMain = (input: CreateRelayMainInput): RelayMain => {
  const now = input.now ?? (() => new Date());

  const auth = createRelayAuth({
    store: input.store,
    now,
  });
  const router = createHostAwareRouter();
  const buffer = createRelayEventBuffer({
    store: input.store,
    now,
  });
  const http = createRelayHttpService({
    auth,
  });
  const ws = createRelayWsService({
    auth,
    router,
    buffer,
    store: input.store,
  });

  return {
    store: input.store,
    http,
    ws,
    inspectReplayMetadata(payload) {
      return buffer.readMetadata(payload);
    },
    listRelayTableNames() {
      return input.store.listTableNames();
    },
    close() {
      input.store.close();
    },
  };
};
