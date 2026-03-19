import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:3100",
    channel: "chrome",
  },
  webServer: {
    command: "pnpm --filter @openchat/web exec next dev --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      NEXT_PUBLIC_OPENCHAT_E2E: "1",
    },
  },
});
