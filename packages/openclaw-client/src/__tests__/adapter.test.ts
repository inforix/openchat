import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenClawClient,
  type OpenClawTransport,
} from "../index";

const OPENCHAT_ACCOUNTS_CONFIG_PATH = "channels.openchat.accounts";

class FakeOpenClawTransport implements OpenClawTransport {
  readonly bindings: Array<{ agentId: string; binding: string }> = [];
  readonly configGetCalls: string[] = [];
  readonly configSetCalls: Array<{ path: string; value: unknown }> = [];
  readonly configUnsetCalls: string[] = [];
  readonly createSessionCalls: string[] = [];
  readonly sendCalls: Array<{
    accountId: string;
    sessionId: string;
    payload: { kind: string };
  }> = [];
  readonly abortCalls: Array<{ accountId: string; sessionId: string }> = [];

  private readonly config = new Map<string, unknown>();
  private nextSessionNumber = 1;
  failNextBindWith: Error | null = null;

  seedOpenChatAccounts(accounts: Array<{ accountId: string; agentId: string }>) {
    this.config.set(OPENCHAT_ACCOUNTS_CONFIG_PATH, structuredClone(accounts));
  }

  readOpenChatAccounts(): Array<{ accountId: string; agentId: string }> {
    return structuredClone(
      (this.config.get(OPENCHAT_ACCOUNTS_CONFIG_PATH) as
        | Array<{ accountId: string; agentId: string }>
        | undefined) ?? [],
    );
  }

  async configGet(path: string): Promise<unknown> {
    this.configGetCalls.push(path);
    return structuredClone(this.config.get(path));
  }

  async configSet(path: string, value: unknown): Promise<void> {
    this.configSetCalls.push({ path, value: structuredClone(value) });
    this.config.set(path, structuredClone(value));
  }

  async configUnset(path: string): Promise<void> {
    this.configUnsetCalls.push(path);
    this.config.delete(path);
  }

  async agentsBind(input: {
    agentId: string;
    binding: string;
  }): Promise<void> {
    if (this.failNextBindWith) {
      const error = this.failNextBindWith;
      this.failNextBindWith = null;
      throw error;
    }
    this.bindings.push(input);
  }

  async createSession(input: { accountId: string }): Promise<{ sessionId: string }> {
    this.createSessionCalls.push(input.accountId);
    return { sessionId: `sess-${this.nextSessionNumber++}` };
  }

  async sendMessage(input: {
    accountId: string;
    sessionId: string;
    payload: { kind: string };
  }): Promise<void> {
    this.sendCalls.push(input);
  }

  async abortMessage(input: {
    accountId: string;
    sessionId: string;
  }): Promise<void> {
    this.abortCalls.push(input);
  }
}

const tempDirs: string[] = [];

const createStateDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-client-"));
  tempDirs.push(directory);
  return directory;
};

