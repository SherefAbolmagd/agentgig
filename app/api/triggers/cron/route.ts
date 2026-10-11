import { handle } from "@/lib/http";
import { verifyInternalCall } from "@/lib/internal-auth";
import { queueDueSchedules } from "@/lib/triggers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/triggers/cron — Cloud Scheduler, every 5 minutes. Queues every scheduled agent that's due. */
export const POST = handle(async (req) => {
  await verifyInternalCall(req);
  return queueDueSchedules();
});
