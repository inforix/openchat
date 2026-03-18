import {
  createPairingToken,
  verifyPairingToken,
  type PairingToken,
  type TrustRecord,
} from "../../../packages/crypto/src/index";

import {
  readEdgeJsonFile,
  writeEdgeJsonFile,
  type EdgeConfig,
} from "./config";

export type TrustedDeviceRecord = {
  deviceId: string;
  hostId: string;
  edgeKeyFingerprint: string;
  pairedAt: string;
};

type TrustedDeviceState = {
  version: 1;
  devices: TrustedDeviceRecord[];
  seenPairingNonces: string[];
};

export type PairingService = {
  createPairingResponse(input?: { ttlMs?: number }): Promise<PairingToken>;
  confirmPairing(input: {
    deviceId: string;
    token: PairingToken;
    confirmedEdgeKeyFingerprint: string;
  }): Promise<TrustedDeviceRecord>;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const emptyState = (): TrustedDeviceState => ({
  version: 1,
  devices: [],
  seenPairingNonces: [],
});

const readState = async (config: EdgeConfig): Promise<TrustedDeviceState> => {
  const stored = await readEdgeJsonFile<TrustedDeviceState>(
    config.paths.trustedDevicesPath,
  );
  if (
    stored?.version === 1 &&
    Array.isArray(stored.devices) &&
    Array.isArray(stored.seenPairingNonces)
  ) {
    return {
      version: 1,
      devices: stored.devices.map((device) => ({ ...device })),
      seenPairingNonces: [...stored.seenPairingNonces],
    };
  }

  return emptyState();
};

const writeState = async (
  config: EdgeConfig,
  state: TrustedDeviceState,
): Promise<void> => {
  await writeEdgeJsonFile(config.paths.trustedDevicesPath, state);
};

const toTrustRecord = (
  record: TrustedDeviceRecord | undefined,
): TrustRecord | undefined =>
  record
    ? {
        hostId: record.hostId,
        edgeKeyFingerprint: record.edgeKeyFingerprint,
      }
    : undefined;

export const createPairingService = (
  config: EdgeConfig,
): PairingService => {
  let trustedDeviceMutation: Promise<void> = Promise.resolve();

  const withTrustedDeviceMutation = async <T>(
    action: () => Promise<T>,
  ): Promise<T> => {
    const previous = trustedDeviceMutation;
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = previous.finally(() => current);
    trustedDeviceMutation = entry;

    await previous;
    try {
      return await action();
    } finally {
      release();
      if (trustedDeviceMutation === entry) {
        trustedDeviceMutation = Promise.resolve();
      }
    }
  };

  return {
    async createPairingResponse(input): Promise<PairingToken> {
      const now = config.now();
      return createPairingToken({
        hostId: config.hostId,
        edgePublicKey: config.edgePublicKey,
        expiresAt: new Date(
          now.getTime() + (input?.ttlMs ?? DEFAULT_TTL_MS),
        ).toISOString(),
        pairingNonce: config.generatePairingNonce(),
      });
    },

    async confirmPairing(input): Promise<TrustedDeviceRecord> {
      return withTrustedDeviceMutation(async () => {
        const state = await readState(config);
        const seenPairingNonces = new Set(state.seenPairingNonces);
        const existingRecord = state.devices.find(
          (record) => record.deviceId === input.deviceId,
        );
        const verified = verifyPairingToken({
          token: input.token,
          expectedHostId: config.hostId,
          expectedEdgeKeyFingerprint: input.confirmedEdgeKeyFingerprint,
          seenPairingNonces,
          now: config.now(),
          trustRecord: toTrustRecord(existingRecord),
        });
        const pairedAt = config.now().toISOString();
        const trustedRecord: TrustedDeviceRecord = {
          deviceId: input.deviceId,
          hostId: verified.hostId,
          edgeKeyFingerprint: verified.edgeKeyFingerprint,
          pairedAt,
        };
        const devices = state.devices.filter(
          (record) => record.deviceId !== input.deviceId,
        );
        devices.push(trustedRecord);

        await writeState(config, {
          version: 1,
          devices,
          seenPairingNonces: [...seenPairingNonces],
        });

        return trustedRecord;
      });
    },
  };
};
