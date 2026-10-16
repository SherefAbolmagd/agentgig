import { FieldValue } from "firebase-admin/firestore";
import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { db } from "@/lib/firebase-admin";
import { handle, readJson } from "@/lib/http";
import { BusinessProfileSchema } from "@/lib/profile";
import { COLLECTIONS } from "@/types/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/profile — saves the business profile every agent can be given. */
export const PUT = handle(async (req) => {
  const member = await getMember(req);
  requireRole(member, "manager", "edit the business profile");
  const uid = member.accountId;
  const { businessName, ...profile } = await readJson(req, BusinessProfileSchema);
  await db()
    .collection(COLLECTIONS.users)
    .doc(uid)
    .update({ businessName, businessProfile: profile, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
