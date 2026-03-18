"use client";

import { ChatShell } from "@openchat/ui";
import React from "react";

import { useClientShell } from "../../../../../src/lib/client-protocol";

type BotPageProps = {
  hostId?: string;
  botId?: string;
};

export function BotPage({ hostId, botId }: BotPageProps) {
  const { getBotById, getSessionForBot, host } = useClientShell(hostId);

  if (!host || !botId) {
    return (
      <main className="screen-shell">
        <section className="panel shell-panel">Bot not found.</section>
      </main>
    );
  }

  const bot = getBotById(host.hostId, botId);

  if (!bot) {
    return (
      <main className="screen-shell">
        <section className="panel shell-panel">Bot not found.</section>
      </main>
    );
  }

  const sessionState = getSessionForBot(host.hostId, bot.accountId);

  return (
    <main className="screen-shell">
      <header className="masthead">
        <div>
          <div className="masthead-tag">Host → Bot → Active Session</div>
          <h1>{bot.title}</h1>
          <p>The bot route resolves straight to the current active session.</p>
        </div>
      </header>
      <div className="route-strip">
        <span>{host.hostId}</span>
        <span>/</span>
        <span>{bot.accountId}</span>
        <span>/</span>
        <span>{bot.botId}</span>
      </div>
      <ChatShell
        host={host}
        bot={bot}
        session={sessionState.session}
        cached={sessionState.fromCache}
      />
    </main>
  );
}

export default function BotRoutePage({
  params,
}: {
  params: { hostId: string; botId: string };
}) {
  return <BotPage hostId={params.hostId} botId={params.botId} />;
}
