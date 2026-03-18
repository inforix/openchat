import { fileURLToPath } from "node:url";
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "workspace",
      environment: "node",
      include: ["tests/**/*.test.ts"]
    },
    resolve: {
      alias: [
        {
          find: /^@openchat\/(.*)$/,
          replacement: fileURLToPath(
            new URL("./packages/$1/src/index.ts", import.meta.url)
          )
        }
      ]
    }
  }
]);
