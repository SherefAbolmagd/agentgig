import { FieldValue } from "firebase-admin/firestore";
import { getCallerId } from "@/lib/auth";
import { db } from "@/lib/firebase-admin";
import { handle, readJson } from "@/lib/http";
import { BusinessProfileSchema } from "@/lib/profile";
import { COLLECTIONS } from "@/types/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/profile — saves the business profile every agent can be given. */
export const PUT = handle(async (req) => {
  const uid = await getCallerId(req);
  const { businessName, ...profile } = await readJson(req, BusinessProfileSchema);
  await db()
    .collection(COLLECTIONS.users)
    .doc(uid)
    .update({ businessName, businessProfile: profile, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
