import { GatewayError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { clientIp } from "@/lib/rate-limit";
import { accountBySlug, listReviews, ReviewSubmit, submitReview } from "@/lib/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/** GET /api/reviews/{slug}: a business's public reviews and replies (no sign-in). */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const account = await accountBySlug((await params).slug);
  if (!account) throw new GatewayError("USER_NOT_FOUND", "This review page doesn't exist.");
  return { reviews: await listReviews(account.id) };
});

/** POST /api/reviews/{slug}: { rating, name, text } from a customer (no sign-in; rate-limited). */
export const POST = handle<Ctx>(async (req, { params }) => {
  const input = await readJson(req, ReviewSubmit);
  return submitReview((await params).slug, input, clientIp(req));
});
