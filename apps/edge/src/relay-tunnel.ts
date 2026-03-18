import { randomUUID } from "node:crypto";

import {
  BotListResultPayloadSchema,
  SessionHistoryResultPayloadSchema,
  SessionSnapshotResultPayloadSchema,
  type BotAccount,
} from "../../../packages/protocol/src/index";
import type {
  ArchivedSessionSummary,
  SessionTranscript,
} from "../../../packages/openclaw-client/src/index";

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
    } | {
      type: "client.session.snapshot.request";
      requestId: string;
      deviceId: string;
      hostId: string;
      accountId: string;
    } | {
      type: "client.session.history.request";
      requestId: string;
      deviceId: string;
      hostId: string;
      accountId: string;
      sessionId: string;
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
  getSessionSnapshot(input: {
    accountId: string;
  }): Promise<{
    accountId: string;
    activeSessionId: string | null;
    archivedSessions: ArchivedSessionSummary[];
  }>;
  getSessionTranscript(input: {
    accountId: string;
    sessionId: string;
  }): Promise<SessionTranscript | null>;
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

  const publishIfRunning = async (input: {
    requestId: string;
    eventId: string;
    deviceId: string;
    cursor: string;
    eventType: string;
    encryptedPayload: string;
  }): Promise<void> => {
    if (stopped || !supportsBotListTransport(relay)) {
      return;
    }

    try {
      await relay.publishEncryptedEvent(input);
    } catch (error) {
      if (stopped) {
        return;
      }
      throw error;
    }
  };

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
    await publishIfRunning({
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

        if (request.type === "client.bot.list.request") {
          const bots = await handlers.listBots();
          await publishBotListResult({
            requestId: request.requestId,
            deviceId: request.deviceId,
            bots,
          });
          continue;
        }

        if (request.type === "client.session.snapshot.request") {
          const snapshot = await handlers.getSessionSnapshot({
            accountId: request.accountId,
          });
          if (stopped) {
            return;
          }
          const payload = SessionSnapshotResultPayloadSchema.parse({
            type: "session.snapshot.result",
            accountId: snapshot.accountId,
            activeSessionId: snapshot.activeSessionId,
            archivedSessions: snapshot.archivedSessions,
          });
          await publishIfRunning({
            requestId: request.requestId,
            eventId: randomUUID(),
            deviceId: request.deviceId,
            cursor: randomUUID(),
            eventType: "edge.session.snapshot.result",
            encryptedPayload: JSON.stringify(payload),
          });
          continue;
        }

        const session = await handlers.getSessionTranscript({
          accountId: request.accountId,
          sessionId: request.sessionId,
        });
        if (stopped || !session) {
          continue;
        }

        const payload = SessionHistoryResultPayloadSchema.parse({
          type: "session.history.result",
          accountId: request.accountId,
          sessionId: request.sessionId,
          title: session.title,
          messages: session.messages,
        });
        await publishIfRunning({
          requestId: request.requestId,
          eventId: randomUUID(),
          deviceId: request.deviceId,
          cursor: randomUUID(),
          eventType: "edge.session.history.result",
          encryptedPayload: JSON.stringify(payload),
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
