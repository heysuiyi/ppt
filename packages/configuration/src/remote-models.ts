import { z } from "zod";

export const remoteModelInfoSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    displayName: z.string().trim().min(1).max(512).optional(),
    supported: z.boolean().optional(),
    unsupportedReason: z.string().min(1).optional(),
  })
  .strict();

export const listRemoteModelsResultSchema = z
  .object({
    models: z.array(remoteModelInfoSchema).max(2_000),
  })
  .strict();

export type RemoteModelInfo = z.infer<typeof remoteModelInfoSchema>;
export type ListRemoteModelsResult = z.infer<typeof listRemoteModelsResultSchema>;
