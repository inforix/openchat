import { OpenClawClientError } from "./errors";
import type { OpenClawTransport } from "./sessions";

export const OPENCHAT_BINDINGS_CONFIG_PATH = "bindings";
export const OPENCHAT_ACCOUNTS_CONFIG_PATH = OPENCHAT_BINDINGS_CONFIG_PATH;

export type ConfiguredOpenChatAccount = {
  accountId: string;
  agentId: string;
};

export type OpenClawBindingRecord = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: unknown;
    guildId?: unknown;
    teamId?: unknown;
    roles?: unknown;
  };
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

export const isBindingRecord = (value: unknown): value is OpenClawBindingRecord => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.agentId !== "string" || candidate.agentId.length === 0) {
    return false;
  }

  if (typeof candidate.match !== "object" || candidate.match === null) {
    return false;
  }

  const match = candidate.match as Record<string, unknown>;
  return (
    typeof match.channel === "string" &&
    match.channel.length > 0 &&
    (match.accountId === undefined || typeof match.accountId === "string")
  );
};

export const isCanonicalOpenChatAccountBinding = (
  binding: OpenClawBindingRecord,
): boolean =>
  binding.match.channel === "openchat" &&
  typeof binding.match.accountId === "string" &&
  binding.match.accountId.length > 0 &&
  binding.match.peer === undefined &&
  binding.match.guildId === undefined &&
  binding.match.teamId === undefined &&
  binding.match.roles === undefined;

export const parseOpenClawBindings = (
  value: unknown,
): OpenClawBindingRecord[] => {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || !value.every(isBindingRecord)) {
    throw new OpenClawClientError(
      `${OPENCHAT_BINDINGS_CONFIG_PATH} is not a valid OpenClaw bindings array`,
    );
  }

  return value.map((binding) => ({
    agentId: binding.agentId,
    match: { ...binding.match },
  }));
};

const toConfiguredOpenChatAccounts = (
  bindings: OpenClawBindingRecord[],
): ConfiguredOpenChatAccount[] => {
  const openChatBindings = bindings.filter(isCanonicalOpenChatAccountBinding);
  const accounts = new Map<string, string>();

  for (const binding of openChatBindings) {
    const accountId = binding.match.accountId as string;
    const previousAgentId = accounts.get(accountId);
    if (previousAgentId && previousAgentId !== binding.agentId) {
      throw new OpenClawClientError(
        `openchat account ${accountId} is bound to multiple agents`,
      );
    }

    accounts.set(accountId, binding.agentId);
  }

  return [...accounts.entries()].map(([accountId, agentId]) => ({
    accountId,
    agentId,
  }));
};

export const readConfiguredOpenChatAccountsFromBindings = (
  value: unknown,
): ConfiguredOpenChatAccount[] => {
  return toConfiguredOpenChatAccounts(parseOpenClawBindings(value));
};

export const toCanonicalOpenChatBinding = (
  account: ConfiguredOpenChatAccount,
): OpenClawBindingRecord => ({
  agentId: account.agentId,
  match: {
    channel: "openchat",
    accountId: account.accountId,
  },
});

export const mergeConfiguredOpenChatAccountsIntoBindings = (
  existingBindingsValue: unknown,
  accounts: ConfiguredOpenChatAccount[],
): OpenClawBindingRecord[] => {
  const existingBindings = parseOpenClawBindings(existingBindingsValue);
  return [
    ...existingBindings.filter(
      (binding) => !isCanonicalOpenChatAccountBinding(binding),
    ),
    ...accounts.map(toCanonicalOpenChatBinding),
  ];
};

export const listConfiguredOpenChatAccounts = async (
  transport: OpenClawTransport,
): Promise<ConfiguredOpenChatAccount[]> => {
  return readConfiguredOpenChatAccountsFromBindings(
    await transport.configGet(OPENCHAT_BINDINGS_CONFIG_PATH),
  );
};

export const writeConfiguredOpenChatAccounts = async (
  transport: OpenClawTransport,
  accounts: ConfiguredOpenChatAccount[],
): Promise<ConfiguredOpenChatAccount[]> => {
  const clonedAccounts = accounts.map((account) => ({ ...account }));
  if (!clonedAccounts.every(isConfiguredOpenChatAccount)) {
    throw new OpenClawClientError(`openchat account list is not valid`);
  }

  const nextBindings = mergeConfiguredOpenChatAccountsIntoBindings(
    await transport.configGet(OPENCHAT_BINDINGS_CONFIG_PATH),
    clonedAccounts,
  );

  if (nextBindings.length === 0) {
    await transport.configUnset(OPENCHAT_BINDINGS_CONFIG_PATH);
  } else {
    await transport.configSet(OPENCHAT_BINDINGS_CONFIG_PATH, nextBindings);
  }

  return clonedAccounts;
};
