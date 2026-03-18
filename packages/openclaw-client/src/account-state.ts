import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { OpenClawClientError } from "./errors";

export type ActiveSession = {
  hostId: string;
  accountId: string;
  sessionId: string;
};

export type ArchivedSessionSummary = {
  sessionId: string;
  archivedAt: string;
  summary?: string;
};

export type CommandSessionResult = {
  deviceId: string;
  commandId: string;
  resultingSessionId: string;
  createdAt: number;
};

export type StoredAccountState = {
  hostId: string;
  accountId: string;
  activeSessionId: string | null;
  archivedSessions: ArchivedSessionSummary[];
  commandResults: CommandSessionResult[];
};

type AccountStateFile = {
  version: 1;
  accounts: StoredAccountState[];
};

type AccountStateCandidate = {
  state: AccountStateFile;
  mtimeMs: number;
};

const ACCOUNT_STATE_DIRECTORY = "openchat";
const ACCOUNT_STATE_FILENAME = "account-state.json";

const isArchivedSessionSummary = (
  value: unknown,
): value is ArchivedSessionSummary => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    typeof candidate.archivedAt === "string" &&
    candidate.archivedAt.length > 0 &&
    (candidate.summary === undefined ||
      (typeof candidate.summary === "string" && candidate.summary.length > 0))
  );
};

const isCommandSessionResult = (
  value: unknown,
): value is CommandSessionResult => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deviceId === "string" &&
    candidate.deviceId.length > 0 &&
    typeof candidate.commandId === "string" &&
    candidate.commandId.length > 0 &&
    typeof candidate.resultingSessionId === "string" &&
    candidate.resultingSessionId.length > 0 &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt)
  );
};

const isStoredAccountState = (value: unknown): value is StoredAccountState => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.hostId === "string" &&
    candidate.hostId.length > 0 &&
    typeof candidate.accountId === "string" &&
    candidate.accountId.length > 0 &&
    (candidate.activeSessionId === null ||
      (typeof candidate.activeSessionId === "string" &&
        candidate.activeSessionId.length > 0)) &&
    Array.isArray(candidate.archivedSessions) &&
    candidate.archivedSessions.every(isArchivedSessionSummary) &&
    Array.isArray(candidate.commandResults) &&
    candidate.commandResults.every(isCommandSessionResult)
  );
};

const parseAccountStateFile = (raw: string): AccountStateFile => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenClawClientError("account-state.json is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new OpenClawClientError("account-state.json must contain an object");
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.accounts) ||
    !candidate.accounts.every(isStoredAccountState)
  ) {
    throw new OpenClawClientError("account-state.json does not match v1 schema");
  }

  return {
    version: 1,
    accounts: candidate.accounts.map((account) => ({
      hostId: account.hostId,
      accountId: account.accountId,
      activeSessionId: account.activeSessionId,
      archivedSessions: account.archivedSessions.map((session) => ({ ...session })),
      commandResults: account.commandResults.map((result) => ({ ...result })),
    })),
  };
};

const getStatePaths = (stateDir: string) => {
  const directory = join(stateDir, ACCOUNT_STATE_DIRECTORY);
  const primaryPath = join(directory, ACCOUNT_STATE_FILENAME);
  return {
    directory,
    primaryPath,
    backupPath: `${primaryPath}.bak`,
  };
};

const syncDirectory = async (path: string): Promise<void> => {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close();
  }
};

const writeAtomicFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let fileHandle;
  try {
    fileHandle = await open(temporaryPath, "w");
    await fileHandle.writeFile(content, "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle?.close();
  }

  await rename(temporaryPath, path);
  await syncDirectory(dirname(path));
};

const readStateCandidate = async (
  path: string,
): Promise<AccountStateCandidate | null> => {
  try {
    const [raw, snapshotStats] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    return {
      state: parseAccountStateFile(raw),
      mtimeMs: snapshotStats.mtimeMs,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

export const loadAccountStateFile = async (
  stateDir: string,
): Promise<AccountStateFile> => {
  const { primaryPath, backupPath } = getStatePaths(stateDir);
  let primaryCandidate: AccountStateCandidate | null = null;
  let backupCandidate: AccountStateCandidate | null = null;
  let primaryError: unknown = null;
  let backupError: unknown = null;

  try {
    primaryCandidate = await readStateCandidate(primaryPath);
  } catch (error) {
    primaryError = error;
  }

  try {
    backupCandidate = await readStateCandidate(backupPath);
  } catch (error) {
    backupError = error;
  }

  if (primaryCandidate && backupCandidate) {
    return primaryCandidate.mtimeMs >= backupCandidate.mtimeMs
      ? primaryCandidate.state
      : backupCandidate.state;
  }

  if (backupCandidate) {
    return backupCandidate.state;
  }

  if (primaryCandidate) {
    return primaryCandidate.state;
  }

  if (primaryError || backupError) {
    throw (
      primaryError ??
      backupError ??
      new OpenClawClientError("unable to load account-state.json")
    );
  }

  return {
    version: 1,
    accounts: [],
  };
};

export const readStoredAccountState = async (input: {
  stateDir: string;
  hostId: string;
  accountId: string;
}): Promise<StoredAccountState | null> => {
  const store = await loadAccountStateFile(input.stateDir);
  const account = store.accounts.find(
    (candidate) =>
      candidate.hostId === input.hostId && candidate.accountId === input.accountId,
  );

  if (!account) {
    return null;
  }

  return {
    hostId: account.hostId,
    accountId: account.accountId,
    activeSessionId: account.activeSessionId,
    archivedSessions: account.archivedSessions.map((session) => ({ ...session })),
    commandResults: account.commandResults.map((result) => ({ ...result })),
  };
};

export const writeStoredAccountState = async (input: {
  stateDir: string;
  state: StoredAccountState;
}): Promise<void> => {
  const { directory, primaryPath, backupPath } = getStatePaths(input.stateDir);
  const store = await loadAccountStateFile(input.stateDir);
  const accounts = store.accounts.filter(
    (candidate) =>
      !(
        candidate.hostId === input.state.hostId &&
        candidate.accountId === input.state.accountId
      ),
  );

  accounts.push({
    hostId: input.state.hostId,
    accountId: input.state.accountId,
    activeSessionId: input.state.activeSessionId,
    archivedSessions: input.state.archivedSessions.map((session) => ({ ...session })),
    commandResults: input.state.commandResults.map((result) => ({ ...result })),
  });

  const nextState: AccountStateFile = {
    version: 1,
    accounts,
  };
  const serialized = `${JSON.stringify(nextState, null, 2)}\n`;

  await mkdir(directory, { recursive: true });
  await writeAtomicFile(backupPath, serialized);
  await writeAtomicFile(primaryPath, serialized);
  await syncDirectory(directory);
};

export const pruneExpiredCommandResults = (
  state: StoredAccountState,
  now: number,
  retentionMs: number,
): StoredAccountState => ({
  ...state,
  archivedSessions: state.archivedSessions.map((session) => ({ ...session })),
  commandResults: state.commandResults
    .filter((result) => now - result.createdAt <= retentionMs)
    .map((result) => ({ ...result })),
});

export const emptyStoredAccountState = (
  hostId: string,
  accountId: string,
): StoredAccountState => ({
  hostId,
  accountId,
  activeSessionId: null,
  archivedSessions: [],
  commandResults: [],
});
