import { releaseStuckTasks } from "@/lib/accounts";
import { handle } from "@/lib/http";
import { verifyInternalCall } from "@/lib/internal-auth";
import { queueDueSchedules } from "@/lib/triggers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/triggers/cron — Cloud Scheduler, every 5 minutes. Queues every
 * scheduled agent that's due and returns tokens held by stuck tasks.
 */
export const POST = handle(async (req) => {
  await verifyInternalCall(req);
  const [schedules, stuck] = await Promise.all([queueDueSchedules(), releaseStuckTasks()]);
  return { ...schedules, stuck };
});
