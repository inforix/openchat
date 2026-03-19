import { z } from "zod";

export const HostIdSchema = z.string().min(1);
export const AccountIdSchema = z.string().min(1);
export const DeviceIdSchema = z.string().min(1);
export const SessionIdSchema = z.string().min(1);
export const AgentIdSchema = z.string().min(1);
export const RequestIdSchema = z.string().min(1);
export const EventIdSchema = z.string().min(1);
export const CursorSchema = z.string().min(1);
export const CommandIdSchema = z.string().min(1);

export const ChannelTypeSchema = z.literal("openchat");

export const HostSchema = z
  .object({
    hostId: HostIdSchema,
    deviceId: DeviceIdSchema,
  })
  .strict();
export type Host = z.infer<typeof HostSchema>;

export const BotIdentitySchema = z
  .object({
    hostId: HostIdSchema,
    accountId: AccountIdSchema,
  })
  .strict();
export type BotIdentity = z.infer<typeof BotIdentitySchema>;

export const deriveBotId = (identity: BotIdentity): string =>
  `${encodeURIComponent(identity.hostId)}:${encodeURIComponent(
    identity.accountId,
  )}`;

export const ActiveSessionSchema = z
  .object({
    hostId: HostIdSchema,
    accountId: AccountIdSchema,
    sessionId: SessionIdSchema,
  })
  .strict();
export type ActiveSession = z.infer<typeof ActiveSessionSchema>;

export const ArchivedSessionSummarySchema = z
  .object({
    sessionId: SessionIdSchema,
    archivedAt: z.string().datetime(),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type ArchivedSessionSummary = z.infer<typeof ArchivedSessionSummarySchema>;

export const BotAccountInputSchema = z
  .object({
    hostId: HostIdSchema,
    accountId: AccountIdSchema,
    agentId: AgentIdSchema,
    activeSessionId: SessionIdSchema,
  })
  .strict();
export type BotAccountInput = z.infer<typeof BotAccountInputSchema>;

export const buildBotAccount = (input: BotAccountInput) => ({
  ...input,
  channelType: "openchat" as const,
  botId: deriveBotId({
    hostId: input.hostId,
    accountId: input.accountId,
  }),
});

export const BotAccountSchema = BotAccountInputSchema.extend({
  channelType: ChannelTypeSchema,
  botId: z.string().min(1),
})
  .strict()
  .superRefine((value, ctx) => {
    const expected = deriveBotId({
      hostId: value.hostId,
      accountId: value.accountId,
    });
    if (value.botId !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["botId"],
        message: "botId must be derived from {hostId, accountId}",
      });
    }
  });
export type BotAccount = z.infer<typeof BotAccountSchema>;

export const SessionNewCommandSchema = z
  .object({
    type: z.literal("session.new"),
    expectedActiveSessionId: SessionIdSchema.nullable(),
    commandId: CommandIdSchema,
  })
  .strict();
export type SessionNewCommand = z.infer<typeof SessionNewCommandSchema>;

export const UserMessageSchema = z
  .object({
    kind: z.literal("userMessage"),
    text: z
      .string()
      .min(1)
      .refine((value) => value.trim() !== "/new", {
        message: "`/new` must be encoded as a systemCommand",
      }),
  })
  .strict();

export const SystemCommandMessageSchema = z
  .object({
    kind: z.literal("systemCommand"),
    command: SessionNewCommandSchema,
  })
  .strict();

export const MessagePayloadSchema = z.discriminatedUnion("kind", [
  UserMessageSchema,
  SystemCommandMessageSchema,
]);
export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

export const MessageEnvelopeSchema = z
  .object({
    payload: MessagePayloadSchema,
  })
  .strict();
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;
