import { getMember } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { saveMemorySettings, SettingsInput } from "@/lib/memory";
import { requireRole } from "@/lib/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/memory/settings — { enabled, approveShelves } */
export const PUT = handle(async (req) => {
  const member = await getMember(req);
  requireRole(member, "owner", "change company memory settings");
  await saveMemorySettings(member.accountId, await readJson(req, SettingsInput));
  return { ok: true };
});
