"use client";

import React from "react";

type BotListHost = {
  hostId: string;
  name: string;
  status: "online" | "offline";
};

type BotListEntry = {
  botId: string;
  title: string;
  accountId: string;
  activeSessionId: string;
};

type BotListProps = {
  hosts: BotListHost[];
  selectedHostId: string | null;
  hostStatus: BotListHost["status"] | null;
  bots: BotListEntry[];
  onSelectHost: (hostId: string) => void;
  onReconnect: () => void | Promise<void>;
};

export function BotList({
  hosts,
  selectedHostId,
  hostStatus,
  bots,
  onSelectHost,
  onReconnect,
}: BotListProps) {
  return (
    <section className="panel shell-panel">
      <div className="section-kicker">Host Control</div>
      <div className="panel-header">
        <div>
          <h1>Hosts and OpenClaw bots</h1>
          <p className="lede">
            Pick a host first, then inspect its OpenClaw-backed bot roster.
          </p>
        </div>
        <button className="utility-button" type="button" onClick={() => void onReconnect()}>
          {hostStatus === "offline" ? "Reconnect to host" : "Refresh from host"}
        </button>
      </div>
      <div className="host-switcher" aria-label="Host switcher">
        {hosts.map((host) => {
          const selected = host.hostId === selectedHostId;
          return (
            <button
              key={host.hostId}
              className={selected ? "host-pill is-selected" : "host-pill"}
              type="button"
              onClick={() => onSelectHost(host.hostId)}
            >
              <span>{host.name}</span>
              <small>{host.status === "offline" ? "cached" : "live"}</small>
            </button>
          );
        })}
      </div>
      <ul className="bot-roster" aria-label="Bot roster">
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
        {bots.length === 0 ? <li className="bot-row is-empty">No bots available.</li> : null}
      </ul>
    </section>
  );
}
