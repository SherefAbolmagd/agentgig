import { z } from "zod";
import { handle, readJson } from "@/lib/http";
import { verifyInternalCall } from "@/lib/internal-auth";
import { runJob } from "@/lib/triggers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Job = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  origin: z.enum(["schedule", "event"]),
  gcsFile: z.object({ bucket: z.string(), name: z.string(), contentType: z.string() }).optional(),
  driveFile: z.object({ id: z.string(), name: z.string(), mimeType: z.string() }).optional(),
  publishTaskId: z.string().optional(),
  rememberTaskId: z.string().optional(),
  syncMemory: z.literal(true).optional(),
  telegram: z
    .object({
      updateId: z.number().int(),
      telegramUserId: z.number().int(),
      chatId: z.number().int(),
      kind: z.enum(["message", "callback"]),
      text: z.string().max(5000).optional(),
      voiceFileId: z.string().max(300).optional(),
      callbackId: z.string().max(100).optional(),
      callbackData: z.string().max(64).optional(),
      messageId: z.number().int().optional(),
    })
    .optional(),
});

/**
 * POST /api/tasks/run — Cloud Tasks worker. Runs one queued job through the
 * gateway. A 5xx makes Cloud Tasks retry; business outcomes return 200.
 */
export const POST = handle(async (req) => {
  await verifyInternalCall(req);
  return runJob(await readJson(req, Job));
});
