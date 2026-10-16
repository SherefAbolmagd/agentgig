import { z } from "zod";
import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { BUNDLES, createCheckout, isStripeConfigured, type BundleId } from "@/lib/billing";
import { env } from "@/lib/env";
import { GatewayError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/billing/checkout — { bundle } → { url } of a Stripe Checkout page. */
export const POST = handle(async (req) => {
  if (!isStripeConfigured()) throw new GatewayError("AGENT_UNAVAILABLE", "Card payments aren't set up yet.");
  const caller = await getMember(req);
  if (caller.isAnonymous) throw new GatewayError("UNAUTHENTICATED", "Create a free account to buy tokens; demo sandboxes can't be charged.");
  requireRole(caller, "owner", "buy tokens");
  await consume("topupsPerUser", caller.accountId);
  const { bundle } = await readJson(req, z.object({ bundle: z.enum(Object.keys(BUNDLES) as [BundleId, ...BundleId[]]) }));
  return { url: await createCheckout(caller.accountId, caller.email, bundle, env().PUBLIC_URL ?? env().APP_URL ?? new URL(req.url).origin) };
});
