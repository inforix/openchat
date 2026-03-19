import { OpenClawClientError } from "./errors";
import type { OpenClawTransport } from "./sessions";

export const OPENCHAT_ACCOUNTS_CONFIG_PATH = "channels.openchat.accounts";

export type ConfiguredOpenChatAccount = {
  accountId: string;
  agentId: string;
};

const isConfiguredOpenChatAccount = (
  value: unknown,
): value is ConfiguredOpenChatAccount => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accountId === "string" &&
    candidate.accountId.length > 0 &&
    typeof candidate.agentId === "string" &&
    candidate.agentId.length > 0
  );
};

export const listConfiguredOpenChatAccounts = async (
  transport: OpenClawTransport,
): Promise<ConfiguredOpenChatAccount[]> => {
  const value = await transport.configGet(OPENCHAT_ACCOUNTS_CONFIG_PATH);
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || !value.every(isConfiguredOpenChatAccount)) {
    throw new OpenClawClientError(
      `${OPENCHAT_ACCOUNTS_CONFIG_PATH} is not a valid openchat account list`,
    );
  }

  return value.map((account) => ({ ...account }));
};

export const writeConfiguredOpenChatAccounts = async (
  transport: OpenClawTransport,
  accounts: ConfiguredOpenChatAccount[],
): Promise<ConfiguredOpenChatAccount[]> => {
  const clonedAccounts = accounts.map((account) => ({ ...account }));
  if (clonedAccounts.length === 0) {
    await transport.configUnset(OPENCHAT_ACCOUNTS_CONFIG_PATH);
  } else {
    await transport.configSet(OPENCHAT_ACCOUNTS_CONFIG_PATH, clonedAccounts);
  }

  return clonedAccounts;
};
