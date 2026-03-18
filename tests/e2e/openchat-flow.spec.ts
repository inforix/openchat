import { expect, test } from "@playwright/test";

import {
  addAuthoritativeBot,
  getTrustedFingerprint,
  installScenario,
  resolvePendingCreate,
  setAuthoritativeSession,
  setCreateBotMode,
  setHostStatus,
} from "./fixtures/fake-edge";
import { createBotScenario, createHostScenario, createScenario } from "./fixtures/fake-openclaw";

test("covers the openchat vertical slice", async ({ page }) => {
  const host = createHostScenario({
    hostId: "host-alpha",
    name: "North Relay",
    edgeKeyFingerprint: "edge-fingerprint-alpha",
    bots: [
      createBotScenario({
        accountId: "acct-ledger",
        agentId: "agent-ledger",
        title: "Ledger Room",
        activeMessages: [
          {
            id: "acct-ledger-active-message-1",
            role: "assistant",
            text: "Ready for the ledger.",
          },
        ],
      }),
    ],
  });

  await page.goto("/");
  await installScenario(page, createScenario([host]));

  await expect(page.getByRole("button", { name: /north relay/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /open ledger room/i })).toBeVisible();

  await page.goto("/pair");
  await expect(page.getByText(host.edgeKeyFingerprint)).toBeVisible();
  await page.getByRole("button", { name: /trust this host/i }).click();
  await expect.poll(() => getTrustedFingerprint(page, host.hostId)).toBe(host.edgeKeyFingerprint);

  await page.goto("/");
  await installScenario(page, createScenario([host]));
  await page.getByRole("link", { name: /create bot on north relay/i }).click();
  await expect(page.getByRole("heading", { name: /provision a new bot\./i })).toBeVisible();
  await setCreateBotMode(page, host.hostId, "deferred");
  await page.getByLabel("Account ID").fill("acct-journal");
  await page.getByLabel("Agent ID").fill("agent-writer");
  await page.getByRole("button", { name: /create bot/i }).click();
  await expect(
    page.getByRole("button", { name: /waiting for host confirmation/i }),
  ).toBeVisible();
  await expect(page.getByText("Journal Desk")).not.toBeVisible();

  await resolvePendingCreate(page, {
    hostId: host.hostId,
    accountId: "acct-journal",
    title: "Journal Desk",
  });
  await expect(page.getByText(/bot ready: journal desk/i)).toBeVisible();
  await expect(page.locator(".roster-preview strong", { hasText: "Journal Desk" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { name: /host-first bot navigation\./i })).toBeVisible();
  await page.getByRole("link", { name: /open ledger room/i }).click();
  await expect(page.getByText("Ready for the ledger.")).toBeVisible();

  await page.getByLabel("Message").fill("hello from playwright");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText("hello from playwright", { exact: true })).toBeVisible();
  await expect(page.getByText("Assistant reply for hello from playwright")).toBeVisible();

  await page.getByLabel("Message").fill("/new");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText(/active session acct-ledger-session-2/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /archived acct-ledger-active/i })).toBeVisible();

  await setHostStatus(page, host.hostId, "offline");
  await expect(page.getByText(/offline snapshot\. read-only until the host reconnects\./i)).toBeVisible();
  await expect(page.getByLabel("Message")).toBeDisabled();
  await expect(page.getByRole("button", { name: /send/i })).toBeDisabled();

  await page.goBack();
  await expect(page.getByRole("heading", { name: /host-first bot navigation\./i })).toBeVisible();
  await page.getByRole("link", { name: /create bot on north relay/i }).click();
  await expect(page.getByText(/offline read-only/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /create bot/i })).toBeDisabled();

  await addAuthoritativeBot(page, {
    hostId: host.hostId,
    accountId: "acct-scout",
    agentId: "agent-scout",
    title: "Scout Notes",
    assistantText: "Scout ready after reconnect.",
    syncClient: false,
  });
  await setAuthoritativeSession(page, {
    hostId: host.hostId,
    accountId: "acct-ledger",
    sessionId: "sess-reconnected",
    assistantText: "Fresh authoritative session.",
    syncClient: false,
  });
  await setHostStatus(page, host.hostId, "online", false);

  await page.goto("/");
  await expect(page.getByRole("button", { name: /reconnect to host/i })).toBeVisible();
  await page.getByRole("button", { name: /reconnect to host/i }).click();
  await expect(page.getByRole("link", { name: /open scout notes/i })).toBeVisible();
  await expect(page.getByText("sess-reconnected")).toBeVisible();

  await page.getByRole("link", { name: /open ledger room/i }).click();
  await expect(page.getByText(/active session sess-reconnected/i)).toBeVisible();

  await setAuthoritativeSession(page, {
    hostId: host.hostId,
    accountId: "acct-ledger",
    sessionId: "sess-conflict",
    assistantText: "Recovered after conflict.",
    syncClient: false,
  });
  await page.getByLabel("Message").fill("this should conflict");
  await page.getByRole("button", { name: /send/i }).click();

  await expect(
    page.getByText(/session moved on the host\. reloaded the authoritative active session\./i),
  ).toBeVisible();
  await expect(page.getByText(/active session sess-conflict/i)).toBeVisible();
  await expect(page.getByText("Recovered after conflict.")).toBeVisible();
});
