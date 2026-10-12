import { releaseStuckTasks } from "@/lib/accounts";
import { handle } from "@/lib/http";
import { verifyInternalCall } from "@/lib/internal-auth";
import { queueDriveInvoices, queueDueSchedules } from "@/lib/triggers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/triggers/cron — Cloud Scheduler, every 5 minutes. Queues every
 * scheduled agent that's due, new invoices in watched Drive folders, and
 * returns tokens held by stuck tasks.
 */
export const POST = handle(async (req) => {
  await verifyInternalCall(req);
  const [schedules, stuck, drive] = await Promise.all([queueDueSchedules(), releaseStuckTasks(), queueDriveInvoices()]);
  return { ...schedules, stuck, drive };
});
