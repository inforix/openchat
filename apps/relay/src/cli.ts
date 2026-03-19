import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readRelayRuntimeConfig, startRelayRuntime } from "./runtime";

const isEntrypoint = (moduleUrl: string): boolean => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  return moduleUrl === pathToFileURL(resolve(entry)).href;
};

export const runRelayCli = async (): Promise<void> => {
  const config = readRelayRuntimeConfig(process.env, process.cwd());
  const runtime = await startRelayRuntime(config);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.info(`[openchat-relay] shutting down on ${signal}`);
    await runtime.close();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.info(
    `[openchat-relay] listening on ${runtime.server.baseHttpUrl} (${runtime.server.baseWebSocketUrl}/relay)`,
  );
  console.info(
    `[openchat-relay] sqlite store: ${runtime.config.storeFilename}`,
  );
};

if (isEntrypoint(import.meta.url)) {
  runRelayCli().catch((error: unknown) => {
    console.error("[openchat-relay] startup failed", error);
    process.exitCode = 1;
  });
}
