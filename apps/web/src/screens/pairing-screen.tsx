"use client";

import { useMemo } from "react";
import React from "react";

import { useClientShell } from "../lib/client-protocol";
import { trustHost, useTrustedHost } from "../lib/device-store";

type PairingScreenProps = {
  hostId?: string;
};

export function PairingScreen({ hostId }: PairingScreenProps) {
  const { host: requestedHost, hosts } = useClientShell(hostId);
  const host = useMemo(
    () => requestedHost ?? (hostId ? null : hosts[0] ?? null),
    [hostId, hosts, requestedHost],
  );
  const trustedHost = useTrustedHost(host?.hostId ?? "");

  if (!host) {
    return (
      <main className="screen-shell">
        <section className="panel shell-panel">No host is available for pairing.</section>
      </main>
    );
  }

  return (
    <main className="screen-shell">
      <header className="masthead">
        <div>
          <div className="masthead-tag">Pairing / Trust On First Use</div>
          <h1>Confirm the edge fingerprint first.</h1>
          <p>
            OpenChat will not store host trust until you confirm the presented edge fingerprint on
            this device.
          </p>
        </div>
      </header>
      <section className="panel shell-panel">
        <div className="section-kicker">Pairing Confirmation</div>
        <div className="panel-header">
          <div>
            <h1>{host.name}</h1>
            <p className="lede">Compare this fingerprint with the host’s edge service.</p>
          </div>
          {trustedHost ? <span className="read-only-chip">Trusted on this device</span> : null}
        </div>
        <div className="bot-row">
          <div>
            <strong>edgeKeyFingerprint</strong>
            <p>{host.edgeKeyFingerprint}</p>
          </div>
          <div className="bot-meta">
            <span>Status</span>
            <span>{trustedHost ? "stored locally" : "awaiting confirmation"}</span>
          </div>
        </div>
        {!trustedHost ? (
          <button
            className="action-button"
            type="button"
            onClick={() => trustHost(host.hostId, host.edgeKeyFingerprint)}
          >
            Trust this host
          </button>
        ) : null}
      </section>
    </main>
  );
}
