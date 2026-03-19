import { join } from "node:path";

import {
  createOpenClawClient,
  createOpenClawCliTransport,
  type OpenClawClient,
  type OpenClawTransport,
} from "../../../packages/openclaw-client/src/index";

import { createEdgeMain, type EdgeMain } from "./main";
import {
  createRelayWebSocketClient,
  type RelayWebSocketClient,
} from "./relay-websocket-client";

export type EdgeRuntimeConfig = {
  hostId: string;
  deviceId: string;
  relayWebSocketUrl: string;
  stateDir: string;
  openClawBin: string;
  openClawProfile?: string;
};

export type EdgeRuntime = {
  config: EdgeRuntimeConfig;
  edge: EdgeMain;
  close(): Promise<void>;
};

type RuntimeOpenClaw = OpenClawClient & {
  confirmAccountCreated(input: {
    accountId: string;
    agentId: string;
  }): Promise<boolean>;
};

type EdgeRuntimeDependencies = {
  createRelayClient?: (input: {
    relayWebSocketUrl: string;
  }) => RelayWebSocketClient;
  createTransport?: (input: {
    openClawBin: string;
    profile?: string;
  }) => OpenClawTransport;
  createOpenClawClient?: (input: {
    hostId: string;
    deviceId: string;
    stateDir: string;
    transport: OpenClawTransport;
  }) => OpenClawClient;
  createEdgeMain?: (input: {
    hostId: string;
    deviceId: string;
    stateDir: string;
    relay: RelayWebSocketClient;
    openClaw: RuntimeOpenClaw;
    streamState: {
      hasActiveStream(input: { accountId: string }): Promise<boolean>;
    };
  }) => EdgeMain;
};

const DEFAULT_STATE_DIRECTORY_NAME = ".openchat-state";
const DEFAULT_OPENCLAW_BIN = "openclaw";

const requireEnv = (
  value: string | undefined,
  name: string,
): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }

  return trimmed;
};

const defaultStateDir = (workspaceRoot: string): string =>
  join(workspaceRoot, DEFAULT_STATE_DIRECTORY_NAME);

const createRuntimeOpenClaw = (client: OpenClawClient): {
  openClaw: RuntimeOpenClaw;
  streamState: {
    hasActiveStream(input: { accountId: string }): Promise<boolean>;
  };
} => {
  const activeAccounts = new Set<string>();
  const streamState = {
    async hasActiveStream(input: { accountId: string }): Promise<boolean> {
      return activeAccounts.has(input.accountId);
    },
  };

  return {
    streamState,
    openClaw: {
      ...client,
      async confirmAccountCreated(): Promise<boolean> {
        return true;
      },
      async sendMessage(input): Promise<void> {
        activeAccounts.add(input.accountId);
        try {
          await client.sendMessage(input);
        } finally {
          activeAccounts.delete(input.accountId);
        }
      },
    },
  };
};

export const readEdgeRuntimeConfig = (
  environment: NodeJS.ProcessEnv,
  workspaceRoot: string,
): EdgeRuntimeConfig => {
  const hostId = requireEnv(environment.OPENCHAT_EDGE_HOST_ID, "OPENCHAT_EDGE_HOST_ID");
  const deviceId = requireEnv(
    environment.OPENCHAT_EDGE_DEVICE_ID,
    "OPENCHAT_EDGE_DEVICE_ID",
  );
  const relayWebSocketUrl = requireEnv(
    environment.OPENCHAT_EDGE_RELAY_WS_URL,
    "OPENCHAT_EDGE_RELAY_WS_URL",
  );
  const parsedUrl = new URL(relayWebSocketUrl);
  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error(`OPENCHAT_EDGE_RELAY_WS_URL must use ws:// or wss://`);
  }

  return {
    hostId,
    deviceId,
    relayWebSocketUrl,
    stateDir:
      environment.OPENCHAT_EDGE_STATE_DIR?.trim() ||
      defaultStateDir(workspaceRoot),
    openClawBin:
      environment.OPENCHAT_EDGE_OPENCLAW_BIN?.trim() || DEFAULT_OPENCLAW_BIN,
    openClawProfile: environment.OPENCHAT_EDGE_OPENCLAW_PROFILE?.trim() || undefined,
  };
};

export const startEdgeRuntime = async (
  config: EdgeRuntimeConfig,
  dependencies: EdgeRuntimeDependencies = {},
): Promise<EdgeRuntime> => {
  const relay =
    dependencies.createRelayClient?.({
      relayWebSocketUrl: config.relayWebSocketUrl,
    }) ??
    createRelayWebSocketClient({
      relayWebSocketUrl: config.relayWebSocketUrl,
    });
  const transport =
    dependencies.createTransport?.({
      openClawBin: config.openClawBin,
      profile: config.openClawProfile,
    }) ??
    createOpenClawCliTransport({
      openClawBin: config.openClawBin,
      profile: config.openClawProfile,
    });
  const client =
    dependencies.createOpenClawClient?.({
      hostId: config.hostId,
      deviceId: config.deviceId,
      stateDir: config.stateDir,
      transport,
    }) ??
    createOpenClawClient({
      hostId: config.hostId,
      deviceId: config.deviceId,
      stateDir: config.stateDir,
      transport,
    });
  const runtimeOpenClaw = createRuntimeOpenClaw(client);
  const edge =
    dependencies.createEdgeMain?.({
      hostId: config.hostId,
      deviceId: config.deviceId,
      stateDir: config.stateDir,
      relay,
      openClaw: runtimeOpenClaw.openClaw,
      streamState: runtimeOpenClaw.streamState,
    }) ??
    createEdgeMain({
      hostId: config.hostId,
      deviceId: config.deviceId,
      stateDir: config.stateDir,
      relay,
      openClaw: runtimeOpenClaw.openClaw,
      streamState: runtimeOpenClaw.streamState,
    });

  let closed = false;
  await edge.start();

  return {
    config,
    edge,
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await edge.close();
    },
  };
};
