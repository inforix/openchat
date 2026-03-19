import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createRelayStore } from "../../../packages/store/src/index";

import { createRelayMain, type RelayMain } from "./main";
import { createRelayServer, type RelayServer } from "./server";

export type RelayRuntimeConfig = {
  host: string;
  port: number;
  stateDir: string;
  storeFilename: string;
};

export type RelayRuntime = {
  config: RelayRuntimeConfig;
  relay: RelayMain;
  server: RelayServer;
  close(): Promise<void>;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_STATE_DIRECTORY_NAME = ".openchat-state";
const DEFAULT_SQLITE_FILENAME = "relay.sqlite";

const parsePort = (value: string | undefined): number => {
  if (!value) {
    return 3001;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      `OPENCHAT_RELAY_PORT must be an integer between 0 and 65535`,
    );
  }

  return parsed;
};

const defaultStateDir = (workspaceRoot: string): string =>
  join(workspaceRoot, DEFAULT_STATE_DIRECTORY_NAME);

const defaultStoreFilename = (stateDir: string): string =>
  join(stateDir, "relay", DEFAULT_SQLITE_FILENAME);

export const readRelayRuntimeConfig = (
  environment: NodeJS.ProcessEnv,
  workspaceRoot: string,
): RelayRuntimeConfig => {
  const stateDir =
    environment.OPENCHAT_RELAY_STATE_DIR?.trim() ||
    defaultStateDir(workspaceRoot);
  const storeFilename =
    environment.OPENCHAT_RELAY_SQLITE_PATH?.trim() ||
    defaultStoreFilename(stateDir);

  return {
    host: environment.OPENCHAT_RELAY_HOST?.trim() || DEFAULT_HOST,
    port: parsePort(environment.OPENCHAT_RELAY_PORT),
    stateDir,
    storeFilename,
  };
};

export const startRelayRuntime = async (
  config: RelayRuntimeConfig,
): Promise<RelayRuntime> => {
  await mkdir(dirname(config.storeFilename), { recursive: true });

  const store = createRelayStore({
    filename: config.storeFilename,
  });
  const relay = createRelayMain({ store });
  const server = createRelayServer({
    relay,
    host: config.host,
    port: config.port,
  });

  let closed = false;

  await server.start();

  return {
    config,
    relay,
    server,
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await server.close();
    },
  };
};
