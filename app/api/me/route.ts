import { deleteAccount } from "@/lib/accounts";
import { getCaller } from "@/lib/auth";
import { db } from "@/lib/firebase-admin";
import { handle } from "@/lib/http";
import { leaveTeam, membershipOf } from "@/lib/org";
import { clientIp, consume } from "@/lib/rate-limit";
import { ensureUser } from "@/lib/users";
import { COLLECTIONS } from "@/types/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/me — creates the account on first sign-in (demo sandbox for
 * anonymous users) and says which organization account the person works in.
 * Safe to call every time.
 */
export const POST = handle(async (req) => {
  const caller = await getCaller(req);
  if (caller.isAnonymous && !(await db().collection(COLLECTIONS.users).doc(caller.uid).get()).exists) {
    await consume("sandboxPerIp", clientIp(req));
    await consume("sandboxGlobal", "all");
  }
  const { created } = await ensureUser(caller);
  const { accountId, role } = await membershipOf(caller.uid);
  return { uid: caller.uid, accountId, role, created };
});

/**
 * DELETE /api/me — permanently deletes the caller's own account and data. A
 * teammate leaves the team first; an owner's teammates go back to their own
 * accounts.
 */
export const DELETE = handle(async (req) => {
  const caller = await getCaller(req);
  const { role } = await membershipOf(caller.uid);
  if (role !== "owner") await leaveTeam(caller.uid);
  return deleteAccount(caller.uid);
});
