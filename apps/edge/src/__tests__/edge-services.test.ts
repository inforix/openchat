import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  fingerprintPublicKey,
  type PairingToken,
} from "../../../../packages/crypto/src/index";
import {
  createOpenClawClient,
  type CreateOpenChatBotInput,
  type MessagePayload,
  type OpenChatBot,
  type OpenClawClient,
  type OpenClawTransport,
  type SendMessageInput,
} from "../../../../packages/openclaw-client/src/index";
import { afterEach, describe, expect, it } from "vitest";

type TransportSendCall = {
  accountId: string;
  sessionId: string;
  payload: MessagePayload;
};

type EdgeOpenClawAdapter = Pick<
  OpenClawClient,
  | "listOpenChatBots"
  | "createOpenChatBot"
  | "getActiveSession"
  | "listArchivedSessions"
  | "readSessionTranscript"
  | "createNextSession"
  | "sendMessage"
  | "abortMessage"
> & {
  confirmAccountCreated(input: CreateOpenChatBotInput): Promise<boolean>;
};

type CreateEdgeMain = typeof import("../index").createEdgeMain;
type EdgeMain = ReturnType<CreateEdgeMain>;
type EdgeSendResult = Awaited<ReturnType<EdgeMain["handleMessage"]>>;
type TrustedDeviceRecord = Awaited<ReturnType<EdgeMain["confirmPairing"]>>;

const assertCreateEdgeMainRequiresStreamState = (
  createEdgeMain: CreateEdgeMain,
): void => {
  const relay = {
    async registerEdge(): Promise<void> {},
  };
  const openClaw = {} as EdgeOpenClawAdapter;

  // @ts-expect-error streamState must stay mandatory to preserve session_busy guarantees
  createEdgeMain({
    hostId: "host-1",
    deviceId: "device-1",
    stateDir: "/tmp/openchat-edge-state",
    relay,
    openClaw,
  });
};

void assertCreateEdgeMainRequiresStreamState;

const OPENCHAT_ACCOUNTS_CONFIG_PATH = "channels.openchat.accounts";
const tempDirs: string[] = [];
const pendingMicrotasks = async (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
};

class FakeRelay {
  readonly registerCalls: Array<{
    hostId: string;
    edgeId: string;
    edgePublicKey: string;
    edgeKeyFingerprint: string;
  }> = [];

  async registerEdge(input: {
    hostId: string;
    edgeId: string;
    edgePublicKey: string;
    edgeKeyFingerprint: string;
  }): Promise<void> {
    this.registerCalls.push(input);
  }
}

class FakeStreamStateSource {
  private activeStreams = new Set<string>();

  setActive(accountId: string, active: boolean): void {
    if (active) {
      this.activeStreams.add(accountId);
      return;
    }
    this.activeStreams.delete(accountId);
  }

  async hasActiveStream(input: { accountId: string }): Promise<boolean> {
    return this.activeStreams.has(input.accountId);
  }
}

const createStreamState = (): FakeStreamStateSource =>
  new FakeStreamStateSource();

class FakeOpenClawTransport implements OpenClawTransport {
  readonly bindings: Array<{ agentId: string; binding: string }> = [];
  readonly createSessionCalls: string[] = [];
  readonly sendCalls: TransportSendCall[] = [];
  readonly abortCalls: Array<{ accountId: string; sessionId: string }> = [];

  private readonly config = new Map<string, unknown>();
  private nextSessionNumber = 1;
  private pendingSend: Promise<void> | null = null;
  private resolvePendingSend: (() => void) | null = null;

  seedOpenChatAccounts(accounts: Array<{ accountId: string; agentId: string }>) {
    this.config.set(OPENCHAT_ACCOUNTS_CONFIG_PATH, structuredClone(accounts));
  }

  holdNextSendOpen(): void {
    this.pendingSend = new Promise<void>((resolve) => {
      this.resolvePendingSend = resolve;
    });
  }

  releasePendingSend(): void {
    this.resolvePendingSend?.();
    this.pendingSend = null;
    this.resolvePendingSend = null;
  }

  async configGet(path: string): Promise<unknown> {
    return structuredClone(this.config.get(path));
  }

  async configSet(path: string, value: unknown): Promise<void> {
    this.config.set(path, structuredClone(value));
  }

  async configUnset(path: string): Promise<void> {
    this.config.delete(path);
  }

  async agentsBind(input: {
    agentId: string;
    binding: string;
  }): Promise<void> {
    this.bindings.push(input);
  }

