import { z } from "zod";
import { getCaller } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { acceptInvite } from "@/lib/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/team/join — { token } joins the account behind an invite link. */
export const POST = handle(async (req) => {
  const caller = await getCaller(req);
  const { token } = await readJson(req, z.object({ token: z.string().min(10).max(64) }));
  return acceptInvite(caller, token);
});
