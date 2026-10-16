import { getCaller } from "@/lib/auth";
import { handle } from "@/lib/http";
import { leaveTeam } from "@/lib/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/team/leave — back to your own account. */
export const POST = handle(async (req) => {
  await leaveTeam((await getCaller(req)).uid);
  return { ok: true };
});
