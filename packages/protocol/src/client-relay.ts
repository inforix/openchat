import { z } from "zod";

import {
  AccountIdSchema,
  AgentIdSchema,
  HostIdSchema,
  MessagePayloadSchema,
  RequestIdSchema,
  SessionIdSchema,
  SessionNewCommandSchema,
} from "./domain";
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

export { StreamEventSchema };
export type StreamEvent = z.infer<typeof StreamEventSchema>;
