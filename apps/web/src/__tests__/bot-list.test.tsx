// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { buildBotAccount } from "@openchat/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetClientProtocol,
  seedClientProtocol,
  setCreateBotHandler,
  setHostSnapshotLoader,
  type BotRecord,
  type HostRecord,
  type SessionRecord,
} from "../lib/client-protocol";
import { getTrustedHost, resetDeviceStore } from "../lib/device-store";
import {
  cacheBotSessionSnapshot,
  cacheHostBotsSnapshot,
  clearOfflineCache,
} from "../lib/offline-cache";
import { BotScreen } from "../screens/bot-screen";
import { HomeScreen } from "../screens/home-screen";
import { NewBotScreen } from "../screens/new-bot-screen";
import { PairingScreen } from "../screens/pairing-screen";

const hostAlpha = createHost({
  hostId: "host-alpha",
  name: "North Relay",
  edgeKeyFingerprint: "fingerprint-alpha",
});
const hostBeta = createHost({
  hostId: "host-beta",
  name: "Studio Edge",
  edgeKeyFingerprint: "fingerprint-beta",
});

describe("web client shell", () => {
  beforeEach(() => {
    resetClientProtocol();
    resetDeviceStore();
    clearOfflineCache();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the host switcher with the known host list", () => {
    seedClientProtocol({
      hosts: [hostAlpha, hostBeta],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [createBot(hostAlpha.hostId, "acct-ledger", "agent-ledger")],
        [hostBeta.hostId]: [createBot(hostBeta.hostId, "acct-scout", "agent-scout")],
      },
      sessionsByBot: {},
    });

    render(<HomeScreen />);

    expect(
      screen.getByRole("button", { name: /north relay/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /studio edge/i }),
    ).toBeInTheDocument();
  });

  it("shows the edge key fingerprint before trust is stored", async () => {
    const user = userEvent.setup();

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {},
      sessionsByBot: {},
    });

    render(<PairingScreen hostId={hostAlpha.hostId} />);

    expect(screen.getByText(hostAlpha.edgeKeyFingerprint)).toBeInTheDocument();
    expect(getTrustedHost(hostAlpha.hostId)).toBeNull();

    await user.click(screen.getByRole("button", { name: /trust this host/i }));

    await waitFor(() => {
      expect(getTrustedHost(hostAlpha.hostId)?.edgeKeyFingerprint).toBe(
        hostAlpha.edgeKeyFingerprint,
      );
    });
  });

  it("renders OpenClaw-backed bots on the home screen", () => {
    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [
          createBot(hostAlpha.hostId, "acct-ledger", "agent-ledger", "Ledger Room"),
          createBot(hostAlpha.hostId, "acct-scout", "agent-scout", "Scout Notes"),
        ],
      },
      sessionsByBot: {},
    });

    render(<HomeScreen />);

    expect(screen.getByText("Ledger Room")).toBeInTheDocument();
    expect(screen.getByText("Scout Notes")).toBeInTheDocument();
    expect(screen.getAllByText(/openclaw account/i)).toHaveLength(2);
  });

  it("links each rendered bot into its active session route", () => {
    const ledgerBot = createBot(hostAlpha.hostId, "acct-ledger", "agent-ledger", "Ledger Room");

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [ledgerBot],
      },
      sessionsByBot: {},
    });

    render(<HomeScreen />);

    expect(
      screen.getByRole("link", { name: /open ledger room/i }),
    ).toHaveAttribute("href", `/hosts/${hostAlpha.hostId}/bots/${ledgerBot.botId}`);
  });

  it("exposes a first-class create-bot route for the selected host", () => {
    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [createBot(hostAlpha.hostId, "acct-ledger", "agent-ledger")],
      },
      sessionsByBot: {},
    });

    render(<HomeScreen />);

    expect(
      screen.getByRole("link", { name: /create bot on north relay/i }),
    ).toHaveAttribute("href", `/hosts/${hostAlpha.hostId}/bots/new`);
  });

  it("submits accountId and agentId and only shows success after host confirmation", async () => {
    const user = userEvent.setup();
    const confirmation = createDeferred<{
      ok: true;
      bot: BotRecord;
    }>();
    const createBot = vi.fn(() => confirmation.promise);

    setCreateBotHandler(createBot);
    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [createBotRecord("acct-ledger", "agent-ledger", "Ledger Room")],
      },
      sessionsByBot: {},
    });

    render(<NewBotScreen hostId={hostAlpha.hostId} />);

    await user.type(screen.getByLabelText(/account id/i), "acct-journal");
    await user.type(screen.getByLabelText(/agent id/i), "agent-writer");
    await user.click(screen.getByRole("button", { name: /create bot/i }));

    expect(createBot).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: hostAlpha.hostId,
        accountId: "acct-journal",
        agentId: "agent-writer",
      }),
    );
    expect(screen.queryByText(/bot ready/i)).not.toBeInTheDocument();

    confirmation.resolve({
      ok: true,
      bot: createBotRecord("acct-journal", "agent-writer", "Journal Desk"),
    });

    expect(await screen.findByText(/bot ready/i)).toBeInTheDocument();
    expect(screen.getByText("Journal Desk")).toBeInTheDocument();
  });

  it("renders the host-authored create failure without leaving draft ui state", async () => {
    const user = userEvent.setup();

    setCreateBotHandler(async () => ({
      ok: false,
      errorCode: "bot_create_failed",
      message: "OpenClaw refused the requested agent binding.",
    }));
    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [createBotRecord("acct-ledger", "agent-ledger", "Ledger Room")],
      },
      sessionsByBot: {},
    });

    render(<NewBotScreen hostId={hostAlpha.hostId} />);

    await user.type(screen.getByLabelText(/account id/i), "acct-failed");
    await user.type(screen.getByLabelText(/agent id/i), "agent-missing");
    await user.click(screen.getByRole("button", { name: /create bot/i }));

    expect(
      await screen.findByText("OpenClaw refused the requested agent binding."),
    ).toBeInTheDocument();
    expect(screen.queryByText("acct-failed")).not.toBeInTheDocument();
    expect(screen.queryByText(/draft/i)).not.toBeInTheDocument();
  });

  it("loads the current active session when entering a bot page", () => {
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-current");
    const activeSession = createSession(
      hostAlpha.hostId,
      bot.accountId,
      bot.activeSessionId,
      "Current active exchange",
    );

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [bot],
      },
      sessionsByBot: {
        [`${hostAlpha.hostId}:${bot.accountId}`]: activeSession,
      },
    });

    render(<BotScreen hostId={hostAlpha.hostId} botId={bot.botId} />);

    expect(screen.getByText("Current active exchange")).toBeInTheDocument();
    expect(screen.getByText(/active session sess-current/i)).toBeInTheDocument();
  });

  it("renders a cached snapshot banner when the host is offline", () => {
    const offlineHost = createHost({
      hostId: hostAlpha.hostId,
      name: hostAlpha.name,
      edgeKeyFingerprint: hostAlpha.edgeKeyFingerprint,
      status: "offline",
    });
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-cached");
    const cachedSession = createSession(
      offlineHost.hostId,
      bot.accountId,
      bot.activeSessionId,
      "Cached snapshot from the last live sync",
    );

    seedClientProtocol({
      hosts: [offlineHost],
      selectedHostId: offlineHost.hostId,
      botsByHost: {},
      sessionsByBot: {},
    });
    cacheHostBotsSnapshot(offlineHost.hostId, [bot]);
    cacheBotSessionSnapshot(
      { hostId: offlineHost.hostId, accountId: bot.accountId },
      cachedSession,
    );

    render(<BotScreen hostId={offlineHost.hostId} botId={bot.botId} />);

    expect(screen.getByText(/offline snapshot/i)).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(
      screen.getByText("Cached snapshot from the last live sync"),
    ).toBeInTheDocument();
  });

  it("reconnects and re-fetches the authoritative bot list and active session", async () => {
    const user = userEvent.setup();
    const offlineHost = createHost({
      hostId: hostAlpha.hostId,
      name: hostAlpha.name,
      edgeKeyFingerprint: hostAlpha.edgeKeyFingerprint,
      status: "offline",
    });
    const staleBot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-stale");
    const freshBot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-fresh");
    const newBot = createBotRecord("acct-scout", "agent-scout", "Scout Notes", "sess-scout");

    seedClientProtocol({
      hosts: [offlineHost],
      selectedHostId: offlineHost.hostId,
      botsByHost: {},
      sessionsByBot: {},
    });
    cacheHostBotsSnapshot(offlineHost.hostId, [staleBot]);
    cacheBotSessionSnapshot(
      { hostId: offlineHost.hostId, accountId: staleBot.accountId },
      createSession(offlineHost.hostId, staleBot.accountId, staleBot.activeSessionId, "Cached"),
    );
    setHostSnapshotLoader(async (hostId) => ({
      host: {
        ...offlineHost,
        hostId,
        status: "online",
      },
      bots: [freshBot, newBot],
      sessions: {
        [`${hostId}:${freshBot.accountId}`]: createSession(
          hostId,
          freshBot.accountId,
          freshBot.activeSessionId,
          "Fresh session",
        ),
        [`${hostId}:${newBot.accountId}`]: createSession(
          hostId,
          newBot.accountId,
          newBot.activeSessionId,
          "Scout session",
        ),
      },
    }));

    render(<HomeScreen />);

    expect(screen.getByText("sess-stale")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /reconnect to host/i }));

    expect(await screen.findByText("sess-fresh")).toBeInTheDocument();
    expect(screen.getByText("Scout Notes")).toBeInTheDocument();
  });
});

