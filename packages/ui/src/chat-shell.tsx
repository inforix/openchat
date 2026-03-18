"use client";

import React from "react";

type ChatHost = {
  name: string;
};

type ChatBot = {
  title: string;
  accountId: string;
  activeSessionId: string;
};

type ChatSession = {
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
  }>;
};

type ChatShellProps = {
  host: ChatHost;
  bot: ChatBot;
  session: ChatSession | null;
  cached: boolean;
};

export function ChatShell({ host, bot, session, cached }: ChatShellProps) {
  return (
    <section className="panel shell-panel">
      <div className="section-kicker">Active Session</div>
      <div className="panel-header">
        <div>
          <h1>{bot.title}</h1>
          <p className="lede">
            Host {host.name} routes directly into the current active session.
          </p>
        </div>
        <div className="session-stamp">
          <span>{bot.accountId}</span>
          <strong>Active session {bot.activeSessionId}</strong>
        </div>
      </div>
      {cached ? (
        <div className="status-banner is-muted">
          Offline snapshot. Read-only until the host reconnects.
        </div>
      ) : null}
      <ol className="message-log">
        {session?.messages.map((message) => (
          <li key={message.id} className="message-row">
            <span className="message-role">{message.role}</span>
            <p>{message.text}</p>
          </li>
        ))}
      </ol>
      {session === null ? <p className="lede">No active session is available.</p> : null}
    </section>
  );
}
