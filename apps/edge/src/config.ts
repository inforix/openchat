import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  generateDeviceKeyPair,
  type DeviceKeyPair,
} from "../../../packages/crypto/src/index";

type StoredEdgeKeyPair = {
  version: 1;
  keyPair: DeviceKeyPair;
};

export type EdgePaths = {
  edgeDirectory: string;
  keyPairPath: string;
  trustedDevicesPath: string;
};

export type EdgeConfigInput = {
  hostId: string;
  deviceId: string;
  stateDir: string;
  now?: () => Date;
  generatePairingNonce?: () => string;
};

export type EdgeConfig = {
  hostId: string;
  deviceId: string;
  stateDir: string;
  edgeId: string;
  edgePublicKey: string;
  edgeKeyFingerprint: string;
  now: () => Date;
  generatePairingNonce: () => string;
  paths: EdgePaths;
};

const DEFAULT_NOW = (): Date => new Date();

const createPaths = (stateDir: string): EdgePaths => {
  const edgeDirectory = join(stateDir, "edge");
  return {
    edgeDirectory,
    keyPairPath: join(edgeDirectory, "device-keypair.json"),
    trustedDevicesPath: join(edgeDirectory, "trusted-devices.json"),
  };
};

const readJsonFile = async <T>(path: string): Promise<T | null> => {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const loadOrCreateKeyPair = async (paths: EdgePaths): Promise<DeviceKeyPair> => {
  const stored = await readJsonFile<StoredEdgeKeyPair>(paths.keyPairPath);
  if (stored?.version === 1 && stored.keyPair) {
    return stored.keyPair;
  }

  const keyPair = generateDeviceKeyPair();
  await writeJsonFile(paths.keyPairPath, {
    version: 1,
    keyPair,
  } satisfies StoredEdgeKeyPair);
  return keyPair;
};

export const readEdgeJsonFile = readJsonFile;
export const writeEdgeJsonFile = writeJsonFile;

export const createEdgeConfig = async (
  input: EdgeConfigInput,
): Promise<EdgeConfig> => {
  const paths = createPaths(input.stateDir);
  const keyPair = await loadOrCreateKeyPair(paths);

  return {
    hostId: input.hostId,
    deviceId: input.deviceId,
    stateDir: input.stateDir,
    edgeId: `edge:${input.deviceId}`,
    edgePublicKey: keyPair.publicKey,
    edgeKeyFingerprint: keyPair.fingerprint,
    now: input.now ?? DEFAULT_NOW,
    generatePairingNonce: input.generatePairingNonce ?? randomUUID,
    paths,
  };
};
