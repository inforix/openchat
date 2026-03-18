import { z } from "zod";

import {
  AccountIdSchema,
  ActiveSessionSchema,
  ArchivedSessionSummarySchema,
  BotAccountSchema,
  CursorSchema,
  DeviceIdSchema,
  EventIdSchema,
  HostIdSchema,
  RequestIdSchema,
  SessionIdSchema,
} from "./domain";
import { ProtocolErrorCodeSchema } from "./errors";

export const StreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("chunk"),
      delta: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: ProtocolErrorCodeSchema,
      message: z.string().min(1),
    })
    .strict(),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const EdgeEventTypeSchema = z.enum([
  "edge.hello",
  "edge.registerHost",
  "edge.stream.event",
  "edge.cursor.commit",
  "edge.bot.create.result",
  "edge.bot.list.result",
  "edge.session.snapshot",
  "edge.session.snapshot.result",
]);
export type EdgeEventType = z.infer<typeof EdgeEventTypeSchema>;

export const RelayVisibleMetadataSchema = z
  .object({
    requestId: RequestIdSchema,
    eventId: EventIdSchema,
    hostId: HostIdSchema,
    deviceId: DeviceIdSchema,
    cursor: CursorSchema,
    eventType: EdgeEventTypeSchema,
  })
  .strict();
export type RelayVisibleMetadata = z.infer<typeof RelayVisibleMetadataSchema>;

export const EdgeHelloEventSchema = RelayVisibleMetadataSchema.extend({
  eventType: z.literal("edge.hello"),
  protocolVersion: z.string().min(1),
}).strict();
export type EdgeHelloEvent = z.infer<typeof EdgeHelloEventSchema>;

export const EdgeRegisterHostEventSchema = RelayVisibleMetadataSchema.extend({
  eventType: z.literal("edge.registerHost"),
  registeredHostId: HostIdSchema,
}).strict();
export type EdgeRegisterHostEvent = z.infer<typeof EdgeRegisterHostEventSchema>;

export const EdgeStreamEventSchema = RelayVisibleMetadataSchema.extend({
  eventType: z.literal("edge.stream.event"),
  streamEvent: StreamEventSchema,
}).strict();
export type EdgeStreamEvent = z.infer<typeof EdgeStreamEventSchema>;

export const EdgeCursorCommitEventSchema = RelayVisibleMetadataSchema.extend({
  eventType: z.literal("edge.cursor.commit"),
  committedCursor: CursorSchema,
}).strict();
export type EdgeCursorCommitEvent = z.infer<typeof EdgeCursorCommitEventSchema>;

export const EdgeBotCreateResultSuccessEventSchema =
  RelayVisibleMetadataSchema.extend({
    eventType: z.literal("edge.bot.create.result"),
    accountId: AccountIdSchema,
    ok: z.literal(true),
  }).strict();
export type EdgeBotCreateResultSuccessEvent = z.infer<
  typeof EdgeBotCreateResultSuccessEventSchema
>;

export const EdgeBotCreateResultFailureEventSchema =
  RelayVisibleMetadataSchema.extend({
    eventType: z.literal("edge.bot.create.result"),
    accountId: AccountIdSchema,
    ok: z.literal(false),
    errorCode: ProtocolErrorCodeSchema,
  }).strict();
export type EdgeBotCreateResultFailureEvent = z.infer<
  typeof EdgeBotCreateResultFailureEventSchema
>;

export const EdgeBotCreateResultEventSchema = z.discriminatedUnion("ok", [
  EdgeBotCreateResultSuccessEventSchema,
  EdgeBotCreateResultFailureEventSchema,
]);
export type EdgeBotCreateResultEvent = z.infer<
  typeof EdgeBotCreateResultEventSchema
>;

export const EdgeBotListResultEventSchema = RelayVisibleMetadataSchema.extend({
  eventType: z.literal("edge.bot.list.result"),
}).strict();
export type EdgeBotListResultEvent = z.infer<
  typeof EdgeBotListResultEventSchema
>;

export const EdgeSessionSnapshotResultEventSchema =
  RelayVisibleMetadataSchema.extend({
    eventType: z.literal("edge.session.snapshot.result"),
  }).strict();
export type EdgeSessionSnapshotResultEvent = z.infer<
  typeof EdgeSessionSnapshotResultEventSchema
>;

export const EdgeSessionSnapshotEventSchema = RelayVisibleMetadataSchema.extend({
  eventType: z.literal("edge.session.snapshot"),
  accountId: AccountIdSchema,
  activeSession: ActiveSessionSchema,
  archivedSessions: z.array(ArchivedSessionSummarySchema),
})
  .strict()
  .superRefine((value, ctx) => {
    if (value.activeSession.hostId !== value.hostId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeSession", "hostId"],
        message: "activeSession.hostId must match the envelope hostId",
      });
    }

    if (value.activeSession.accountId !== value.accountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeSession", "accountId"],
        message: "activeSession.accountId must match the envelope accountId",
      });
    }
  });
export type EdgeSessionSnapshotEvent = z.infer<
  typeof EdgeSessionSnapshotEventSchema
>;

export const BotListResultPayloadSchema = z
  .object({
    type: z.literal("bot.list.result"),
    bots: z.array(BotAccountSchema),
  })
  .strict();
export type BotListResultPayload = z.infer<typeof BotListResultPayloadSchema>;

export const SessionSnapshotResultPayloadSchema = z
  .object({
    type: z.literal("session.snapshot.result"),
    accountId: AccountIdSchema,
    activeSessionId: SessionIdSchema.nullable(),
    archivedSessions: z.array(ArchivedSessionSummarySchema),
  })
  .strict();
export type SessionSnapshotResultPayload = z.infer<
  typeof SessionSnapshotResultPayloadSchema
>;

export const RelayEventEnvelopeSchema = z.union([
  EdgeHelloEventSchema,
  EdgeRegisterHostEventSchema,
  EdgeStreamEventSchema,
  EdgeCursorCommitEventSchema,
  EdgeBotCreateResultSuccessEventSchema,
  EdgeBotCreateResultFailureEventSchema,
  EdgeBotListResultEventSchema,
  EdgeSessionSnapshotEventSchema,
  EdgeSessionSnapshotResultEventSchema,
]);
export type RelayEventEnvelope = z.infer<typeof RelayEventEnvelopeSchema>;
