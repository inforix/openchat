import { describe, expect, it } from "vitest";
import {
  BotAccountInputSchema,
  EdgeBotCreateResultEventSchema,
  EdgeCursorCommitEventSchema,
  EdgeHelloEventSchema,
  EdgeRegisterHostEventSchema,
  EdgeSessionSnapshotEventSchema,
  EdgeStreamEventSchema,
  MessageSendRequestSchema,
  ProtocolErrorCodeSchema,
  RelayEventEnvelopeSchema,
  RelayVisibleMetadataSchema,
  SessionNewCommandSchema,
  StreamEventSchema,
  BotAccountSchema,
  buildBotAccount,
  deriveBotId,
  MessageEnvelopeSchema,
} from "../index";

describe("openchat protocol domain model", () => {
  it("derives botId collision-safely from encoded identity segments", () => {
    const left = deriveBotId({ hostId: "host:a", accountId: "b" });
    const right = deriveBotId({ hostId: "host", accountId: "a:b" });

    expect(left).not.toBe(right);
    expect(deriveBotId({ hostId: "host:a", accountId: "b" })).toBe(left);
  });

  it("models bot resource as an openchat channel account", () => {
    const input = BotAccountInputSchema.parse({
      hostId: "host-1",
      accountId: "acct-1",
      agentId: "agent-1",
      activeSessionId: "sess-1",
    });
    const bot = BotAccountSchema.parse(buildBotAccount(input));

    expect(bot.channelType).toBe("openchat");
    expect(bot.botId).toBe(deriveBotId({ hostId: "host-1", accountId: "acct-1" }));
  });

  it("uses canonical bot identity {hostId, accountId}", () => {
    expect(deriveBotId({ hostId: "h1", accountId: "a1" })).toBe("h1:a1");
  });

  it("derives botId only from {hostId, accountId}", () => {
    expect(() =>
      BotAccountSchema.parse({
        hostId: "host-1",
        accountId: "acct-1",
        agentId: "agent-1",
        activeSessionId: "sess-1",
        channelType: "openchat",
        botId: "manually-overridden-id",
      }),
    ).toThrow();
  });

  it("requires BotAccountSchema to validate the full public shape", () => {
    expect(() =>
      BotAccountSchema.parse({
        hostId: "host-1",
        accountId: "acct-1",
        agentId: "agent-1",
        activeSessionId: "sess-1",
      }),
    ).toThrow();
  });

  it("requires exactly one activeSessionId per bot", () => {
    expect(() =>
      BotAccountInputSchema.parse({
        hostId: "host-1",
        accountId: "acct-1",
        agentId: "agent-1",
      }),
    ).toThrow();
  });
});

describe("client-relay request protocol", () => {
  it("exports session.new schema from package root", () => {
    const command = SessionNewCommandSchema.parse({
      type: "session.new",
      expectedActiveSessionId: null,
      commandId: "cmd-root-1",
    });

    expect(command.commandId).toBe("cmd-root-1");
  });

  it("represents /new as a system command, not a normal user message", () => {
    expect(() =>
      MessageEnvelopeSchema.parse({
        payload: {
          kind: "userMessage",
          text: "/new",
        },
      }),
    ).toThrow();

    const command = SessionNewCommandSchema.parse({
      type: "session.new",
      expectedActiveSessionId: "sess-1",
      commandId: "cmd-1",
    });

    expect(command.type).toBe("session.new");
  });

  it("requires targetSessionId when sending a message", () => {
    expect(() =>
      MessageSendRequestSchema.parse({
        hostId: "host-1",
        accountId: "acct-1",
        requestId: "req-1",
        payload: {
          kind: "userMessage",
          text: "hello",
        },
      }),
    ).toThrow();
  });

  it("supports sending session.new as a system command with target session", () => {
    const request = MessageSendRequestSchema.parse({
      requestId: "req-system-1",
      hostId: "host-1",
      accountId: "acct-1",
      targetSessionId: "sess-1",
      payload: {
        kind: "systemCommand",
        command: {
          type: "session.new",
          expectedActiveSessionId: "sess-1",
          commandId: "cmd-2",
        },
      },
    });

    expect(request.payload.kind).toBe("systemCommand");
    if (request.payload.kind !== "systemCommand") {
      throw new Error("expected systemCommand payload");
    }
    expect(request.payload.command.type).toBe("session.new");
  });
});

