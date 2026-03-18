import type { EdgeConfig } from "./config";

export type RelayRegistration = {
  hostId: string;
  edgeId: string;
  edgePublicKey: string;
  edgeKeyFingerprint: string;
};

export type RelayClient = {
  registerEdge(input: RelayRegistration): Promise<void>;
};

export type RelayTunnel = {
  start(): Promise<void>;
};

export const createRelayTunnel = (
  config: EdgeConfig,
  relay: RelayClient,
): RelayTunnel => ({
  async start(): Promise<void> {
    await relay.registerEdge({
      hostId: config.hostId,
      edgeId: config.edgeId,
      edgePublicKey: config.edgePublicKey,
      edgeKeyFingerprint: config.edgeKeyFingerprint,
    });
  },
});
