import type {
  CreateOpenChatBotInput,
  OpenChatBot,
} from "../../../packages/openclaw-client/src/index";

export type EdgeOpenClawAdapter = {
  confirmAccountCreated(input: CreateOpenChatBotInput): Promise<boolean>;
  listOpenChatBots(): Promise<OpenChatBot[]>;
  createOpenChatBot(input: CreateOpenChatBotInput): Promise<OpenChatBot>;
};

export type BotService = {
  listBots(): Promise<OpenChatBot[]>;
  createBot(input: CreateOpenChatBotInput): Promise<OpenChatBot>;
};

const withMutex = async <T>(
  locks: Map<string, Promise<void>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> => {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry = previous.then(() => current);
  locks.set(key, entry);

  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === entry) {
      locks.delete(key);
    }
  }
};

export const createBotService = (
  openClaw: EdgeOpenClawAdapter,
): BotService => {
  const mutationLocks = new Map<string, Promise<void>>();

  return {
    async listBots(): Promise<OpenChatBot[]> {
      return openClaw.listOpenChatBots();
    },

    async createBot(input: CreateOpenChatBotInput): Promise<OpenChatBot> {
      return withMutex(mutationLocks, input.accountId, async () => {
        const confirmed = await openClaw.confirmAccountCreated(input);
        if (!confirmed) {
          throw new Error("OpenClaw did not confirm account creation");
        }
        return openClaw.createOpenChatBot(input);
      });
    },
  };
};
