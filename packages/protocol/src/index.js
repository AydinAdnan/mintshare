import { z } from "zod";

export const roleSchema = z.enum(["sender", "receiver"]);

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/u, "Invalid room code format");

export const signalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room:create"),
    payload: z.object({
      role: roleSchema,
    }),
  }),
  z.object({
    type: z.literal("room:join"),
    payload: z.object({
      code: roomCodeSchema,
      role: roleSchema,
    }),
  }),
  z.object({
    type: z.literal("signal:offer"),
    payload: z.object({
      code: roomCodeSchema,
      sdp: z.any(),
    }),
  }),
  z.object({
    type: z.literal("signal:answer"),
    payload: z.object({
      code: roomCodeSchema,
      sdp: z.any(),
    }),
  }),
  z.object({
    type: z.literal("signal:ice-candidate"),
    payload: z.object({
      code: roomCodeSchema,
      candidate: z.any(),
    }),
  }),
]);

export const chunkHeaderSchema = z.object({
  fileId: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  byteOffset: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
  isLastChunk: z.boolean(),
});

export const manifestFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  relativePath: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  lastModified: z.number().int().nonnegative(),
});

export const transferManifestSchema = z.object({
  transferId: z.string(),
  totalBytes: z.number().int().nonnegative(),
  files: z.array(manifestFileSchema).min(1),
});

export const controlMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("transfer:manifest"),
    payload: transferManifestSchema,
  }),
  z.object({
    type: z.literal("transfer:accept"),
    payload: z.object({
      transferId: z.string(),
      selectedFileIds: z.array(z.string()).min(1),
    }),
  }),
  z.object({
    type: z.literal("file:start"),
    payload: manifestFileSchema.extend({
      transferId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("file:end"),
    payload: z.object({
      transferId: z.string(),
      fileId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("transfer:progress"),
    payload: z.object({
      transferId: z.string(),
      fileId: z.string(),
      receivedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      bytesPerSecond: z.number().nonnegative(),
      etaSeconds: z.number().nonnegative().nullable(),
    }),
  }),
  z.object({
    type: z.literal("transfer:complete"),
    payload: z.object({
      transferId: z.string(),
      fileId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("transfer:error"),
    payload: z.object({
      transferId: z.string(),
      message: z.string(),
    }),
  }),
]);

export function parseSignalMessage(data) {
  return signalMessageSchema.parse(data);
}

export function parseControlMessage(data) {
  return controlMessageSchema.parse(data);
}
