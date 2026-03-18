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

export const upsertConfiguredOpenChatAccount = async (
  transport: OpenClawTransport,
  account: ConfiguredOpenChatAccount,
): Promise<ConfiguredOpenChatAccount[]> => {
  const accounts = await listConfiguredOpenChatAccounts(transport);
  const existingIndex = accounts.findIndex(
    (candidate) => candidate.accountId === account.accountId,
  );

  if (existingIndex >= 0) {
    accounts[existingIndex] = account;
  } else {
    accounts.push(account);
  }

  await transport.configSet(OPENCHAT_ACCOUNTS_CONFIG_PATH, accounts);
  return accounts;
};
