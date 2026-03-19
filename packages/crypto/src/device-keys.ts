import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

const PRIVATE_KEY_FORMAT = {
  format: "der",
  type: "pkcs8",
} as const;

const PUBLIC_KEY_FORMAT = {
  format: "der",
  type: "spki",
} as const;

export type DeviceKeyPair = {
  publicKey: string;
  secretKey: string;
  fingerprint: string;
};

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const encodedPublicKey = encodeKeyBytes(publicKey.export(PUBLIC_KEY_FORMAT));
  const encodedSecretKey = encodeKeyBytes(privateKey.export(PRIVATE_KEY_FORMAT));

  return {
    publicKey: encodedPublicKey,
    secretKey: encodedSecretKey,
    fingerprint: fingerprintPublicKey(encodedPublicKey),
  };
}

export function fingerprintPublicKey(publicKey: string): string {
  return createHash("sha256").update(decodeKeyBytes(publicKey)).digest("hex");
}

export function importDevicePublicKey(publicKey: string): KeyObject {
  return createPublicKey({
    ...PUBLIC_KEY_FORMAT,
    key: decodeKeyBytes(publicKey),
  });
}

export function importDeviceSecretKey(secretKey: string): KeyObject {
  return createPrivateKey({
    ...PRIVATE_KEY_FORMAT,
    key: decodeKeyBytes(secretKey),
  });
}

export function derivePublicKey(secretKey: string): string {
  const publicKey = createPublicKey(importDeviceSecretKey(secretKey));
  return encodeKeyBytes(publicKey.export(PUBLIC_KEY_FORMAT));
}

function encodeKeyBytes(bytes: ArrayBuffer | Buffer): string {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString(
    "base64",
  );
}

function decodeKeyBytes(value: string): Buffer {
  return Buffer.from(value, "base64");
}
