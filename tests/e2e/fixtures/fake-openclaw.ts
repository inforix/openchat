export type ScenarioMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

export type ScenarioArchivedSession = {
  sessionId: string;
  archivedAt: string;
  summary?: string;
  messages: ScenarioMessage[];
};

export type ScenarioBot = {
  accountId: string;
  agentId: string;
  title: string;
  activeSessionId: string;
  activeMessages: ScenarioMessage[];
  archivedSessions: ScenarioArchivedSession[];
};

export type ScenarioHost = {
  hostId: string;
  name: string;
  edgeKeyFingerprint: string;
  status: "online" | "offline";
  bots: ScenarioBot[];
};

export type OpenChatE2EScenario = {
  hosts: ScenarioHost[];
};

export function createScenario(hosts: ScenarioHost[]): OpenChatE2EScenario {
  return { hosts };
}

export function createHostScenario(input: {
  hostId: string;
  name: string;
  edgeKeyFingerprint: string;
  status?: ScenarioHost["status"];
  bots?: ScenarioBot[];
}): ScenarioHost {
  return {
    hostId: input.hostId,
    name: input.name,
    edgeKeyFingerprint: input.edgeKeyFingerprint,
    status: input.status ?? "online",
    bots: input.bots ?? [],
  };
}

export function createBotScenario(input: {
  accountId: string;
  agentId: string;
  title: string;
  activeSessionId?: string;
  activeMessages?: ScenarioMessage[];
  archivedSessions?: ScenarioArchivedSession[];
}): ScenarioBot {
  const activeSessionId = input.activeSessionId ?? `${input.accountId}-active`;

  return {
    accountId: input.accountId,
    agentId: input.agentId,
    title: input.title,
    activeSessionId,
    activeMessages:
      input.activeMessages ??
      [createAssistantMessage(`${activeSessionId}-message-1`, `Ready on ${input.accountId}.`)],
    archivedSessions: input.archivedSessions ?? [],
  };
}

export function createArchivedSession(input: {
  sessionId: string;
  messages: ScenarioMessage[];
  archivedAt?: string;
  summary?: string;
}): ScenarioArchivedSession {
  return {
    sessionId: input.sessionId,
    archivedAt: input.archivedAt ?? "2026-03-18T12:00:00.000Z",
    summary: input.summary,
    messages: input.messages,
  };
}

export function createAssistantMessage(id: string, text: string): ScenarioMessage {
  return {
    id,
    role: "assistant",
    text,
  };
}