  async createSession(input: { accountId: string }): Promise<{ sessionId: string }> {
    this.createSessionCalls.push(input.accountId);
    return { sessionId: `sess-${this.nextSessionNumber++}` };
  }

  async sendMessage(input: TransportSendCall): Promise<void> {
    this.sendCalls.push(structuredClone(input));
    await this.pendingSend;
  }

  async abortMessage(input: {
    accountId: string;
    sessionId: string;
  }): Promise<void> {
    this.abortCalls.push(input);
  }
}

class ConfirmingOpenClawAdapter implements EdgeOpenClawAdapter {
  readonly createRequests: CreateOpenChatBotInput[] = [];
  readonly confirmRequests: CreateOpenChatBotInput[] = [];
  private readonly confirmations = new Map<string, boolean>();
  streamConflictShape: { code: "session_conflict"; activeSessionId: string | null } | null =
    null;

  constructor(private readonly client: OpenClawClient) {}

  setAccountConfirmation(accountId: string, confirmed: boolean): void {
    this.confirmations.set(accountId, confirmed);
  }

  async confirmAccountCreated(
    input: CreateOpenChatBotInput,
  ): Promise<boolean> {
    this.confirmRequests.push(structuredClone(input));
    return this.confirmations.get(input.accountId) ?? true;
  }

  async listOpenChatBots(): Promise<OpenChatBot[]> {
    return this.client.listOpenChatBots();
  }

  async createOpenChatBot(input: CreateOpenChatBotInput): Promise<OpenChatBot> {
    this.createRequests.push(structuredClone(input));
    return this.client.createOpenChatBot(input);
  }

  async getActiveSession(input: { accountId: string }) {
    return this.client.getActiveSession(input);
  }

  async listArchivedSessions(input: { accountId: string }) {
    return this.client.listArchivedSessions(input);
  }

  async readSessionTranscript(input: {
    accountId: string;
    sessionId: string;
  }) {
    return this.client.readSessionTranscript(input);
  }

  async createNextSession(input: {
    accountId: string;
    expectedActiveSessionId: string | null;
    commandId: string;
  }) {
    return this.client.createNextSession(input);
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    if (this.streamConflictShape) {
      throw { ...this.streamConflictShape };
    }
    return this.client.sendMessage(input);
  }

  async abortMessage(input: {
    accountId: string;
    targetSessionId: string;
  }): Promise<void> {
    return this.client.abortMessage(input);
  }
}

const createStateDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "edge-services-"));
  tempDirs.push(directory);
  return directory;
};

const loadCreateEdgeMain = async (): Promise<CreateEdgeMain> => {
  const module = await import("../index");
  if (typeof module.createEdgeMain !== "function") {
    throw new Error("createEdgeMain export is missing");
  }
  return module.createEdgeMain;
};

