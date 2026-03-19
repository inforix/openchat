import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  readRelayRuntimeConfig,
  startRelayRuntime,
} from "../runtime";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "relay-runtime-"));
  tempDirs.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("relay runtime", () => {
  it("derives a sqlite file path from stateDir and supports port zero", () => {
    const config = readRelayRuntimeConfig(
      {
        OPENCHAT_RELAY_STATE_DIR: "/tmp/openchat-relay-state",
        OPENCHAT_RELAY_PORT: "0",
      },
      "/workspace/openchat",
    );

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(0);
    expect(config.stateDir).toBe("/tmp/openchat-relay-state");
    expect(config.storeFilename).toBe(
      "/tmp/openchat-relay-state/relay/relay.sqlite",
    );
  });

  it("starts a real relay server and creates the sqlite file", async () => {
    const stateDir = await createTempDir();
    const runtime = await startRelayRuntime({
      host: "127.0.0.1",
      port: 0,
      stateDir,
      storeFilename: join(stateDir, "relay", "relay.sqlite"),
    });

    try {
      const response = await fetch(`${runtime.server.baseHttpUrl}/auth/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceId: "missing-device",
          hostId: "missing-host",
          deviceCredential: "missing-credential",
        }),
      });

      expect(response.status).toBe(200);
      await expect(
        access(runtime.config.storeFilename, constants.F_OK),
      ).resolves.toBeUndefined();

      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "device_host_not_paired",
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects invalid relay ports from env", () => {
    expect(() =>
      readRelayRuntimeConfig(
        {
          OPENCHAT_RELAY_STATE_DIR: "/tmp/openchat-relay-state",
          OPENCHAT_RELAY_PORT: "70000",
        },
        "/workspace/openchat",
      ),
    ).toThrow("OPENCHAT_RELAY_PORT");
  });
});
