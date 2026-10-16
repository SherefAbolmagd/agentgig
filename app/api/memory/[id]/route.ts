import { z } from "zod";
import { getMember } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { approveFact, editFact, forgetFact, pinFact } from "@/lib/memory";
import { requireRole } from "@/lib/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Change = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("edit"), fact: z.string().trim().min(8, "Write the fact as a full sentence.").max(300) }),
  z.object({ action: z.literal("pin"), pinned: z.boolean() }),
]);

/** PATCH /api/memory/{id} — approve a pending fact, edit it, or pin it. */
export const PATCH = handle<Ctx>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "manager", "change company memory");
  const id = (await params).id;
  const change = await readJson(req, Change);
  if (change.action === "approve") await approveFact(member.accountId, id);
  else if (change.action === "edit") await editFact(member.accountId, id, change.fact);
  else await pinFact(member.accountId, id, change.pinned);
  return { ok: true };
});

/** DELETE /api/memory/{id} — forget a fact (or discard a pending one). */
export const DELETE = handle<Ctx>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "manager", "change company memory");
  await forgetFact(member.accountId, (await params).id);
  return { ok: true };
});
