import "server-only";
import { OAuth2Client } from "google-auth-library";
import { env } from "./env";
import { GatewayError } from "./errors";

const oauth = new OAuth2Client();

/**
 * Verifies a call from Cloud Scheduler, Cloud Tasks or Pub/Sub push: a
 * Google-signed OIDC token whose audience is this service and whose email is
 * our own service account. Locally (no APP_URL) it accepts DEMO_AUTH callers
 * with `x-internal-dev: 1`, so triggers can be exercised with curl.
 */
export async function verifyInternalCall(req: Request): Promise<void> {
  const { APP_URL, TASKS_SERVICE_ACCOUNT, DEMO_AUTH } = env();
  if (!APP_URL) {
    if (DEMO_AUTH && req.headers.get("x-internal-dev") === "1") return;
    throw new GatewayError("UNAUTHENTICATED", "Internal endpoint.");
  }
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw new GatewayError("UNAUTHENTICATED", "Internal endpoint.");
  try {
    const ticket = await oauth.verifyIdToken({ idToken: header.slice(7), audience: APP_URL });
    const claims = ticket.getPayload();
    if (!claims?.email_verified || claims.email !== TASKS_SERVICE_ACCOUNT) throw new Error("wrong caller");
  } catch {
    throw new GatewayError("UNAUTHENTICATED", "Internal endpoint.");
  }
}
