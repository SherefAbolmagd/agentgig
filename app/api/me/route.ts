import { getCaller } from "@/lib/auth";
import { handle } from "@/lib/http";
import { ensureUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/me — creates the account on first sign-in (demo sandbox for anonymous users). Safe to call every time. */
export const POST = handle(async (req) => {
  const caller = await getCaller(req);
  const { created } = await ensureUser(caller);
  return { uid: caller.uid, created };
});
