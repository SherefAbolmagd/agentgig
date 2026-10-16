import "server-only";
import { adminAuth } from "./firebase-admin";
import { env } from "./env";
import { GatewayError } from "./errors";
import { membershipOf } from "./org";
import type { Caller } from "./users";
import type { Role } from "@/types/firestore";

/**
 * Identifies the caller from a Firebase ID token (`Authorization: Bearer
 * <token>`). With DEMO_AUTH=true, an `x-demo-user: <uid>` header is accepted
 * instead, for curl testing. Never enable DEMO_AUTH on a public deployment.
 */
export async function getCaller(req: Request): Promise<Caller> {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    try {
      const t = await adminAuth().verifyIdToken(header.slice(7));
      return { uid: t.uid, email: t.email, name: t.name as string | undefined, isAnonymous: t.firebase.sign_in_provider === "anonymous" };
    } catch {
      throw new GatewayError("UNAUTHENTICATED", "Your session has expired. Sign in again.");
    }
  }
  const demoUser = req.headers.get("x-demo-user");
  if (demoUser && env().DEMO_AUTH) return { uid: demoUser, isAnonymous: true };
  throw new GatewayError("UNAUTHENTICATED", "Sign in to continue.");
}

/** A signed-in person plus the organization account they work in and their role there. */
export interface Member extends Caller {
  accountId: string;
  role: Role;
}

export async function getMember(req: Request): Promise<Member> {
  const caller = await getCaller(req);
  return { ...caller, ...(await membershipOf(caller.uid)) };
}

/** The account ID that every per-account document is keyed by. */
export async function getCallerId(req: Request): Promise<string> {
  return (await getMember(req)).accountId;
}
