import { deleteAccount } from "@/lib/accounts";
import { getCaller } from "@/lib/auth";
import { db } from "@/lib/firebase-admin";
import { handle } from "@/lib/http";
import { clientIp, consume } from "@/lib/rate-limit";
import { ensureUser } from "@/lib/users";
import { COLLECTIONS } from "@/types/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/me — creates the account on first sign-in (demo sandbox for anonymous users). Safe to call every time. */
export const POST = handle(async (req) => {
  const caller = await getCaller(req);
  if (caller.isAnonymous && !(await db().collection(COLLECTIONS.users).doc(caller.uid).get()).exists) {
    await consume("sandboxPerIp", clientIp(req));
    await consume("sandboxGlobal", "all");
  }
  const { created } = await ensureUser(caller);
  return { uid: caller.uid, created };
});

/** DELETE /api/me — permanently deletes the caller's account and data. */
export const DELETE = handle(async (req) => {
  const caller = await getCaller(req);
  return deleteAccount(caller.uid);
});
