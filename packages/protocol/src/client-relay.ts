import { z } from "zod";

import {
  AccountIdSchema,
  AgentIdSchema,
  ArchivedSessionSummarySchema,
  HostIdSchema,
  MessagePayloadSchema,
  RequestIdSchema,
  SessionIdSchema,
  SessionNewCommandSchema,
} from "./domain";
import { ProtocolErrorCodeSchema } from "./errors";
import { StreamEventSchema } from "./relay-edge";

export const BotCreateRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    hostId: HostIdSchema,
    accountId: AccountIdSchema,
    agentId: AgentIdSchema,
  })
  .strict();
export type BotCreateRequest = z.infer<typeof BotCreateRequestSchema>;

export { SessionNewCommandSchema };
export type SessionNewCommand = z.infer<typeof SessionNewCommandSchema>;

export const MessageSendRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    hostId: HostIdSchema,
    accountId: AccountIdSchema,
    targetSessionId: SessionIdSchema,
    payload: MessagePayloadSchema,
  })
  .strict();
export type MessageSendRequest = z.infer<typeof MessageSendRequestSchema>;

export const MessageSendResultSuccessSchema = z
  .object({
    ok: z.literal(true),
    activeSessionId: SessionIdSchema,
    resultingSessionId: SessionIdSchema.optional(),
    forwarded: z.boolean(),
    archivedSessions: z.array(ArchivedSessionSummarySchema),
  })
  .strict();

export const MessageSendResultFailureSchema = z
  .object({
    ok: z.literal(false),
    code: ProtocolErrorCodeSchema,
    activeSessionId: SessionIdSchema.nullable(),
    archivedSessions: z.array(ArchivedSessionSummarySchema),
  })
  .strict();

export const MessageSendResultSchema = z.discriminatedUnion("ok", [
  MessageSendResultSuccessSchema,
  MessageSendResultFailureSchema,
]);
export type MessageSendResult = z.infer<typeof MessageSendResultSchema>;

export { StreamEventSchema };
export type StreamEvent = z.infer<typeof StreamEventSchema>;
