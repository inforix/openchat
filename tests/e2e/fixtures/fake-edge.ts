import type { Page } from "@playwright/test";

import type { OpenChatE2EScenario } from "./fake-openclaw";

type HostStatus = "online" | "offline";
type CreateBotMode = "instant" | "deferred";

type HarnessApi = {
  installScenario: (scenario: OpenChatE2EScenario) => void;
  setHostStatus: (hostId: string, status: HostStatus, syncClient?: boolean) => void;
  setAuthoritativeSession: (input: {
    hostId: string;
    accountId: string;
    sessionId: string;
    assistantText: string;
    syncClient?: boolean;
  }) => void;
  addAuthoritativeBot: (input: {
    hostId: string;
    accountId: string;
    agentId: string;
    title: string;
    assistantText?: string;
    syncClient?: boolean;
  }) => void;
  setCreateBotMode: (hostId: string, mode: CreateBotMode) => void;
  resolvePendingCreate: (input: {
    hostId: string;
    accountId: string;
    title?: string;
    syncClient?: boolean;
  }) => void;
  getTrustedFingerprint: (hostId: string) => string | null;
};

declare global {
  interface Window {
    __openchatE2E?: HarnessApi;
  }
}

export async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.__openchatE2E !== "undefined");
}

export async function installScenario(page: Page, scenario: OpenChatE2EScenario): Promise<void> {
  await waitForHarness(page);
  await page.evaluate((value) => {
    window.__openchatE2E?.installScenario(value);
  }, scenario);
}

export async function setHostStatus(
  page: Page,
  hostId: string,
  status: HostStatus,
  syncClient = true,
): Promise<void> {
  await waitForHarness(page);
  await page.evaluate(
    (value) => {
      window.__openchatE2E?.setHostStatus(value.hostId, value.status, value.syncClient);
    },
    { hostId, status, syncClient },
  );
}

export async function setAuthoritativeSession(
  page: Page,
  input: {
    hostId: string;
    accountId: string;
    sessionId: string;
    assistantText: string;
    syncClient?: boolean;
  },
): Promise<void> {
  await waitForHarness(page);
  await page.evaluate((value) => {
    window.__openchatE2E?.setAuthoritativeSession(value);
  }, input);
}

export async function addAuthoritativeBot(
  page: Page,
  input: {
    hostId: string;
    accountId: string;
    agentId: string;
    title: string;
    assistantText?: string;
    syncClient?: boolean;
  },
): Promise<void> {
  await waitForHarness(page);
  await page.evaluate((value) => {
    window.__openchatE2E?.addAuthoritativeBot(value);
  }, input);
}

export async function setCreateBotMode(
  page: Page,
  hostId: string,
  mode: CreateBotMode,
): Promise<void> {
  await waitForHarness(page);
  await page.evaluate(
    (value) => {
      window.__openchatE2E?.setCreateBotMode(value.hostId, value.mode);
    },
    { hostId, mode },
  );
}

export async function resolvePendingCreate(
  page: Page,
  input: {
    hostId: string;
    accountId: string;
    title?: string;
    syncClient?: boolean;
  },
): Promise<void> {
  await waitForHarness(page);
  await page.evaluate((value) => {
    window.__openchatE2E?.resolvePendingCreate(value);
  }, input);
}

export async function getTrustedFingerprint(
  page: Page,
  hostId: string,
): Promise<string | null> {
  await waitForHarness(page);
  return page.evaluate((value) => window.__openchatE2E?.getTrustedFingerprint(value) ?? null, hostId);
}
