import { z } from "zod";
import { getMember } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { removeMember, requireRole, setMemberRole } from "@/lib/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uid: string }> };

/** PATCH /api/team/members/{uid} — { role } */
export const PATCH = handle<Ctx>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "owner", "change roles");
  const { role } = await readJson(req, z.object({ role: z.enum(["manager", "member"]) }));
  await setMemberRole(member.accountId, (await params).uid, role);
  return { ok: true };
});

/** DELETE /api/team/members/{uid} — removes someone; they go back to their own account. */
export const DELETE = handle<Ctx>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "owner", "remove people from the team");
  await removeMember(member.accountId, (await params).uid);
  return { ok: true };
});
