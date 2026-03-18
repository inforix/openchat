"use client";

import { ChatShell } from "@openchat/ui";
import React, { useEffect, useState } from "react";

import {
  shouldAutoSyncSessionSnapshots,
  syncSessionForBot,
  useClientShell,
} from "../lib/client-protocol";

type BotScreenProps = {
  hostId?: string;
  botId?: string;
};

export function BotScreen({ hostId, botId }: BotScreenProps) {
  const {
    getArchivedSessionsForBot,
    getBotById,
    getSessionForBot,
    getSessionRecordById,
    host,
    sendMessageForBot,
  } = useClientShell(hostId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const bot = host && botId ? getBotById(host.hostId, botId) : null;

  useEffect(() => {
    if (bot?.activeSessionId) {
      setSelectedSessionId(bot.activeSessionId);
    }
  }, [bot?.activeSessionId]);

  useEffect(() => {
    if (
      !host ||
      !bot ||
      host.status !== "online" ||
      !shouldAutoSyncSessionSnapshots()
    ) {
      return;
    }

    void syncSessionForBot(host.hostId, bot.accountId).catch(() => {});
  }, [bot?.accountId, host?.hostId, host?.status]);

  if (!host || !botId) {
    return (
      <main className="screen-shell">
        <section className="panel shell-panel">Bot not found.</section>
      </main>
    );
  }

  if (!bot) {
    return (
      <main className="screen-shell">
        <section className="panel shell-panel">Bot not found.</section>
      </main>
    );
  }

  const activeHost = host;
  const activeBot = bot;
  const sessionState = getSessionForBot(activeHost.hostId, activeBot.accountId);
  const archivedSessions = getArchivedSessionsForBot(activeHost.hostId, activeBot.accountId);
  const activeSession = sessionState.session;
  const selectedSessionStillVisible =
    selectedSessionId === activeBot.activeSessionId ||
    archivedSessions.some((session) => session.sessionId === selectedSessionId);
  const effectiveSessionId =
    selectedSessionId && selectedSessionStillVisible
      ? selectedSessionId
      : activeSession?.sessionId ?? activeBot.activeSessionId;
  const session =
    effectiveSessionId === activeBot.activeSessionId
      ? activeSession
      : getSessionRecordById(activeHost.hostId, activeBot.accountId, effectiveSessionId);
  const readOnly = cachedReadOnly(
    sessionState.fromCache,
    activeBot.activeSessionId,
    effectiveSessionId,
  );

  async function handleSubmit(text: string): Promise<boolean> {
    setPending(true);
    setStatusMessage(null);

    try {
      const result = await sendMessageForBot({
        hostId: activeHost.hostId,
        accountId: activeBot.accountId,
        text,
      });

      if (!result.ok) {
        if (result.code === "session_conflict") {
          setStatusMessage("Session moved on the host. Reloaded the authoritative active session.");
          return false;
        }

        if (result.code === "session_busy") {
          setStatusMessage("The active session is busy. Finish the current stream before /new.");
          return false;
        }

        if (result.code === "offline_read_only") {
          setStatusMessage("Host offline. Cached views are read-only.");
        }
        return false;
      }

      return true;
    } catch {
      setStatusMessage("Unable to reach the host.");
      return false;
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="screen-shell">
      <header className="masthead">
        <div>
          <div className="masthead-tag">Host → Bot → Active Session</div>
          <h1>{activeBot.title}</h1>
          <p>The bot route resolves straight to the current active session.</p>
        </div>
      </header>
      <div className="route-strip">
        <span>{activeHost.hostId}</span>
        <span>/</span>
        <span>{activeBot.accountId}</span>
        <span>/</span>
        <span>{activeBot.botId}</span>
      </div>
      <ChatShell
        host={activeHost}
        bot={activeBot}
        session={session}
        cached={sessionState.fromCache}
        archivedSessions={archivedSessions}
        selectedSessionId={effectiveSessionId}
        readOnly={readOnly}
        pending={pending}
        statusMessage={statusMessage}
        onSelectSession={setSelectedSessionId}
        onSubmit={handleSubmit}
      />
    </main>
  );
}

function cachedReadOnly(
  cached: boolean,
  activeSessionId: string,
  selectedSessionId: string,
): boolean {
  return cached || selectedSessionId !== activeSessionId;
}
