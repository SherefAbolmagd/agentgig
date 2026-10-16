import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { isStripeConfigured } from "@/lib/billing";
import { GatewayError } from "@/lib/errors";
import { handle } from "@/lib/http";
import { topUp } from "@/lib/ledger";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEMO_BUNDLE = 500;

/**
 * POST /api/tokens/topup — free demo top-up (capped per day). Once Stripe is
 * configured, only demo sandboxes can use it; real accounts buy tokens through
 * /api/billing/checkout.
 */
export const POST = handle(async (req) => {
  const caller = await getMember(req);
  if (isStripeConfigured() && !caller.isAnonymous) {
    throw new GatewayError("INVALID_INPUT", "Buy tokens with a card from the top bar.");
  }
  requireRole(caller, "owner", "add tokens");
  await consume("topupsPerUser", caller.accountId);
  return topUp(caller.accountId, DEMO_BUNDLE, `Demo top-up · ${DEMO_BUNDLE} tokens (free)`);
});
