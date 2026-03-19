import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readEdgeRuntimeConfig, startEdgeRuntime } from "./runtime";

const isEntrypoint = (moduleUrl: string): boolean => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  return moduleUrl === pathToFileURL(resolve(entry)).href;
};

export const runEdgeCli = async (): Promise<void> => {
  const config = readEdgeRuntimeConfig(process.env, process.cwd());
  const runtime = await startEdgeRuntime(config);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.info(`[openchat-edge] shutting down on ${signal}`);
    await runtime.close();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.info(`[openchat-edge] host: ${runtime.config.hostId}`);
  console.info(`[openchat-edge] device: ${runtime.config.deviceId}`);
  console.info(`[openchat-edge] relay: ${runtime.config.relayWebSocketUrl}`);
  console.info(`[openchat-edge] state dir: ${runtime.config.stateDir}`);
};

if (isEntrypoint(import.meta.url)) {
  runEdgeCli().catch((error: unknown) => {
    console.error("[openchat-edge] startup failed", error);
    process.exitCode = 1;
  });
}
