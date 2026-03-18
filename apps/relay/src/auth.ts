import { randomUUID } from "node:crypto";

import type { RelayStore } from "../../../packages/store/src/index";

export type AuthBootstrapInput = {
  deviceId: string;
  hostId: string;
  deviceCredential: string;
  claimedEdgeKeyFingerprint?: string;
};

export type AuthBootstrapFailureReason =
  | "device_host_not_paired"
  | "invalid_device_credential";

export type AuthBootstrapResult =
  | {
      ok: true;
      sessionToken: string;
    }
  | {
      ok: false;
      reason: AuthBootstrapFailureReason;
    };

export type RelayAuthSession = {
  deviceId: string;
  hostId: string;
  issuedAt: string;
};

export type RelayAuth = {
  bootstrap(input: AuthBootstrapInput): AuthBootstrapResult;
  resolveSession(sessionToken: string): RelayAuthSession | null;
};

export type CreateRelayAuthInput = {
  store: RelayStore;
  now: () => Date;
};

export const createRelayAuth = (input: CreateRelayAuthInput): RelayAuth => {
  const sessions = new Map<string, RelayAuthSession>();

  return {
    bootstrap(payload) {
      const credential = payload.deviceCredential.trim();
      if (credential.length === 0) {
        return {
          ok: false,
          reason: "invalid_device_credential",
        };
      }

      const paired = input
        .store
        .listDeviceHostBindings(payload.deviceId)
        .some((binding) => binding.hostId === payload.hostId);
      if (!paired) {
        return {
          ok: false,
          reason: "device_host_not_paired",
        };
      }

      const sessionToken = randomUUID();
      sessions.set(sessionToken, {
        deviceId: payload.deviceId,
        hostId: payload.hostId,
        issuedAt: input.now().toISOString(),
      });
      return {
        ok: true,
        sessionToken,
      };
    },

    resolveSession(sessionToken) {
      return sessions.get(sessionToken) ?? null;
    },
  };
};
