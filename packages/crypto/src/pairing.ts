import { fingerprintPublicKey } from "./device-keys";

export type PairingToken = {
  hostId: string;
  edgePublicKey: string;
  edgeKeyFingerprint: string;
  expiresAt: string;
  pairingNonce: string;
};

export type TrustRecord = {
  hostId: string;
  edgeKeyFingerprint: string;
};

export type VerifyPairingTokenInput = {
  token: PairingToken;
  expectedHostId: string;
  seenPairingNonces: Set<string>;
  now: Date;
  trustRecord?: TrustRecord;
};

export type VerifiedPairing = PairingToken & {
  trustRecord: TrustRecord;
};

export function createPairingToken(input: {
  hostId: string;
  edgePublicKey: string;
  expiresAt: string;
  pairingNonce: string;
}): PairingToken {
  return {
    ...input,
    edgeKeyFingerprint: fingerprintPublicKey(input.edgePublicKey),
  };
}

export function createTrustRecord(input: TrustRecord): TrustRecord {
  return {
    hostId: input.hostId,
    edgeKeyFingerprint: input.edgeKeyFingerprint,
  };
}

export function verifyPairingToken(input: VerifyPairingTokenInput): VerifiedPairing {
  if (input.token.hostId !== input.expectedHostId) {
    throw new Error("Pairing token hostId does not match the expected host");
  }

  const expectedFingerprint = fingerprintPublicKey(input.token.edgePublicKey);
  if (input.token.edgeKeyFingerprint !== expectedFingerprint) {
    throw new Error("Pairing token edge fingerprint does not match edgePublicKey");
  }

  const expiresAt = Date.parse(input.token.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= input.now.getTime()) {
    throw new Error("Pairing token has expired");
  }

  if (input.seenPairingNonces.has(input.token.pairingNonce)) {
    throw new Error("Pairing nonce has already been used");
  }

  if (input.trustRecord) {
    if (input.trustRecord.hostId !== input.expectedHostId) {
      throw new Error("Trust record hostId does not match the expected host");
    }
    if (input.trustRecord.edgeKeyFingerprint !== input.token.edgeKeyFingerprint) {
      throw new Error("The trusted edge key fingerprint changed; re-pairing is required");
    }
  }

  input.seenPairingNonces.add(input.token.pairingNonce);

  return {
    ...input.token,
    trustRecord: createTrustRecord({
      hostId: input.token.hostId,
      edgeKeyFingerprint: input.token.edgeKeyFingerprint,
    }),
  };
}
