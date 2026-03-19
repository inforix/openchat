"use client";

import { type FormEvent, useState } from "react";
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
  sessionId: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
  }>;
};

type ArchivedSession = {
  sessionId: string;
  archivedAt: string;
  summary?: string;
};

type ChatShellProps = {
  host: ChatHost;
  bot: ChatBot;
  session: ChatSession | null;
  cached: boolean;
  archivedSessions: ArchivedSession[];
  selectedSessionId: string;
  readOnly: boolean;
  pending: boolean;
  statusMessage: string | null;
  onSelectSession: (sessionId: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
};

export function ChatShell({
  host,
  bot,
  session,
  cached,
  archivedSessions,
  selectedSessionId,
  readOnly,
  pending,
  statusMessage,
  onSelectSession,
  onSubmit,
}: ChatShellProps) {
  const [draft, setDraft] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (readOnly || pending || draft.trim().length === 0) {
      return;
    }

    const value = draft;
    const clearDraft = await onSubmit(value);
    if (clearDraft) {
      setDraft("");
    }
  }

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
      <div className="session-switcher" aria-label="Session switcher">
        <button
          className={selectedSessionId === bot.activeSessionId ? "host-pill is-selected" : "host-pill"}
          type="button"
          onClick={() => onSelectSession(bot.activeSessionId)}
        >
          <span>Active {bot.activeSessionId}</span>
          <small>Current live session</small>
        </button>
      </div>
      {archivedSessions.length > 0 ? (
        <div className="session-switcher" aria-label="Archived sessions">
          {archivedSessions.map((archivedSession) => (
            <button
              key={archivedSession.sessionId}
              className={
                archivedSession.sessionId === selectedSessionId
                  ? "host-pill is-selected"
                  : "host-pill"
              }
              type="button"
              onClick={() => onSelectSession(archivedSession.sessionId)}
            >
              <span>Archived {archivedSession.sessionId}</span>
              <small>{archivedSession.summary ?? archivedSession.archivedAt}</small>
            </button>
          ))}
        </div>
      ) : null}
      {cached ? (
        <div className="status-banner is-muted">
          Offline snapshot. Read-only until the host reconnects.
        </div>
      ) : null}
      {readOnly && !cached ? (
        <div className="status-banner is-muted">Archived sessions are read-only.</div>
      ) : null}
      {statusMessage ? <div className="status-banner is-muted">{statusMessage}</div> : null}
      <ol className="message-log">
        {session?.messages.map((message) => (
          <li key={message.id} className="message-row">
            <span className="message-role">{message.role}</span>
            <p>{message.text}</p>
          </li>
        ))}
      </ol>
      {session === null ? <p className="lede">No active session is available.</p> : null}
      <form className="stack-form" onSubmit={handleSubmit}>
        <label>
          <span>Message</span>
          <input
            aria-label="Message"
            name="message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={readOnly || cached || pending}
          />
        </label>
        <button
          className="action-button"
          type="submit"
          disabled={readOnly || cached || pending || draft.trim().length === 0}
        >
          {pending ? "Waiting for host..." : "Send"}
        </button>
      </form>
    </section>
  );
}
