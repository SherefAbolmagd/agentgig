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
});

/**
 * POST /api/tasks/run — Cloud Tasks worker. Runs one queued job through the
 * gateway. A 5xx makes Cloud Tasks retry; business outcomes return 200.
 */
export const POST = handle(async (req) => {
  await verifyInternalCall(req);
  return runJob(await readJson(req, Job));
});
