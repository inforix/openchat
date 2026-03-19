import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  createPairingToken,
  createTrustRecord,
  decryptEnvelope,
  fingerprintPublicKey,
  generateDeviceKeyPair,
  verifyPairingToken,
} from "../index";

describe("openchat crypto", () => {
  it("generates a device keypair with a stable fingerprint", () => {
    const keypair = generateDeviceKeyPair();

    expect(keypair.publicKey).toEqual(expect.any(String));
    expect(keypair.secretKey).toEqual(expect.any(String));
    expect(keypair.publicKey).not.toBe(keypair.secretKey);
    expect(keypair.fingerprint).toBe(fingerprintPublicKey(keypair.publicKey));
  });

  it("encrypts and decrypts an envelope between client and edge", () => {
    const client = generateDeviceKeyPair();
    const edge = generateDeviceKeyPair();
    const message = "hello from client to edge";

    const envelope = createEnvelope({
      plaintext: message,
      senderSecretKey: client.secretKey,
      recipientPublicKey: edge.publicKey,
    });

    expect(envelope.ciphertext).not.toContain(message);

    const decrypted = decryptEnvelope({
      envelope,
      recipientSecretKey: edge.secretKey,
    });

    expect(decrypted).toBe(message);
  });

  it("binds hostId, edgePublicKey, and edgeKeyFingerprint in the pairing token", () => {
    const edge = generateDeviceKeyPair();
    const seenPairingNonces = new Set<string>();
    const token = createPairingToken({
      hostId: "host-1",
      edgePublicKey: edge.publicKey,
      expiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      pairingNonce: "nonce-1",
    });

    const verified = verifyPairingToken({
      token,
      expectedHostId: "host-1",
      expectedEdgeKeyFingerprint: fingerprintPublicKey(edge.publicKey),
      seenPairingNonces,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });

    expect(verified.hostId).toBe("host-1");
    expect(verified.edgePublicKey).toBe(edge.publicKey);
    expect(verified.edgeKeyFingerprint).toBe(fingerprintPublicKey(edge.publicKey));
  });

  it("requires an out-of-band confirmed fingerprint for first-time pairing", () => {
    const edge = generateDeviceKeyPair();
    const token = createPairingToken({
      hostId: "host-1",
      edgePublicKey: edge.publicKey,
      expiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      pairingNonce: "nonce-2",
    });

    expect(() =>
      verifyPairingToken({
        token,
        expectedHostId: "host-1",
        seenPairingNonces: new Set<string>(),
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/confirmed fingerprint/i);
  });

  it("rejects pairing verification when the host-confirmed fingerprint does not match", () => {
    const trustedEdge = generateDeviceKeyPair();
    const forgedEdge = generateDeviceKeyPair();
    const token = createPairingToken({
      hostId: "host-1",
      edgePublicKey: forgedEdge.publicKey,
      expiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      pairingNonce: "nonce-3",
    });

    expect(() =>
      verifyPairingToken({
        token,
        expectedHostId: "host-1",
        expectedEdgeKeyFingerprint: fingerprintPublicKey(trustedEdge.publicKey),
        seenPairingNonces: new Set<string>(),
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/fingerprint/i);
  });

  it("invalidates an existing trust record when the pinned edge fingerprint changes", () => {
    const originalEdge = generateDeviceKeyPair();
    const rotatedEdge = generateDeviceKeyPair();
    const trustRecord = createTrustRecord({
      hostId: "host-1",
      edgeKeyFingerprint: fingerprintPublicKey(originalEdge.publicKey),
    });

    const rotatedToken = createPairingToken({
      hostId: "host-1",
      edgePublicKey: rotatedEdge.publicKey,
      expiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      pairingNonce: "nonce-3",
    });

    expect(() =>
      verifyPairingToken({
        token: rotatedToken,
        expectedHostId: "host-1",
        trustRecord,
        seenPairingNonces: new Set<string>(),
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/trusted edge key fingerprint/i);
  });

  it("rejects an expired pairing token", () => {
    const edge = generateDeviceKeyPair();
    const token = createPairingToken({
      hostId: "host-1",
      edgePublicKey: edge.publicKey,
      expiresAt: new Date("2025-01-01T00:00:00.000Z").toISOString(),
      pairingNonce: "nonce-4",
    });

    expect(() =>
      verifyPairingToken({
        token,
        expectedHostId: "host-1",
        expectedEdgeKeyFingerprint: fingerprintPublicKey(edge.publicKey),
        seenPairingNonces: new Set<string>(),
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/expired/i);
  });

  it("rejects pairing nonce replay", () => {
    const edge = generateDeviceKeyPair();
    const token = createPairingToken({
      hostId: "host-1",
      edgePublicKey: edge.publicKey,
      expiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      pairingNonce: "nonce-5",
    });
    const seenPairingNonces = new Set<string>();

    verifyPairingToken({
      token,
      expectedHostId: "host-1",
      expectedEdgeKeyFingerprint: fingerprintPublicKey(edge.publicKey),
      seenPairingNonces,
      now: new Date("2030-01-01T00:00:00.000Z"),
    });

    expect(() =>
      verifyPairingToken({
        token,
        expectedHostId: "host-1",
        expectedEdgeKeyFingerprint: fingerprintPublicKey(edge.publicKey),
        seenPairingNonces,
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/nonce/i);
  });
});
