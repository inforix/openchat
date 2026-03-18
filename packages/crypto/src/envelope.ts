import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  derivePublicKey,
  importDevicePublicKey,
  importDeviceSecretKey,
} from "./device-keys";

const ENVELOPE_CONTEXT = "openchat-envelope";
const ENVELOPE_VERSION = 1;

export type Envelope = {
  version: typeof ENVELOPE_VERSION;
  senderPublicKey: string;
  recipientPublicKey: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
};

export type CreateEnvelopeInput = {
  plaintext: string;
  senderSecretKey: string;
  recipientPublicKey: string;
};

export type DecryptEnvelopeInput = {
  envelope: Envelope;
  recipientSecretKey: string;
};

export function createEnvelope(input: CreateEnvelopeInput): Envelope {
  const senderPublicKey = derivePublicKey(input.senderSecretKey);
  const nonce = randomBytes(12);
  const sharedKey = deriveEnvelopeKey({
    privateKey: input.senderSecretKey,
    publicKey: input.recipientPublicKey,
    context: `${ENVELOPE_CONTEXT}:${senderPublicKey}:${input.recipientPublicKey}`,
  });
  const cipher = createCipheriv("aes-256-gcm", sharedKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    version: ENVELOPE_VERSION,
    senderPublicKey,
    recipientPublicKey: input.recipientPublicKey,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptEnvelope(input: DecryptEnvelopeInput): string {
  if (input.envelope.version !== ENVELOPE_VERSION) {
    throw new Error("Unsupported envelope version");
  }

  const recipientPublicKey = derivePublicKey(input.recipientSecretKey);
  if (recipientPublicKey !== input.envelope.recipientPublicKey) {
    throw new Error("Envelope recipient does not match the provided secret key");
  }

  const sharedKey = deriveEnvelopeKey({
    privateKey: input.recipientSecretKey,
    publicKey: input.envelope.senderPublicKey,
    context: `${ENVELOPE_CONTEXT}:${input.envelope.senderPublicKey}:${input.envelope.recipientPublicKey}`,
  });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    sharedKey,
    Buffer.from(input.envelope.nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(input.envelope.authTag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(input.envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

function deriveEnvelopeKey(input: {
  privateKey: string;
  publicKey: string;
  context: string;
}): Buffer {
  const sharedSecret = diffieHellman({
    privateKey: importDeviceSecretKey(input.privateKey),
    publicKey: importDevicePublicKey(input.publicKey),
  });

  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.alloc(0),
      Buffer.from(input.context, "utf8"),
      32,
    ),
  );
}
