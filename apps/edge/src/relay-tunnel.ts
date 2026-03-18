import { randomUUID } from "node:crypto";

import {
  BotListResultPayloadSchema,
  type BotAccount,
} from "../../../packages/protocol/src/index";

import type { EdgeConfig } from "./config";

export type RelayRegistration = {
  hostId: string;
  edgeId: string;
  edgePublicKey: string;
  edgeKeyFingerprint: string;
};

export type RelayClient = {
  registerEdge(input: RelayRegistration): Promise<void>;
  takeClientRequests?(): Promise<
    Array<{
      type: "client.bot.list.request";
      requestId: string;
      deviceId: string;
      hostId: string;
    }>
  >;
  publishEncryptedEvent?(input: {
    requestId: string;
    eventId: string;
    deviceId: string;
    cursor: string;
    eventType: string;
    encryptedPayload: string;
  }): Promise<void>;
  close?(): Promise<void>;
};

export type RelayTunnel = {
  start(): Promise<void>;
  close(): Promise<void>;
};

type RelayTunnelHandlers = {
  listBots(): Promise<BotAccount[]>;
};

const supportsBotListTransport = (
  relay: RelayClient,
): relay is RelayClient &
  Required<Pick<RelayClient, "takeClientRequests" | "publishEncryptedEvent">> =>
  typeof relay.takeClientRequests === "function" &&
  typeof relay.publishEncryptedEvent === "function";

export const createRelayTunnel = (
  config: EdgeConfig,
  relay: RelayClient,
  handlers?: RelayTunnelHandlers,
): RelayTunnel => {
  let stopped = false;
  let requestLoop: Promise<void> | null = null;

  const publishBotListResult = async (input: {
    requestId: string;
    deviceId: string;
    bots: BotAccount[];
  }): Promise<void> => {
    if (!supportsBotListTransport(relay)) {
      return;
    }

    const payload = BotListResultPayloadSchema.parse({
      type: "bot.list.result",
      bots: input.bots,
    });
    await relay.publishEncryptedEvent({
      requestId: input.requestId,
      eventId: randomUUID(),
      deviceId: input.deviceId,
      cursor: randomUUID(),
      eventType: "edge.bot.list.result",
      encryptedPayload: JSON.stringify(payload),
    });
  };

  const runRequestLoop = async (): Promise<void> => {
    if (!handlers || !supportsBotListTransport(relay)) {
      return;
    }

    while (!stopped) {
      const requests = await relay.takeClientRequests();
      if (stopped || requests.length === 0) {
        continue;
      }

      for (const request of requests) {
        if (request.hostId !== config.hostId) {
          continue;
        }

        const bots = await handlers.listBots();
        await publishBotListResult({
          requestId: request.requestId,
          deviceId: request.deviceId,
          bots,
        });
      }
    }
  };

  return {
    async start(): Promise<void> {
      stopped = false;
      await relay.registerEdge({
        hostId: config.hostId,
        edgeId: config.edgeId,
        edgePublicKey: config.edgePublicKey,
        edgeKeyFingerprint: config.edgeKeyFingerprint,
      });

      if (handlers && supportsBotListTransport(relay)) {
        requestLoop = runRequestLoop();
      }
    },

    async close(): Promise<void> {
      stopped = true;
      await relay.close?.();
      await requestLoop;
      requestLoop = null;
    },
  };
};