function createHost(input: {
  hostId: string;
  name: string;
  edgeKeyFingerprint: string;
  status?: HostRecord["status"];
}): HostRecord {
  return {
    hostId: input.hostId,
    name: input.name,
    edgeKeyFingerprint: input.edgeKeyFingerprint,
    status: input.status ?? "online",
  };
}

function createBot(
  hostId: string,
  accountId: string,
  agentId: string,
  title?: string,
): BotRecord {
  const bot = buildBotAccount({
    hostId,
    accountId,
    agentId,
    activeSessionId: `${accountId}-active`,
  });

  return {
    ...bot,
    title: title ?? accountId,
    backing: "openclaw",
  };
}

function createBotRecord(
  accountId: string,
  agentId: string,
  title: string,
  activeSessionId = `${accountId}-active`,
): BotRecord {
  return {
    ...buildBotAccount({
      hostId: hostAlpha.hostId,
      accountId,
      agentId,
      activeSessionId,
    }),
    title,
    backing: "openclaw",
  };
}

function createSession(
  hostId: string,
  accountId: string,
  sessionId: string,
  text: string,
): SessionRecord {
  return {
    hostId,
    accountId,
    sessionId,
    title: `Session ${sessionId}`,
    messages: [
      {
        id: `${sessionId}-message-1`,
        role: "assistant",
        text,
      },
    ],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
