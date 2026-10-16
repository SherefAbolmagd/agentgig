import { getMember } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { addFact, FactInput } from "@/lib/memory";
import { requireRole } from "@/lib/org";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/memory — { shelf, fact, expiresOn? } adds a fact by hand. */
export const POST = handle(async (req) => {
  const member = await getMember(req);
  requireRole(member, "manager", "add to company memory");
  await consume("uploadsPerUser", member.accountId);
  await addFact(member.accountId, { uid: member.uid, name: member.name ?? member.email ?? "Teammate" }, await readJson(req, FactInput));
  return { ok: true };
});
