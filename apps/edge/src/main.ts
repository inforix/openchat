import type {
  CreateOpenChatBotInput,
  MessagePayload,
  OpenChatBot,
} from "../../../packages/openclaw-client/src/index";
import type { PairingToken } from "../../../packages/crypto/src/index";

import { createBotService, type EdgeOpenClawAdapter } from "./bot-service";
import { createEdgeConfig, type EdgeConfigInput } from "./config";
import {
  createPairingService,
  type TrustedDeviceRecord,
} from "./pairing-service";
import { createRelayTunnel, type RelayClient } from "./relay-tunnel";
import {
  createSessionService,
  type SessionOpenClawAdapter,
  type SessionSendResult,
  type StreamStateSource,
} from "./session-service";

export type EdgeOpenClawServices = EdgeOpenClawAdapter & SessionOpenClawAdapter;

export type CreateEdgeMainInput = EdgeConfigInput & {
  relay: RelayClient;
  openClaw: EdgeOpenClawServices;
  streamState?: StreamStateSource;
};

export type EdgeMain = {
  start(): Promise<void>;
  createPairingResponse(input?: { ttlMs?: number }): Promise<PairingToken>;
  confirmPairing(input: {
    deviceId: string;
    token: PairingToken;
    confirmedEdgeKeyFingerprint: string;
  }): Promise<TrustedDeviceRecord>;
  listBots(): Promise<OpenChatBot[]>;
  createBot(input: CreateOpenChatBotInput): Promise<OpenChatBot>;
  handleMessage(input: {
    accountId: string;
    targetSessionId: string;
    payload: MessagePayload;
  }): Promise<SessionSendResult>;
};

type EdgeRuntime = {
  relayTunnel: ReturnType<typeof createRelayTunnel>;
  pairingService: ReturnType<typeof createPairingService>;
  botService: ReturnType<typeof createBotService>;
  sessionService: ReturnType<typeof createSessionService>;
};

const idleStreamStateSource: StreamStateSource = {
  async hasActiveStream(): Promise<boolean> {
    return false;
  },
};

const createRuntime = async (
  input: CreateEdgeMainInput,
): Promise<EdgeRuntime> => {
  const config = await createEdgeConfig(input);
  return {
    relayTunnel: createRelayTunnel(config, input.relay),
    pairingService: createPairingService(config),
    botService: createBotService(input.openClaw),
    sessionService: createSessionService(
      input.openClaw,
      input.streamState ?? idleStreamStateSource,
    ),
  };
};

export const createEdgeMain = (input: CreateEdgeMainInput): EdgeMain => {
  const runtime = createRuntime(input);

  return {
    async start(): Promise<void> {
      const services = await runtime;
      await services.relayTunnel.start();
    },

    async createPairingResponse(inputValue): Promise<PairingToken> {
      const services = await runtime;
      return services.pairingService.createPairingResponse(inputValue);
    },

    async confirmPairing(inputValue): Promise<TrustedDeviceRecord> {
      const services = await runtime;
      return services.pairingService.confirmPairing(inputValue);
    },

    async listBots(): Promise<OpenChatBot[]> {
      const services = await runtime;
      return services.botService.listBots();
    },

    async createBot(inputValue): Promise<OpenChatBot> {
      const services = await runtime;
      return services.botService.createBot(inputValue);
    },

    async handleMessage(inputValue): Promise<SessionSendResult> {
      const services = await runtime;
      return services.sessionService.handleMessage(inputValue);
    },
  };
};