const createOpenClawAdapter = async (input?: {
  stateDir?: string;
  transport?: FakeOpenClawTransport;
  now?: () => Date;
}): Promise<{
  adapter: ConfirmingOpenClawAdapter;
  transport: FakeOpenClawTransport;
  stateDir: string;
}> => {
  const transport = input?.transport ?? new FakeOpenClawTransport();
  const stateDir = input?.stateDir ?? (await createStateDir());
  const client = createOpenClawClient({
    hostId: "host-1",
    deviceId: "device-1",
    stateDir,
    transport,
    now: input?.now ? () => input.now!().getTime() : undefined,
  });

  return {
    adapter: new ConfirmingOpenClawAdapter(client),
    transport,
    stateDir,
  };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("edge services", () => {
  it("registers itself to relay with hostId", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
    });

    await edge.start();

    expect(relay.registerCalls).toEqual([
      expect.objectContaining({
        hostId: "host-1",
      }),
    ]);
  });

  it("fails fast when streamState is missing at runtime", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter();

    expect(() =>
      (
        createEdgeMain as unknown as (input: {
          hostId: string;
          deviceId: string;
          stateDir: string;
          relay: FakeRelay;
          openClaw: EdgeOpenClawAdapter;
        }) => EdgeMain
      )({
        hostId: "host-1",
        deviceId: "device-1",
        stateDir,
        relay,
        openClaw: adapter,
      }),
    ).toThrow(/streamstate/i);
  });

  it("returns pairing token data with edge key identity and a nonce-backed expiry", async () => {
    let currentTime = new Date("2026-03-18T10:00:00.000Z");
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter({
      now: () => currentTime,
    });
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
      now: () => currentTime,
      generatePairingNonce: () => "nonce-1",
    });

    const token = await edge.createPairingResponse({ ttlMs: 60_000 });

    expect(token).toEqual({
      hostId: "host-1",
      edgePublicKey: expect.any(String),
      edgeKeyFingerprint: expect.any(String),
      expiresAt: "2026-03-18T10:01:00.000Z",
      pairingNonce: "nonce-1",
    });
    expect(token.edgeKeyFingerprint).toBe(
      fingerprintPublicKey(token.edgePublicKey),
    );
  });

  it("writes trusted device records locally and rejects unconfirmed, replayed, or expired pairings", async () => {
    let currentTime = new Date("2026-03-18T11:00:00.000Z");
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter({
      now: () => currentTime,
    });
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
      now: () => currentTime,
      generatePairingNonce: () => "nonce-2",
    });
    const token = await edge.createPairingResponse({ ttlMs: 1_000 });

    await expect(
      edge.confirmPairing({
        deviceId: "trusted-device-1",
        token,
        confirmedEdgeKeyFingerprint: "wrong-fingerprint",
      }),
    ).rejects.toThrow(/fingerprint/i);

    const record = await edge.confirmPairing({
      deviceId: "trusted-device-1",
      token,
      confirmedEdgeKeyFingerprint: token.edgeKeyFingerprint,
    });

    expect(record).toMatchObject({
      deviceId: "trusted-device-1",
      hostId: "host-1",
      edgeKeyFingerprint: token.edgeKeyFingerprint,
    });
    await expect(
      readFile(join(stateDir, "edge", "trusted-devices.json"), "utf8"),
    ).resolves.toContain("trusted-device-1");

    await expect(
      edge.confirmPairing({
        deviceId: "trusted-device-1",
        token,
        confirmedEdgeKeyFingerprint: token.edgeKeyFingerprint,
      }),
    ).rejects.toThrow(/already been used/i);

    currentTime = new Date("2026-03-18T11:05:00.000Z");
    const expiredToken = await edge.createPairingResponse({ ttlMs: 500 });
    currentTime = new Date("2026-03-18T11:05:01.000Z");

    await expect(
      edge.confirmPairing({
        deviceId: "trusted-device-2",
        token: expiredToken,
        confirmedEdgeKeyFingerprint: expiredToken.edgeKeyFingerprint,
      }),
    ).rejects.toThrow(/expired/i);
  });

  it("rejects concurrent replay when two pairing confirmations race on the same token", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
      generatePairingNonce: () => "nonce-race",
    });
    const token = await edge.createPairingResponse({ ttlMs: 60_000 });

    const firstAttempt = edge.confirmPairing({
      deviceId: "trusted-device-race-1",
      token,
      confirmedEdgeKeyFingerprint: token.edgeKeyFingerprint,
    });
    const secondAttempt = edge.confirmPairing({
      deviceId: "trusted-device-race-2",
      token,
      confirmedEdgeKeyFingerprint: token.edgeKeyFingerprint,
    });

    const results = await Promise.allSettled([firstAttempt, secondAttempt]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<TrustedDeviceRecord> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/already been used/i);
    await expect(
      readFile(join(stateDir, "edge", "trusted-devices.json"), "utf8"),
    ).resolves.toContain(fulfilled[0].value.deviceId);
  });

  it("lists bots from OpenClaw on demand with fresh reads", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
    });

    await adapter.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    await expect(edge.listBots()).resolves.toHaveLength(1);

    await adapter.createOpenChatBot({
      accountId: "acct-2",
      agentId: "agent-2",
    });

    await expect(edge.listBots()).resolves.toEqual([
      expect.objectContaining({ accountId: "acct-1" }),
      expect.objectContaining({ accountId: "acct-2" }),
    ]);
  });

  it("creates a bot only after OpenClaw confirms account creation", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter();
    adapter.setAccountConfirmation("acct-1", false);
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
    });

    await expect(
      edge.createBot({
        accountId: "acct-1",
        agentId: "agent-1",
      }),
    ).rejects.toThrow(/confirm/i);
    expect(adapter.createRequests).toEqual([]);

    adapter.setAccountConfirmation("acct-1", true);
    const bot = await edge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    expect(bot).toMatchObject({
      accountId: "acct-1",
      agentId: "agent-1",
      activeSessionId: "sess-1",
    });
    expect(adapter.confirmRequests).toEqual([
      { accountId: "acct-1", agentId: "agent-1" },
      { accountId: "acct-1", agentId: "agent-1" },
    ]);
  });

  it("handles /new as an edge-owned system command and returns the new activeSessionId", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, transport, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
    });
    const bot = await edge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    const result = await edge.handleMessage({
      accountId: "acct-1",
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "systemCommand",
        command: {
          type: "session.new",
          expectedActiveSessionId: bot.activeSessionId,
          commandId: "cmd-new-1",
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      activeSessionId: "sess-2",
      resultingSessionId: "sess-2",
      forwarded: false,
      archivedSessions: [
        {
          sessionId: "sess-1",
          archivedAt: expect.any(String) as string,
        },
      ],
    });
    expect(transport.sendCalls).toEqual([]);
  });

  it("returns session_busy for /new while a stream is in flight", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const transport = new FakeOpenClawTransport();
    const streamState = new FakeStreamStateSource();
    const { adapter, stateDir } = await createOpenClawAdapter({ transport });
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState,
    });
    const bot = await edge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });
    streamState.setActive("acct-1", true);
    transport.holdNextSendOpen();

    const sendPromise = edge.handleMessage({
      accountId: "acct-1",
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "userMessage",
        text: "stream this",
      },
    });

    await expect(
      edge.handleMessage({
        accountId: "acct-1",
        targetSessionId: bot.activeSessionId,
        payload: {
          kind: "systemCommand",
          command: {
            type: "session.new",
            expectedActiveSessionId: bot.activeSessionId,
            commandId: "cmd-busy-1",
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "session_busy",
      activeSessionId: bot.activeSessionId,
      archivedSessions: [],
    });

    streamState.setActive("acct-1", false);
    transport.releasePendingSend();
    await expect(sendPromise).resolves.toEqual({
      ok: true,
      activeSessionId: bot.activeSessionId,
      forwarded: true,
      archivedSessions: [],
    });
  });

  it("returns session_busy based on explicit adapter stream state even after send resolves", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const streamState = new FakeStreamStateSource();
    const { adapter, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState,
    });
    const bot = await edge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    streamState.setActive("acct-1", true);
    await expect(
      edge.handleMessage({
        accountId: "acct-1",
        targetSessionId: bot.activeSessionId,
        payload: {
          kind: "userMessage",
          text: "send and resolve immediately",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      activeSessionId: bot.activeSessionId,
      forwarded: true,
      archivedSessions: [],
    });

    await pendingMicrotasks();
    await expect(
      edge.handleMessage({
        accountId: "acct-1",
        targetSessionId: bot.activeSessionId,
        payload: {
          kind: "systemCommand",
          command: {
            type: "session.new",
            expectedActiveSessionId: bot.activeSessionId,
            commandId: "cmd-busy-explicit",
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "session_busy",
      activeSessionId: bot.activeSessionId,
      archivedSessions: [],
    });

    streamState.setActive("acct-1", false);
    await expect(
      edge.handleMessage({
        accountId: "acct-1",
        targetSessionId: bot.activeSessionId,
        payload: {
          kind: "systemCommand",
          command: {
            type: "session.new",
            expectedActiveSessionId: bot.activeSessionId,
            commandId: "cmd-busy-explicit-next",
          },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      activeSessionId: "sess-2",
      resultingSessionId: "sess-2",
      forwarded: false,
      archivedSessions: [
        {
          sessionId: "sess-1",
          archivedAt: expect.any(String) as string,
        },
      ],
    });
  });

  it("returns session_conflict for sends that target a stale session", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, transport, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
    });
    const bot = await edge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });
    const nextSession = await edge.handleMessage({
      accountId: "acct-1",
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "systemCommand",
        command: {
          type: "session.new",
          expectedActiveSessionId: bot.activeSessionId,
          commandId: "cmd-new-2",
        },
      },
    });

    await expect(
      edge.handleMessage({
        accountId: "acct-1",
        targetSessionId: bot.activeSessionId,
        payload: {
          kind: "userMessage",
          text: "hello from the stale session",
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "session_conflict",
      activeSessionId:
        nextSession.ok && nextSession.resultingSessionId
          ? nextSession.resultingSessionId
          : null,
      archivedSessions: [
        {
          sessionId: "sess-1",
          archivedAt: expect.any(String) as string,
        },
      ],
    });
    expect(transport.sendCalls).toEqual([]);
  });

  it("returns session_conflict when session.new is addressed to a stale targetSessionId", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
    });
    const bot = await edge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });
    const nextSession = await edge.handleMessage({
      accountId: "acct-1",
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "systemCommand",
        command: {
          type: "session.new",
          expectedActiveSessionId: bot.activeSessionId,
          commandId: "cmd-session-new-stale-seed",
        },
      },
    });

    await expect(
      edge.handleMessage({
        accountId: "acct-1",
        targetSessionId: bot.activeSessionId,
        payload: {
          kind: "systemCommand",
          command: {
            type: "session.new",
            expectedActiveSessionId:
              nextSession.ok && nextSession.resultingSessionId
                ? nextSession.resultingSessionId
                : null,
            commandId: "cmd-session-new-stale-target",
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "session_conflict",
      activeSessionId:
        nextSession.ok && nextSession.resultingSessionId
          ? nextSession.resultingSessionId
          : null,
      archivedSessions: [
        {
          sessionId: "sess-1",
          archivedAt: expect.any(String) as string,
        },
      ],
    });
  });

  it("serializes /new against concurrent sends on the same account", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, transport, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
    });
    const bot = await edge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });
    const releaseCreate = createDeferred<void>();
    const originalCreateNextSession = adapter.createNextSession.bind(adapter);
    adapter.createNextSession = async (input) => {
      await releaseCreate.promise;
      return originalCreateNextSession(input);
    };

    const newSessionPromise = edge.handleMessage({
      accountId: "acct-1",
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "systemCommand",
        command: {
          type: "session.new",
          expectedActiveSessionId: bot.activeSessionId,
          commandId: "cmd-serialize-new",
        },
      },
    });

    await pendingMicrotasks();

    const staleSendPromise = edge.handleMessage({
      accountId: "acct-1",
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "userMessage",
        text: "should not reach archived session",
      },
    });

    releaseCreate.resolve();

    await expect(newSessionPromise).resolves.toEqual({
      ok: true,
      activeSessionId: "sess-2",
      resultingSessionId: "sess-2",
      forwarded: false,
      archivedSessions: [
        {
          sessionId: "sess-1",
          archivedAt: expect.any(String) as string,
        },
      ],
    });
    await expect(staleSendPromise).resolves.toEqual({
      ok: false,
      code: "session_conflict",
      activeSessionId: "sess-2",
      archivedSessions: [
        {
          sessionId: "sess-1",
          archivedAt: expect.any(String) as string,
        },
      ],
    });
    expect(transport.sendCalls).toEqual([]);
  });

  it("translates structurally-shaped session_conflict errors without relying on class identity", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const { adapter, stateDir } = await createOpenClawAdapter();
    const edge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: adapter,
      streamState: createStreamState(),
    });
    const bot = await edge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    adapter.streamConflictShape = {
      code: "session_conflict",
      activeSessionId: "sess-foreign",
    };

    await expect(
      edge.handleMessage({
        accountId: "acct-1",
        targetSessionId: bot.activeSessionId,
        payload: {
          kind: "userMessage",
          text: "plain-object conflict",
        },
      }),
    ).resolves.toEqual({
      ok: false,
      code: "session_conflict",
      activeSessionId: "sess-foreign",
      archivedSessions: [],
    });
  });

  it("returns the original resultingSessionId for a duplicate commandId after edge restart", async () => {
    const createEdgeMain = await loadCreateEdgeMain();
    const relay = new FakeRelay();
    const currentTime = new Date("2026-03-18T12:00:00.000Z");
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const { adapter: firstAdapter } = await createOpenClawAdapter({
      stateDir,
      transport,
      now: () => currentTime,
    });
    const firstEdge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: firstAdapter,
      streamState: createStreamState(),
      now: () => currentTime,
    });
    const bot = await firstEdge.createBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    const initialResult = await firstEdge.handleMessage({
      accountId: "acct-1",
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "systemCommand",
        command: {
          type: "session.new",
          expectedActiveSessionId: bot.activeSessionId,
          commandId: "cmd-duplicate",
        },
      },
    });

    const { adapter: restartedAdapter } = await createOpenClawAdapter({
      stateDir,
      transport,
      now: () => currentTime,
    });
    const restartedEdge = createEdgeMain({
      hostId: "host-1",
      deviceId: "device-1",
      stateDir,
      relay,
      openClaw: restartedAdapter,
      streamState: createStreamState(),
      now: () => currentTime,
    });
    const retriedResult = await restartedEdge.handleMessage({
      accountId: "acct-1",
      targetSessionId: bot.activeSessionId,
      payload: {
        kind: "systemCommand",
        command: {
          type: "session.new",
          expectedActiveSessionId: bot.activeSessionId,
          commandId: "cmd-duplicate",
        },
      },
    });

    expect(retriedResult).toEqual(initialResult);
    expect(transport.createSessionCalls).toEqual(["acct-1", "acct-1"]);
  });
});
