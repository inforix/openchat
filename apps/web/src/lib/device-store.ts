import { useEffect, useState } from "react";

export type TrustedHostRecord = {
  hostId: string;
  edgeKeyFingerprint: string;
  trustedAt: string;
};

const trustedHosts = new Map<string, TrustedHostRecord>();
const listeners = new Set<() => void>();

export function trustHost(hostId: string, edgeKeyFingerprint: string): TrustedHostRecord {
  const record = {
    hostId,
    edgeKeyFingerprint,
    trustedAt: new Date().toISOString(),
  };

  trustedHosts.set(hostId, record);
  emitChange();
  return record;
}

export function getTrustedHost(hostId: string): TrustedHostRecord | null {
  return trustedHosts.get(hostId) ?? null;
}

export function resetDeviceStore(): void {
  trustedHosts.clear();
  emitChange();
}

export function useTrustedHost(hostId: string): TrustedHostRecord | null {
  const [trustedHost, setTrustedHost] = useState<TrustedHostRecord | null>(() =>
    getTrustedHost(hostId),
  );

  useEffect(() => {
    setTrustedHost(getTrustedHost(hostId));

    return subscribe(() => {
      setTrustedHost(getTrustedHost(hostId));
    });
  }, [hostId]);

  return trustedHost;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}