const createClient = (input: {
  transport: FakeOpenClawTransport;
  stateDir: string;
  now?: () => number;
}) =>
  createOpenClawClient({
    hostId: "host-1",
    deviceId: "device-1",
    stateDir: input.stateDir,
    transport: input.transport,
    now: input.now,
  });

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("openclaw host adapter", () => {
  it("lists openchat bots from config with their active session", async () => {
    const transport = new FakeOpenClawTransport();
    transport.seedOpenChatAccounts([
      { accountId: "acct-1", agentId: "agent-1" },
      { accountId: "acct-2", agentId: "agent-2" },
    ]);
    const stateDir = await createStateDir();
    const client = createClient({ transport, stateDir });

    const firstSession = await client.createNextSession({
      accountId: "acct-1",
      expectedActiveSessionId: null,
      commandId: "cmd-seed-1",
    });

    const secondSession = await client.createNextSession({
      accountId: "acct-2",
      expectedActiveSessionId: null,
      commandId: "cmd-seed-2",
    });

    await expect(client.listOpenChatBots()).resolves.toEqual([
      {
        botId: "host-1:acct-1",
        channelType: "openchat",
        hostId: "host-1",
        accountId: "acct-1",
        agentId: "agent-1",
        activeSessionId: firstSession.sessionId,
      },
      {
        botId: "host-1:acct-2",
        channelType: "openchat",
        hostId: "host-1",
        accountId: "acct-2",
        agentId: "agent-2",
        activeSessionId: secondSession.sessionId,
      },
    ]);
    expect(transport.configGetCalls).toContain(OPENCHAT_ACCOUNTS_CONFIG_PATH);
  });

  it("creates a new openchat account with a required agentId", async () => {
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const client = createClient({ transport, stateDir });

    await expect(
      client.createOpenChatBot({
        accountId: "acct-1",
        agentId: "",
      }),
    ).rejects.toThrow(/agentId/i);

    const bot = await client.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    expect(bot).toMatchObject({
      botId: "host-1:acct-1",
      channelType: "openchat",
      hostId: "host-1",
      accountId: "acct-1",
      agentId: "agent-1",
      activeSessionId: "sess-1",
    });
    expect(transport.bindings).toEqual([
      { agentId: "agent-1", binding: "openchat:acct-1" },
    ]);
    expect(transport.configSetCalls).toEqual([
      {
        path: OPENCHAT_ACCOUNTS_CONFIG_PATH,
        value: [{ accountId: "acct-1", agentId: "agent-1" }],
      },
    ]);
  });

  it("does not allow createOpenChatBot to rebind an existing account", async () => {
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const client = createClient({ transport, stateDir });

    await client.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    await expect(
      client.createOpenChatBot({
        accountId: "acct-1",
        agentId: "agent-2",
      }),
    ).rejects.toThrow(/already exists/i);
    expect(transport.bindings).toEqual([
      { agentId: "agent-1", binding: "openchat:acct-1" },
    ]);
  });

  it("rolls back config if provisioning fails after config mutation so retry can succeed", async () => {
    const transport = new FakeOpenClawTransport();
    transport.seedOpenChatAccounts([{ accountId: "acct-existing", agentId: "agent-existing" }]);
    transport.failNextBindWith = new Error("bind failed");
    const stateDir = await createStateDir();
    const client = createClient({ transport, stateDir });

    await expect(
      client.createOpenChatBot({
        accountId: "acct-1",
        agentId: "agent-1",
      }),
    ).rejects.toThrow(/bind failed/i);
    expect(transport.readOpenChatAccounts()).toEqual([
      { accountId: "acct-existing", agentId: "agent-existing" },
    ]);

    const bot = await client.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    expect(bot).toMatchObject({
      accountId: "acct-1",
      agentId: "agent-1",
      activeSessionId: "sess-1",
    });
    expect(transport.readOpenChatAccounts()).toEqual([
      { accountId: "acct-existing", agentId: "agent-existing" },
      { accountId: "acct-1", agentId: "agent-1" },
    ]);
  });

  it("resolves the current active session for a bot", async () => {
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const client = createClient({ transport, stateDir });
    const bot = await client.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    await expect(
      client.getActiveSession({ accountId: "acct-1" }),
    ).resolves.toEqual({
      hostId: "host-1",
      accountId: "acct-1",
      sessionId: bot.activeSessionId,
    });
  });

  it("creates a new session, promotes it to active, and archives the previous session", async () => {
    let currentTime = Date.UTC(2026, 2, 18, 9, 0, 0);
    const now = () => currentTime;
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const client = createClient({ transport, stateDir, now });
    const bot = await client.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    currentTime += 60_000;
    const nextSession = await client.createNextSession({
      accountId: "acct-1",
      expectedActiveSessionId: bot.activeSessionId,
      commandId: "cmd-next-1",
    });

    expect(nextSession).toEqual({
      hostId: "host-1",
      accountId: "acct-1",
      sessionId: "sess-2",
    });
    await expect(
      client.getActiveSession({ accountId: "acct-1" }),
    ).resolves.toEqual(nextSession);
    await expect(
      client.listArchivedSessions({ accountId: "acct-1" }),
    ).resolves.toEqual([
      {
        sessionId: bot.activeSessionId,
        archivedAt: new Date(currentTime).toISOString(),
      },
    ]);
  });

  it("persists activeSessionId in OPENCLAW_STATE_DIR/openchat/account-state.json", async () => {
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const client = createClient({ transport, stateDir });
    const bot = await client.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    const statePath = join(stateDir, "openchat", "account-state.json");
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as {
      accounts: Array<{
        hostId: string;
        accountId: string;
        activeSessionId: string;
      }>;
    };

    expect(parsed.accounts).toContainEqual(
      expect.objectContaining({
        hostId: "host-1",
        accountId: "acct-1",
        activeSessionId: bot.activeSessionId,
      }),
    );
  });

  it("rejects sends with a stale targetSessionId and forwards sends and aborts for the active session", async () => {
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const client = createClient({ transport, stateDir });
    const bot = await client.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });
    const nextSession = await client.createNextSession({
      accountId: "acct-1",
      expectedActiveSessionId: bot.activeSessionId,
      commandId: "cmd-next-1",
    });

    await expect(
      client.sendMessage({
        accountId: "acct-1",
        targetSessionId: bot.activeSessionId,
        payload: {
          kind: "userMessage",
          text: "hello from a stale session",
        },
      }),
    ).rejects.toMatchObject({
      code: "session_conflict",
      activeSessionId: nextSession.sessionId,
    });
    expect(transport.sendCalls).toHaveLength(0);

    await client.sendMessage({
      accountId: "acct-1",
      targetSessionId: nextSession.sessionId,
      payload: {
        kind: "userMessage",
        text: "hello from the active session",
      },
    });
    await client.abortMessage({
      accountId: "acct-1",
      targetSessionId: nextSession.sessionId,
    });

    expect(transport.sendCalls).toEqual([
      {
        accountId: "acct-1",
        sessionId: nextSession.sessionId,
        payload: {
          kind: "userMessage",
          text: "hello from the active session",
        },
      },
    ]);
    expect(transport.abortCalls).toEqual([
      { accountId: "acct-1", sessionId: nextSession.sessionId },
    ]);
  });

  it("preserves commandId to resultingSessionId mappings for ten minutes across restart", async () => {
    let currentTime = Date.UTC(2026, 2, 18, 10, 0, 0);
    const now = () => currentTime;
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const firstClient = createClient({ transport, stateDir, now });
    const bot = await firstClient.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });

    currentTime += 60_000;
    const initialResult = await firstClient.createNextSession({
      accountId: "acct-1",
      expectedActiveSessionId: bot.activeSessionId,
      commandId: "cmd-duplicate",
    });

    const secondClient = createClient({ transport, stateDir, now });
    currentTime += 60_000;
    const retriedResult = await secondClient.createNextSession({
      accountId: "acct-1",
      expectedActiveSessionId: bot.activeSessionId,
      commandId: "cmd-duplicate",
    });

    expect(retriedResult).toEqual(initialResult);
    expect(transport.createSessionCalls).toEqual(["acct-1", "acct-1"]);
  });

  it("recovers from a corrupted primary state file by falling back to .bak", async () => {
    const transport = new FakeOpenClawTransport();
    const stateDir = await createStateDir();
    const firstClient = createClient({ transport, stateDir });
    const bot = await firstClient.createOpenChatBot({
      accountId: "acct-1",
      agentId: "agent-1",
    });
    const statePath = join(stateDir, "openchat", "account-state.json");
    const backupPath = `${statePath}.bak`;

    await expect(readFile(backupPath, "utf8")).resolves.toContain(bot.activeSessionId);
    await writeFile(statePath, "{ definitely-not-json", "utf8");

    const restartedClient = createClient({ transport, stateDir });

    await expect(
      restartedClient.getActiveSession({ accountId: "acct-1" }),
    ).resolves.toEqual({
      hostId: "host-1",
      accountId: "acct-1",
      sessionId: bot.activeSessionId,
    });
  });

  it("prefers a newer backup over an older but parseable primary snapshot", async () => {
    const transport = new FakeOpenClawTransport();
    transport.seedOpenChatAccounts([{ accountId: "acct-1", agentId: "agent-1" }]);
    const stateDir = await createStateDir();
    const stateDirectory = join(stateDir, "openchat");
    const statePath = join(stateDirectory, "account-state.json");
    const backupPath = `${statePath}.bak`;
    const olderTime = new Date("2026-03-18T10:00:00.000Z");
    const newerTime = new Date("2026-03-18T10:05:00.000Z");

    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          accounts: [
            {
              hostId: "host-1",
              accountId: "acct-1",
              activeSessionId: "sess-stale",
              archivedSessions: [],
              commandResults: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      backupPath,
      `${JSON.stringify(
        {
          version: 1,
          accounts: [
            {
              hostId: "host-1",
              accountId: "acct-1",
              activeSessionId: "sess-fresh",
              archivedSessions: [],
              commandResults: [
                {
                  deviceId: "device-1",
                  commandId: "cmd-fresh",
                  resultingSessionId: "sess-fresh",
                  createdAt: newerTime.getTime(),
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await utimes(statePath, olderTime, olderTime);
    await utimes(backupPath, newerTime, newerTime);

    const restartedClient = createClient({ transport, stateDir, now: () => newerTime.getTime() });

    await expect(
      restartedClient.getActiveSession({ accountId: "acct-1" }),
    ).resolves.toEqual({
      hostId: "host-1",
      accountId: "acct-1",
      sessionId: "sess-fresh",
    });
    await expect(
      restartedClient.createNextSession({
        accountId: "acct-1",
        expectedActiveSessionId: "sess-stale",
        commandId: "cmd-fresh",
      }),
    ).resolves.toEqual({
      hostId: "host-1",
      accountId: "acct-1",
      sessionId: "sess-fresh",
    });
    expect(transport.createSessionCalls).toEqual([]);
  });
});
