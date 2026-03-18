import { z } from "zod";

export const ProtocolErrorCodeSchema = z.enum([
  "session_conflict",
  "session_busy",
  "bot_create_failed",
  "offline_read_only",
]);

export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
