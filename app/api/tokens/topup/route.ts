import { getCallerId } from "@/lib/auth";
import { handle } from "@/lib/http";
import { topUp } from "@/lib/ledger";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUNDLE = { tokens: 500, priceUsd: 49 };

/** POST /api/tokens/topup — adds a 500-token bundle. Payment is simulated for the hackathon. */
export const POST = handle(async (req) => {
  const uid = await getCallerId(req);
  await consume("topupsPerUser", uid);
  return topUp(uid, BUNDLE.tokens, `Top-up · ${BUNDLE.tokens} token bundle ($${BUNDLE.priceUsd}, simulated)`);
});
