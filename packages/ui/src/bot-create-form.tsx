"use client";

import { type FormEvent, useState } from "react";
import React from "react";

type CreateBotResult =
  | {
      ok: true;
      bot: {
        title: string;
      };
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
    };

type BotCreateHost = {
  hostId: string;
  name: string;
  status: "online" | "offline";
};

type BotCreateRosterEntry = {
  botId: string;
  title: string;
  accountId: string;
  activeSessionId: string;
};

type BotCreateFormProps = {
  host: BotCreateHost;
  bots: BotCreateRosterEntry[];
  onSubmit: (input: { accountId: string; agentId: string }) => Promise<CreateBotResult>;
};

export function BotCreateForm({ host, bots, onSubmit }: BotCreateFormProps) {
  const [accountId, setAccountId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const readOnly = host.status === "offline";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (readOnly || pending) {
      return;
    }

    setPending(true);
    setError(null);
    setSuccess(null);

    const result = await onSubmit({ accountId, agentId });

    setPending(false);

    if (result.ok) {
      setAccountId("");
      setAgentId("");
      setSuccess(`Bot ready: ${result.bot.title}`);
      return;
    }

    setError(result.message);
  }

  return (
    <section className="panel shell-panel">
      <div className="section-kicker">Provisioning</div>
      <div className="panel-header">
        <div>
          <h1>Create a bot on {host.name}</h1>
          <p className="lede">
            Bind an OpenClaw account to a fixed agent. The host confirms success before the UI does.
          </p>
        </div>
        {readOnly ? <span className="read-only-chip">Offline read-only</span> : null}
      </div>
      <form className="stack-form" onSubmit={handleSubmit}>
        <label>
          <span>Account ID</span>
          <input
            name="accountId"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            disabled={readOnly || pending}
          />
        </label>
        <label>
          <span>Agent ID</span>
          <input
            name="agentId"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            disabled={readOnly || pending}
          />
        </label>
        <button
          className="action-button"
          type="submit"
          disabled={readOnly || pending || accountId.trim().length === 0 || agentId.trim().length === 0}
        >
          {pending ? "Waiting for host confirmation..." : "Create bot"}
        </button>
      </form>
      {success ? <p className="status-banner is-success">{success}</p> : null}
      {error ? <p className="status-banner is-error">{error}</p> : null}
      <div className="roster-preview">
        <h2>Current roster</h2>
        <ul className="bot-roster">
          {bots.map((bot) => (
            <li key={bot.botId} className="bot-row">
              <div>
                <strong>{bot.title}</strong>
                <p>{bot.accountId}</p>
              </div>
              <div className="bot-meta">
                <span>OpenClaw account</span>
                <span>{bot.activeSessionId}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
