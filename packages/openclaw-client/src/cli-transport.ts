import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import {
  mergeConfiguredOpenChatAccountsIntoBindings,
  OPENCHAT_BINDINGS_CONFIG_PATH,
  parseOpenClawBindings,
  readConfiguredOpenChatAccountsFromBindings,
} from "./config";
import { OpenClawClientError } from "./errors";
import type {
  MessagePayload,
  OpenClawTransport,
  ReadSessionResult,
  SessionTranscriptMessage,
} from "./sessions";

const execFile = promisify(execFileCallback);

type RunnerResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type OpenClawCliRunner = (args: string[]) => Promise<RunnerResult>;

export type CreateOpenClawCliTransportInput = {
  openClawBin?: string;
  profile?: string;
  runner?: OpenClawCliRunner;
  createId?: () => string;
};

type SessionsResetResult = {
  entry?: {
    sessionId?: string;
  };
};

type ChatHistoryResult = {
  sessionId?: string;
  messages?: unknown[];
};

const DEFAULT_OPENCLAW_BIN = "openclaw";

const defaultRunner = (
  openClawBin: string,
  profile?: string,
): OpenClawCliRunner => {
  return async (args: string[]): Promise<RunnerResult> => {
    const fullArgs = profile
      ? ["--profile", profile, ...args]
      : [...args];

    try {
      const result = await execFile(openClawBin, fullArgs, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const candidate = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        return {
          exitCode:
            typeof candidate.code === "number" ? candidate.code : 1,
          stdout: candidate.stdout ?? "",
          stderr: candidate.stderr ?? candidate.message ?? "",
        };
      }

      throw error;
    }
  };
};

const isMissingConfigPathError = (stderr: string): boolean =>
  stderr.includes("Config path not found:");

const parseJson = <T>(raw: string, context: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new OpenClawClientError(
      `${context} did not return valid JSON: ${String(error)}`,
    );
  }
};

const requireCommandSuccess = (
  result: RunnerResult,
  context: string,
): void => {
  if (result.exitCode === 0) {
    return;
  }

  throw new OpenClawClientError(
    `${context} failed: ${result.stderr || result.stdout || "unknown error"}`,
  );
};

const parseOpenChatBinding = (binding: string): {
  channel: string;
  accountId: string;
} => {
  const [channel, ...rest] = binding.split(":");
  const accountId = rest.join(":").trim();
  if (!channel || !accountId) {
    throw new OpenClawClientError(
      `binding must look like channel:accountId, got "${binding}"`,
    );
  }

  return {
    channel,
    accountId,
  };
};

const buildOpenChatSessionKey = (
  agentId: string,
  accountId: string,
): string => `agent:${agentId}:openchat:${accountId}`;

const normalizeMessageText = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const chunks = value
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const candidate = item as Record<string, unknown>;
        if (typeof candidate.text === "string") {
          return candidate.text;
        }

        return null;
      })
      .filter((item): item is string => Boolean(item));
    return chunks.length > 0 ? chunks.join("\n") : null;
  }

  return null;
};

const normalizeTranscriptMessage = (
  value: unknown,
  index: number,
): SessionTranscriptMessage | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const role = candidate.role;
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return null;
  }

  const text =
    typeof candidate.text === "string"
      ? candidate.text
      : normalizeMessageText(candidate.content);
  if (!text) {
    return null;
  }

  return {
    id:
      typeof candidate.id === "string" && candidate.id.length > 0
        ? candidate.id
        : `${role}-${index}`,
    role,
    text,
  };
};

