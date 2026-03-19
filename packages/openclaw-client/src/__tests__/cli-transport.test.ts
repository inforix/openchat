import { describe, expect, it } from "vitest";

import { OPENCHAT_ACCOUNTS_CONFIG_PATH } from "../config";
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
          stderr: `Config path not found: ${OPENCHAT_ACCOUNTS_CONFIG_PATH}`,
        };
      },
    });

    await expect(
      transport.configGet(OPENCHAT_ACCOUNTS_CONFIG_PATH),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      ["config", "get", OPENCHAT_ACCOUNTS_CONFIG_PATH, "--json"],
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
                accountId: "acct-1",
                agentId: "agent-1",
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
      ["config", "get", OPENCHAT_ACCOUNTS_CONFIG_PATH, "--json"],
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
