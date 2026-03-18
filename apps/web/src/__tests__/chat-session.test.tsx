// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { buildBotAccount, type MessageSendRequest, type StreamEvent } from "@openchat/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotPage } from "../../app/hosts/[hostId]/bots/[botId]/page";
import {
  resetClientProtocol,
  seedClientProtocol,
  sendMessageForBot,
  setMessageCommandHandler,
  setSessionSnapshotLoader,
  type BotRecord,
  type HostRecord,
  type SessionRecord,
} from "../lib/client-protocol";

const hostAlpha = createHost({
  hostId: "host-alpha",
  name: "North Relay",
  edgeKeyFingerprint: "fingerprint-alpha",
});

describe("chat session flow", () => {
  beforeEach(() => {
    resetClientProtocol();
  });

  afterEach(() => {
    cleanup();
  });

  it("streams normal messages into the active session", async () => {
    const user = userEvent.setup();
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-active");
    const stream = createStreamController();
    const requests: MessageSendRequest[] = [];

    seedBotState(bot, createSession(hostAlpha.hostId, bot.accountId, bot.activeSessionId, "Ready"));
    setMessageCommandHandler(async (request) => {
      requests.push(request);
      return {
        result: {
          ok: true,
          activeSessionId: bot.activeSessionId,
          forwarded: true,
          archivedSessions: [],
        },
        stream: stream.iterable,
      };
    });

    render(<BotPage hostId={hostAlpha.hostId} botId={bot.botId} />);

    await user.type(screen.getByLabelText(/message/i), "hello active");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      accountId: bot.accountId,
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "userMessage",
        text: "hello active",
      },
    });

    await screen.findByText("hello active");

    stream.push({ type: "chunk", delta: "Alpha " });
    stream.push({ type: "chunk", delta: "Beta" });
    stream.push({ type: "done" });

    expect(await screen.findByText("Alpha Beta")).toBeInTheDocument();
  });

  it("encodes /new as a session.new command instead of user content", async () => {
    const user = userEvent.setup();
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-active");
    const deferred = createDeferred<{
      result: {
        ok: true;
        activeSessionId: string;
        resultingSessionId: string;
        forwarded: false;
        archivedSessions: Array<{ sessionId: string; archivedAt: string; summary?: string }>;
      };
    }>();
    const requests: MessageSendRequest[] = [];

    seedBotState(bot, createSession(hostAlpha.hostId, bot.accountId, bot.activeSessionId, "Ready"));
    setMessageCommandHandler(async (request) => {
      requests.push(request);
      return deferred.promise;
    });
    setSessionSnapshotLoader(async () => ({
      bot: createBotRecord(bot.accountId, bot.agentId, bot.title, "sess-next"),
      activeSession: createSession(hostAlpha.hostId, bot.accountId, "sess-next", "New session"),
      archivedSessions: [
        {
          sessionId: bot.activeSessionId,
          archivedAt: "2026-03-18T10:00:00.000Z",
        },
      ],
      sessionRecords: {
        [`${hostAlpha.hostId}:${bot.accountId}:${bot.activeSessionId}`]: createSession(
          hostAlpha.hostId,
          bot.accountId,
          bot.activeSessionId,
          "Ready",
        ),
      },
    }));

    render(<BotPage hostId={hostAlpha.hostId} botId={bot.botId} />);

    await user.type(screen.getByLabelText(/message/i), "/new");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(requests).toHaveLength(1);
    expect(requests[0].payload.kind).toBe("systemCommand");
    if (requests[0].payload.kind !== "systemCommand") {
      throw new Error("expected system command payload");
    }
    expect(requests[0].payload.command.type).toBe("session.new");
    expect(requests[0].payload.command.expectedActiveSessionId).toBe(bot.activeSessionId);
    expect(requests[0].targetSessionId).toBe(bot.activeSessionId);
    expect(screen.queryByText("/new")).not.toBeInTheDocument();

    deferred.resolve({
      result: {
        ok: true,
        activeSessionId: "sess-next",
        resultingSessionId: "sess-next",
        forwarded: false,
        archivedSessions: [
          {
            sessionId: bot.activeSessionId,
            archivedAt: "2026-03-18T10:00:00.000Z",
          },
        ],
      },
    });

    await screen.findByText("New session");
  });

  it("reloads the new active session after /new succeeds", async () => {
    const user = userEvent.setup();
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-active");

    seedBotState(bot, createSession(hostAlpha.hostId, bot.accountId, bot.activeSessionId, "Ready"));
    setMessageCommandHandler(async () => ({
      result: {
        ok: true,
        activeSessionId: "sess-next",
        resultingSessionId: "sess-next",
        forwarded: false,
        archivedSessions: [
          {
            sessionId: bot.activeSessionId,
            archivedAt: "2026-03-18T10:00:00.000Z",
          },
        ],
      },
    }));
    setSessionSnapshotLoader(async () => ({
      bot: createBotRecord(bot.accountId, bot.agentId, bot.title, "sess-next"),
      activeSession: createSession(hostAlpha.hostId, bot.accountId, "sess-next", "Freshly activated"),
      archivedSessions: [
        {
          sessionId: bot.activeSessionId,
          archivedAt: "2026-03-18T10:00:00.000Z",
        },
      ],
      sessionRecords: {
        [`${hostAlpha.hostId}:${bot.accountId}:${bot.activeSessionId}`]: createSession(
          hostAlpha.hostId,
          bot.accountId,
          bot.activeSessionId,
          "Ready",
        ),
      },
    }));

    render(<BotPage hostId={hostAlpha.hostId} botId={bot.botId} />);

    await user.type(screen.getByLabelText(/message/i), "/new");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("Freshly activated")).toBeInTheDocument();
    expect(screen.getByText(/active session sess-next/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /archived sess-active/i })).toBeInTheDocument();
  });

  it("deduplicates duplicate /new retries so only one command reaches the host", async () => {
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-active");
    const deferred = createDeferred<{
      result: {
        ok: true;
        activeSessionId: string;
        resultingSessionId: string;
        forwarded: false;
        archivedSessions: Array<{ sessionId: string; archivedAt: string; summary?: string }>;
      };
    }>();
    const requests: MessageSendRequest[] = [];

    seedBotState(bot, createSession(hostAlpha.hostId, bot.accountId, bot.activeSessionId, "Ready"));
    setMessageCommandHandler(async (request) => {
      requests.push(request);
      return deferred.promise;
    });
    setSessionSnapshotLoader(async () => ({
      bot: createBotRecord(bot.accountId, bot.agentId, bot.title, "sess-next"),
      activeSession: createSession(hostAlpha.hostId, bot.accountId, "sess-next", "Freshly activated"),
      archivedSessions: [
        {
          sessionId: bot.activeSessionId,
          archivedAt: "2026-03-18T10:00:00.000Z",
        },
      ],
      sessionRecords: {},
    }));

    const first = sendMessageForBot({
      hostId: hostAlpha.hostId,
      accountId: bot.accountId,
      text: "/new",
    });
    const second = sendMessageForBot({
      hostId: hostAlpha.hostId,
      accountId: bot.accountId,
      text: "/new",
    });

    expect(requests).toHaveLength(1);

    deferred.resolve({
      result: {
        ok: true,
        activeSessionId: "sess-next",
        resultingSessionId: "sess-next",
        forwarded: false,
        archivedSessions: [
          {
            sessionId: bot.activeSessionId,
            archivedAt: "2026-03-18T10:00:00.000Z",
          },
        ],
      },
    });

    await expect(first).resolves.toMatchObject({
      ok: true,
      activeSessionId: "sess-next",
    });
    await expect(second).resolves.toMatchObject({
      ok: true,
      activeSessionId: "sess-next",
    });
  });

  it("refreshes authoritative session state after a stale target session conflict", async () => {
    const user = userEvent.setup();
    const staleBot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-stale");
    const freshBot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-fresh");

    seedBotState(
      staleBot,
      createSession(hostAlpha.hostId, staleBot.accountId, staleBot.activeSessionId, "Stale active"),
    );
    setMessageCommandHandler(async () => ({
      result: {
        ok: false,
        code: "session_conflict",
        activeSessionId: "sess-fresh",
        archivedSessions: [
          {
            sessionId: staleBot.activeSessionId,
            archivedAt: "2026-03-18T10:00:00.000Z",
          },
        ],
      },
    }));
    setSessionSnapshotLoader(async () => ({
      bot: freshBot,
      activeSession: createSession(hostAlpha.hostId, freshBot.accountId, freshBot.activeSessionId, "Authoritative session"),
      archivedSessions: [
        {
          sessionId: staleBot.activeSessionId,
          archivedAt: "2026-03-18T10:00:00.000Z",
        },
      ],
      sessionRecords: {
        [`${hostAlpha.hostId}:${staleBot.accountId}:${staleBot.activeSessionId}`]: createSession(
          hostAlpha.hostId,
          staleBot.accountId,
          staleBot.activeSessionId,
          "Stale active",
        ),
      },
    }));

    render(<BotPage hostId={hostAlpha.hostId} botId={staleBot.botId} />);

    await user.type(screen.getByLabelText(/message/i), "hello stale");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("Authoritative session")).toBeInTheDocument();
    expect(screen.getByText(/active session sess-fresh/i)).toBeInTheDocument();
  });

  it("renders archived sessions as read-only and blocks sending", async () => {
    const user = userEvent.setup();
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-active");
    const handler = vi.fn();

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [bot],
      },
      sessionsByBot: {
        [`${hostAlpha.hostId}:${bot.accountId}`]: createSession(
          hostAlpha.hostId,
          bot.accountId,
          bot.activeSessionId,
          "Current active",
        ),
      },
      archivedSessionsByBot: {
        [`${hostAlpha.hostId}:${bot.accountId}`]: [
          {
            sessionId: "sess-archived",
            archivedAt: "2026-03-17T10:00:00.000Z",
            summary: "Previous run",
          },
        ],
      },
      sessionRecordsById: {
        [`${hostAlpha.hostId}:${bot.accountId}:sess-archived`]: createSession(
          hostAlpha.hostId,
          bot.accountId,
          "sess-archived",
          "Archived transcript",
        ),
      },
    });
    setMessageCommandHandler(handler);

    render(<BotPage hostId={hostAlpha.hostId} botId={bot.botId} />);

    await user.click(screen.getByRole("button", { name: /archived sess-archived/i }));

    expect(await screen.findByText("Archived transcript")).toBeInTheDocument();
    expect(screen.getByText(/archived sessions are read-only/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows returning from an archived session back to the active session", async () => {
    const user = userEvent.setup();
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-active");

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [bot],
      },
      sessionsByBot: {
        [`${hostAlpha.hostId}:${bot.accountId}`]: createSession(
          hostAlpha.hostId,
          bot.accountId,
          bot.activeSessionId,
          "Current active",
        ),
      },
      archivedSessionsByBot: {
        [`${hostAlpha.hostId}:${bot.accountId}`]: [
          {
            sessionId: "sess-archived",
            archivedAt: "2026-03-17T10:00:00.000Z",
            summary: "Previous run",
          },
        ],
      },
      sessionRecordsById: {
        [`${hostAlpha.hostId}:${bot.accountId}:sess-archived`]: createSession(
          hostAlpha.hostId,
          bot.accountId,
          "sess-archived",
          "Archived transcript",
        ),
      },
    });

    render(<BotPage hostId={hostAlpha.hostId} botId={bot.botId} />);

    await user.click(screen.getByRole("button", { name: /archived sess-archived/i }));
    expect(await screen.findByText("Archived transcript")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /active sess-active/i }));
    expect(await screen.findByText("Current active")).toBeInTheDocument();
    expect(screen.getByLabelText(/message/i)).not.toBeDisabled();
  });

  it("does not fall back to the active transcript when an archived transcript is unavailable", async () => {
    const user = userEvent.setup();
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-active");

    seedClientProtocol({
      hosts: [hostAlpha],
      selectedHostId: hostAlpha.hostId,
      botsByHost: {
        [hostAlpha.hostId]: [bot],
      },
      sessionsByBot: {
        [`${hostAlpha.hostId}:${bot.accountId}`]: createSession(
          hostAlpha.hostId,
          bot.accountId,
          bot.activeSessionId,
          "Current active",
        ),
      },
      archivedSessionsByBot: {
        [`${hostAlpha.hostId}:${bot.accountId}`]: [
          {
            sessionId: "sess-archived",
            archivedAt: "2026-03-17T10:00:00.000Z",
          },
        ],
      },
    });

    render(<BotPage hostId={hostAlpha.hostId} botId={bot.botId} />);

    await user.click(screen.getByRole("button", { name: /archived sess-archived/i }));

    expect(screen.queryByText("Current active")).not.toBeInTheDocument();
    expect(await screen.findByText(/no active session is available/i)).toBeInTheDocument();
  });

  it("clears stale active transcript state when authoritative refresh returns no active session", async () => {
    const user = userEvent.setup();
    const staleBot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-stale");

    seedBotState(
      staleBot,
      createSession(hostAlpha.hostId, staleBot.accountId, staleBot.activeSessionId, "Stale active"),
    );
    setMessageCommandHandler(async () => ({
      result: {
        ok: false,
        code: "session_conflict",
        activeSessionId: null,
        archivedSessions: [
          {
            sessionId: staleBot.activeSessionId,
            archivedAt: "2026-03-18T10:00:00.000Z",
          },
        ],
      },
    }));
    setSessionSnapshotLoader(async () => ({
      bot: createBotRecord(staleBot.accountId, staleBot.agentId, staleBot.title, staleBot.activeSessionId),
      activeSession: null,
      archivedSessions: [
        {
          sessionId: staleBot.activeSessionId,
          archivedAt: "2026-03-18T10:00:00.000Z",
        },
      ],
      sessionRecords: {},
    }));

    render(<BotPage hostId={hostAlpha.hostId} botId={staleBot.botId} />);

    await user.type(screen.getByLabelText(/message/i), "hello stale");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(screen.queryByText("Stale active")).not.toBeInTheDocument();
    expect(await screen.findByText(/no active session is available/i)).toBeInTheDocument();
  });

  it("keeps the draft and releases pending state when sending throws", async () => {
    const user = userEvent.setup();
    const bot = createBotRecord("acct-ledger", "agent-ledger", "Ledger Room", "sess-active");

    seedBotState(bot, createSession(hostAlpha.hostId, bot.accountId, bot.activeSessionId, "Ready"));
    setMessageCommandHandler(async () => {
      throw new Error("transport offline");
    });

    render(<BotPage hostId={hostAlpha.hostId} botId={bot.botId} />);

    await user.type(screen.getByLabelText(/message/i), "retain draft");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/unable to reach the host/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message/i)).toHaveValue("retain draft");
    expect(screen.getByRole("button", { name: /send/i })).not.toBeDisabled();
  });
});

function seedBotState(bot: BotRecord, activeSession: SessionRecord) {
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
}

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

function createStreamController() {
  const pending: Array<IteratorResult<StreamEvent>> = [];
  const waiting: Array<(value: IteratorResult<StreamEvent>) => void> = [];

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (pending.length > 0) {
              return Promise.resolve(pending.shift()!);
            }

            return new Promise<IteratorResult<StreamEvent>>((resolve) => {
              waiting.push(resolve);
            });
          },
        };
      },
    } satisfies AsyncIterable<StreamEvent>,
    push(event: StreamEvent) {
      const value: IteratorResult<StreamEvent> = {
        value: event,
        done: false,
      };
      const waiter = waiting.shift();
      if (waiter) {
        waiter(value);
        return;
      }
      pending.push(value);
    },
  };
}
