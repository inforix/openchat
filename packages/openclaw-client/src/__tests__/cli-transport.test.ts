import { describe, expect, it } from "vitest";

import { OPENCHAT_BINDINGS_CONFIG_PATH } from "../config";
import { createOpenClawCliTransport } from "../cli-transport";

type RunnerResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

describe("openclaw cli transport", () => {
  it("treats missing config paths as undefined", async () => {
    const calls: string[][] = [];
    const transport = createOpenClawCliTransport({
      runner: async (args): Promise<RunnerResult> => {
        calls.push(args);
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Config path not found: ${OPENCHAT_BINDINGS_CONFIG_PATH}`,
        };
      },
    });

    await expect(
      transport.configGet(OPENCHAT_BINDINGS_CONFIG_PATH),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      ["config", "get", OPENCHAT_BINDINGS_CONFIG_PATH, "--json"],
    ]);
  });

  it("writes a new openchat binding into top-level bindings", async () => {
    const calls: string[][] = [];
    const transport = createOpenClawCliTransport({
      runner: async (args): Promise<RunnerResult> => {
        calls.push(args);

        if (args[0] === "config" && args[1] === "get") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Config path not found: bindings",
          };
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    await transport.agentsBind({
      agentId: "agent-1",
      binding: "openchat:acct-1",
    });

    expect(calls).toEqual([
      ["config", "get", "bindings", "--json"],
      [
        "config",
        "set",
        "--json",
        "bindings",
        JSON.stringify([
          {
            agentId: "agent-1",
            match: {
              channel: "openchat",
              accountId: "acct-1",
            },
          },
        ]),
      ],
    ]);
  });

  it("preserves unrelated bindings when writing a new openchat binding", async () => {
    const calls: string[][] = [];
    const transport = createOpenClawCliTransport({
      runner: async (args): Promise<RunnerResult> => {
        calls.push(args);

        if (args[0] === "config" && args[1] === "get") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                agentId: "agent-discord",
                match: {
                  channel: "discord",
                  guildId: "guild-1",
                },
              },
            ]),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    await transport.agentsBind({
      agentId: "agent-1",
      binding: "openchat:acct-1",
    });

    expect(calls).toEqual([
      ["config", "get", "bindings", "--json"],
      [
        "config",
        "set",
        "--json",
        "bindings",
        JSON.stringify([
          {
            agentId: "agent-discord",
            match: {
              channel: "discord",
              guildId: "guild-1",
            },
          },
          {
            agentId: "agent-1",
            match: {
              channel: "openchat",
              accountId: "acct-1",
            },
          },
        ]),
      ],
    ]);
  });

  it("rejects conflicting openchat account bindings", async () => {
    const calls: string[][] = [];
    const transport = createOpenClawCliTransport({
      runner: async (args): Promise<RunnerResult> => {
        calls.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              agentId: "agent-1",
              match: {
                channel: "openchat",
                accountId: "acct-1",
              },
            },
            {
              agentId: "agent-2",
              match: {
                channel: "openchat",
                accountId: "acct-1",
              },
            },
          ]),
          stderr: "",
        };
      },
    });

    await expect(
      transport.createSession({ accountId: "acct-1" }),
    ).rejects.toThrow(/multiple agents/i);
    expect(calls).toEqual([["config", "get", "bindings", "--json"]]);
  });

  it("refuses to append a conflicting openchat binding for the same account", async () => {
    const calls: string[][] = [];
    const transport = createOpenClawCliTransport({
      runner: async (args): Promise<RunnerResult> => {
        calls.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              agentId: "agent-1",
              match: {
                channel: "openchat",
                accountId: "acct-1",
              },
            },
          ]),
          stderr: "",
        };
      },
    });

    await expect(
      transport.agentsBind({
        agentId: "agent-2",
        binding: "openchat:acct-1",
      }),
    ).rejects.toThrow(/already bound/i);
    expect(calls).toEqual([["config", "get", "bindings", "--json"]]);
  });

  it("creates the next session by resetting a deterministic openchat session key", async () => {
    const calls: string[][] = [];
    const transport = createOpenClawCliTransport({
      runner: async (args): Promise<RunnerResult> => {
        calls.push(args);

        if (args[0] === "config" && args[1] === "get") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                agentId: "agent-1",
                match: {
                  channel: "openchat",
                  accountId: "acct-1",
                },
              },
            ]),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            entry: {
              sessionId: "session-2",
            },
          }),
          stderr: "",
        };
      },
    });

    await expect(
      transport.createSession({ accountId: "acct-1" }),
    ).resolves.toEqual({
      sessionId: "session-2",
    });

    expect(calls).toEqual([
      ["config", "get", OPENCHAT_BINDINGS_CONFIG_PATH, "--json"],
      [
        "gateway",
        "call",
        "sessions.reset",
        "--params",
        JSON.stringify({
          key: "agent:agent-1:openchat:acct-1",
          reason: "new",
        }),
        "--json",
      ],
    ]);
  });
});