export const createOpenClawCliTransport = (
  input: CreateOpenClawCliTransportInput = {},
): OpenClawTransport => {
  const run =
    input.runner ??
    defaultRunner(input.openClawBin ?? DEFAULT_OPENCLAW_BIN, input.profile);
  const createId = input.createId ?? randomUUID;

  const configGetJson = async (path: string): Promise<unknown> => {
    const result = await run(["config", "get", path, "--json"]);
    if (result.exitCode !== 0) {
      if (isMissingConfigPathError(result.stderr)) {
        return undefined;
      }

      requireCommandSuccess(result, `openclaw config get ${path}`);
    }

    return parseJson(result.stdout, `openclaw config get ${path}`);
  };

  const configSetJson = async (path: string, value: unknown): Promise<void> => {
    const result = await run([
      "config",
      "set",
      "--json",
      path,
      JSON.stringify(value),
    ]);
    requireCommandSuccess(result, `openclaw config set ${path}`);
  };

  const readConfiguredAccounts = async () =>
    readConfiguredOpenChatAccountsFromBindings(
      await configGetJson(OPENCHAT_BINDINGS_CONFIG_PATH),
    );

  const resolveAgentIdForAccount = async (accountId: string): Promise<string> => {
    const accounts = await readConfiguredAccounts();
    const match = accounts.find((account) => account.accountId === accountId);
    if (!match) {
      throw new OpenClawClientError(
        `openchat account ${accountId} is not configured in OpenClaw`,
      );
    }

    return match.agentId;
  };

  const gatewayCall = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    const result = await run([
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
    ]);
    requireCommandSuccess(result, `openclaw gateway call ${method}`);
    return parseJson<T>(result.stdout, `openclaw gateway call ${method}`);
  };

  return {
    async configGet(path: string): Promise<unknown> {
      return await configGetJson(path);
    },

    async configSet(path: string, value: unknown): Promise<void> {
      await configSetJson(path, value);
    },

    async configUnset(path: string): Promise<void> {
      const result = await run(["config", "unset", path]);
      if (result.exitCode !== 0 && !isMissingConfigPathError(result.stderr)) {
        requireCommandSuccess(result, `openclaw config unset ${path}`);
      }
    },

    async agentsBind(inputValue): Promise<void> {
      const { accountId } = parseOpenChatBinding(inputValue.binding);
      const existingValue = await configGetJson(OPENCHAT_BINDINGS_CONFIG_PATH);
      const existingBindings = parseOpenClawBindings(existingValue);
      const existingAccounts =
        readConfiguredOpenChatAccountsFromBindings(existingValue);
      const existingAccount = existingAccounts.find(
        (account) => account.accountId === accountId,
      );
      if (existingAccount?.agentId === inputValue.agentId) {
        return;
      }

      if (existingAccount) {
        throw new OpenClawClientError(
          `openchat account ${accountId} is already bound to agent ${existingAccount.agentId}`,
        );
      }

      await configSetJson(
        OPENCHAT_BINDINGS_CONFIG_PATH,
        mergeConfiguredOpenChatAccountsIntoBindings(existingBindings, [
          ...existingAccounts,
          {
            accountId,
            agentId: inputValue.agentId,
          },
        ]),
      );
    },

    async createSession(inputValue): Promise<{ sessionId: string }> {
      const agentId = await resolveAgentIdForAccount(inputValue.accountId);
      const result = await gatewayCall<SessionsResetResult>("sessions.reset", {
        key: buildOpenChatSessionKey(agentId, inputValue.accountId),
        reason: "new",
      });
      const sessionId = result.entry?.sessionId;
      if (!sessionId) {
        throw new OpenClawClientError(
          `sessions.reset did not return a sessionId for ${inputValue.accountId}`,
        );
      }

      return { sessionId };
    },

    async readSession(inputValue): Promise<ReadSessionResult | null> {
      const agentId = await resolveAgentIdForAccount(inputValue.accountId);
      const result = await gatewayCall<ChatHistoryResult>("chat.history", {
        sessionKey: buildOpenChatSessionKey(agentId, inputValue.accountId),
        limit: 1_000,
      });

      if (result.sessionId !== inputValue.sessionId) {
        return null;
      }

      const messages = (result.messages ?? [])
        .map((message, index) => normalizeTranscriptMessage(message, index))
        .filter((message): message is SessionTranscriptMessage => message !== null);

      return {
        title: `Session ${inputValue.sessionId}`,
        messages,
      };
    },

    async sendMessage(inputValue): Promise<void> {
      if (inputValue.payload.kind !== "userMessage") {
        throw new OpenClawClientError(
          `OpenClaw CLI transport only supports userMessage payloads`,
        );
      }

      const agentId = await resolveAgentIdForAccount(inputValue.accountId);
      await gatewayCall("chat.send", {
        sessionKey: buildOpenChatSessionKey(agentId, inputValue.accountId),
        message: inputValue.payload.text,
        deliver: false,
        idempotencyKey: createId(),
      });
    },

    async abortMessage(inputValue): Promise<void> {
      const agentId = await resolveAgentIdForAccount(inputValue.accountId);
      await gatewayCall("chat.abort", {
        sessionKey: buildOpenChatSessionKey(agentId, inputValue.accountId),
      });
    },
  };
};
