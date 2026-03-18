"use client";

import { BotCreateForm } from "@openchat/ui";
import React from "react";

import { createBotForHost, useClientShell } from "../lib/client-protocol";

type NewBotScreenProps = {
  hostId?: string;
};

export function NewBotScreen({ hostId }: NewBotScreenProps) {
  const { bots, host } = useClientShell(hostId);

  if (!host) {
    return (
      <main className="screen-shell">
        <section className="panel shell-panel">Host not found.</section>
      </main>
    );
  }

  return (
    <main className="screen-shell">
      <header className="masthead">
        <div>
          <div className="masthead-tag">Host → Bots → New</div>
          <h1>Provision a new bot.</h1>
          <p>
            Bot creation is host-authoritative. OpenChat only shows success once the host confirms
            the account and agent binding.
          </p>
        </div>
      </header>
      <div className="route-strip">
        <span>{host.hostId}</span>
        <span>/</span>
        <span>new</span>
      </div>
      <BotCreateForm
        host={host}
        bots={bots}
        onSubmit={(input) =>
          createBotForHost({
            hostId: host.hostId,
            accountId: input.accountId,
            agentId: input.agentId,
          })
        }
      />
    </main>
  );
}
