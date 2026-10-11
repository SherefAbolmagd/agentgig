import "server-only";
import { adminAuth } from "./firebase-admin";
import { env } from "./env";
import { GatewayError } from "./errors";

/**
 * Returns the caller's user ID from a Firebase ID token
 * (`Authorization: Bearer <token>`). With DEMO_AUTH=true, an
 * `x-demo-user: <uid>` header is accepted instead, for curl testing and the
 * hackathon demo account. Never enable DEMO_AUTH on a public deployment.
 */
export async function getCallerId(req: Request): Promise<string> {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    try {
      const decoded = await adminAuth().verifyIdToken(header.slice(7));
      return decoded.uid;
    } catch {
      throw new GatewayError("UNAUTHENTICATED", "Your session has expired. Sign in again.");
    }
  }
  const demoUser = req.headers.get("x-demo-user");
  if (env().DEMO_AUTH && demoUser) return demoUser;
  throw new GatewayError("UNAUTHENTICATED", "Sign in to continue.");
}