describe("relay-edge event protocol", () => {
  it("exports all requested edge event schemas", () => {
    expect(
      EdgeHelloEventSchema.parse({
        requestId: "req-1",
        eventId: "evt-1",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-1",
        eventType: "edge.hello",
        protocolVersion: "1",
      }).eventType,
    ).toBe("edge.hello");

    expect(
      EdgeRegisterHostEventSchema.parse({
        requestId: "req-2",
        eventId: "evt-2",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-2",
        eventType: "edge.registerHost",
        registeredHostId: "host-1",
      }).eventType,
    ).toBe("edge.registerHost");

    expect(
      EdgeStreamEventSchema.parse({
        requestId: "req-3",
        eventId: "evt-3",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-3",
        eventType: "edge.stream.event",
        streamEvent: { type: "done" },
      }).eventType,
    ).toBe("edge.stream.event");

    expect(
      EdgeCursorCommitEventSchema.parse({
        requestId: "req-4",
        eventId: "evt-4",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-4",
        eventType: "edge.cursor.commit",
        committedCursor: "cur-4",
      }).eventType,
    ).toBe("edge.cursor.commit");

    expect(
      EdgeBotCreateResultEventSchema.parse({
        requestId: "req-5",
        eventId: "evt-5",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-5",
        eventType: "edge.bot.create.result",
        accountId: "acct-1",
        ok: true,
      }).eventType,
    ).toBe("edge.bot.create.result");

    expect(
      EdgeBotCreateResultEventSchema.parse({
        requestId: "req-5b",
        eventId: "evt-5b",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-5b",
        eventType: "edge.bot.create.result",
        accountId: "acct-1",
        ok: false,
        errorCode: "bot_create_failed",
      }).ok,
    ).toBe(false);

    expect(
      EdgeSessionSnapshotEventSchema.parse({
        requestId: "req-6",
        eventId: "evt-6",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-6",
        eventType: "edge.session.snapshot",
        accountId: "acct-1",
        activeSession: {
          hostId: "host-1",
          accountId: "acct-1",
          sessionId: "sess-1",
        },
        archivedSessions: [],
      }).eventType,
    ).toBe("edge.session.snapshot");
  });

  it("requires relay envelope routing headers", () => {
    const event = RelayEventEnvelopeSchema.parse({
      requestId: "req-1",
      eventId: "evt-1",
      hostId: "host-1",
      deviceId: "dev-1",
      cursor: "cur-1",
      eventType: "edge.stream.event",
      streamEvent: {
        type: "done",
      },
    });

    expect(event.eventType).toBe("edge.stream.event");
  });

  it("fails when mandatory relay envelope headers are missing", () => {
    const base = {
      requestId: "req-1",
      eventId: "evt-1",
      hostId: "host-1",
      deviceId: "dev-1",
      cursor: "cur-1",
      eventType: "edge.stream.event",
      streamEvent: {
        type: "done",
      },
    } as const;

    const missingCases: Array<keyof typeof base> = [
      "requestId",
      "eventId",
      "hostId",
      "deviceId",
      "cursor",
      "eventType",
    ];

    for (const key of missingCases) {
      const candidate = { ...base };
      delete candidate[key];
      expect(() => RelayEventEnvelopeSchema.parse(candidate)).toThrow();
    }
  });

  it("defines protocol error codes", () => {
    const allowed = [
      "session_conflict",
      "session_busy",
      "bot_create_failed",
      "offline_read_only",
    ];
    for (const code of allowed) {
      expect(ProtocolErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it("rejects illegal edge.bot.create.result states", () => {
    expect(() =>
      EdgeBotCreateResultEventSchema.parse({
        requestId: "req-illegal-1",
        eventId: "evt-illegal-1",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-illegal-1",
        eventType: "edge.bot.create.result",
        accountId: "acct-1",
        ok: true,
        errorCode: "bot_create_failed",
      }),
    ).toThrow();

    expect(() =>
      EdgeBotCreateResultEventSchema.parse({
        requestId: "req-illegal-2",
        eventId: "evt-illegal-2",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-illegal-2",
        eventType: "edge.bot.create.result",
        accountId: "acct-1",
        ok: false,
      }),
    ).toThrow();
  });

  it("rejects session snapshots whose active session identity disagrees with the envelope", () => {
    expect(() =>
      EdgeSessionSnapshotEventSchema.parse({
        requestId: "req-snapshot-1",
        eventId: "evt-snapshot-1",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-snapshot-1",
        eventType: "edge.session.snapshot",
        accountId: "acct-1",
        activeSession: {
          hostId: "host-2",
          accountId: "acct-1",
          sessionId: "sess-1",
        },
        archivedSessions: [],
      }),
    ).toThrow();

    expect(() =>
      EdgeSessionSnapshotEventSchema.parse({
        requestId: "req-snapshot-2",
        eventId: "evt-snapshot-2",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-snapshot-2",
        eventType: "edge.session.snapshot",
        accountId: "acct-1",
        activeSession: {
          hostId: "host-1",
          accountId: "acct-2",
          sessionId: "sess-1",
        },
        archivedSessions: [],
      }),
    ).toThrow();
  });

  it("defines stream variants chunk | done | error", () => {
    expect(StreamEventSchema.parse({ type: "chunk", delta: "abc" }).type).toBe(
      "chunk",
    );
    expect(StreamEventSchema.parse({ type: "done" }).type).toBe("done");
    expect(
      StreamEventSchema.parse({
        type: "error",
        code: "session_busy",
        message: "busy",
      }).type,
    ).toBe("error");
  });

  it("keeps relay-visible metadata free of message body, agentId, and transcript", () => {
    expect(() =>
      RelayVisibleMetadataSchema.parse({
        requestId: "req-1",
        eventId: "evt-1",
        hostId: "host-1",
        deviceId: "dev-1",
        cursor: "cur-1",
        eventType: "edge.stream.event",
        body: "should-not-exist",
        agentId: "agent-1",
        transcript: ["x"],
      }),
    ).toThrow();
  });
});
