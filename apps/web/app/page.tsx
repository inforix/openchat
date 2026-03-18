"use client";

import { BotList } from "@openchat/ui";
import React from "react";

import { useClientShell } from "../src/lib/client-protocol";

export function HomeScreen() {
  const { bots, host, hosts, reconnectHost, selectHost, selectedHostId } = useClientShell();

  return (
    <main className="screen-shell">
      <header className="masthead">
        <div>
          <div className="masthead-tag">OpenChat / Control Room</div>
          <h1>Host-first bot navigation.</h1>
          <p>
            OpenChat stays anchored to your trusted hosts: choose a host, inspect its OpenClaw
            bots, then enter the active session directly.
          </p>
        </div>
      </header>
      <BotList
        hosts={hosts}
        selectedHostId={selectedHostId}
        hostStatus={host?.status ?? null}
        bots={bots}
        onSelectHost={selectHost}
        onReconnect={() => (host ? reconnectHost(host.hostId) : Promise.resolve())}
      />
    </main>
  );
}

export default function HomePage() {
  return <HomeScreen />;
}
