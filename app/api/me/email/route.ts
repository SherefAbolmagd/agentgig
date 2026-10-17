import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { getMember } from "@/lib/auth";
import { db } from "@/lib/firebase-admin";
import { handle, readJson } from "@/lib/http";
import { requireRole } from "@/lib/org";
import { COLLECTIONS } from "@/types/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ emailOnApprove: z.enum(["draft", "send"]) });

/** PUT /api/me/email — { emailOnApprove } What approving an agent's email does: save a draft, or send it from Gmail. */
export const PUT = handle(async (req) => {
  const member = await getMember(req);
  requireRole(member, "owner", "change how approved emails are delivered");
  const { emailOnApprove } = await readJson(req, Body);
  await db().collection(COLLECTIONS.users).doc(member.accountId).update({ emailOnApprove, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
