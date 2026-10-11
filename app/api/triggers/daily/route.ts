import { cleanupSandboxes } from "@/lib/accounts";
import { handle } from "@/lib/http";
import { verifyInternalCall } from "@/lib/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST /api/triggers/daily — Cloud Scheduler, once a day. Deletes demo sandboxes older than a week. */
export const POST = handle(async (req) => {
  await verifyInternalCall(req);
  return cleanupSandboxes();
});
