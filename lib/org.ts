import "server-only";
import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase-admin";
import { GatewayError } from "./errors";
import { COLLECTIONS, type InviteDoc, type MembershipDoc, type Role, type UserDoc } from "@/types/firestore";

/**
 * Organization accounts. The account (users/{accountId}) is the organization;
 * its owner's uid is its ID. Teammates sign in with their own login and a
 * memberships/{uid} doc points them at the account, so every existing
 * per-account document (hires, tasks, ledger, memory) is shared without a
 * migration. One organization per person.
 */

const RANK: Record<Role, number> = { member: 0, manager: 1, owner: 2 };
const INVITE_DAYS = 7;

export interface Membership {
  accountId: string;
  role: Role;
}

const memberships = () => db().collection(COLLECTIONS.memberships);
const invites = () => db().collection(COLLECTIONS.invites);

/** The account a person works in. No membership doc means their own account, as owner. */
export async function membershipOf(uid: string): Promise<Membership> {
  const snap = await memberships().doc(uid).get();
  const m = snap.data() as MembershipDoc | undefined;
  return m ? { accountId: m.accountId, role: m.role } : { accountId: uid, role: "owner" };
}

export function hasRole(role: Role, needed: Role): boolean {
  return RANK[role] >= RANK[needed];
}

const ROLE_WORDS: Record<Role, string> = { owner: "the account owner", manager: "an owner or manager", member: "a team member" };

export function requireRole(caller: { role: Role }, needed: Role, action: string): void {
  if (!hasRole(caller.role, needed)) throw new GatewayError("FORBIDDEN", `Only ${ROLE_WORDS[needed]} can ${action}.`);
}

/* ---------- invites ---------- */

export const InviteRequest = z.object({
  role: z.enum(["manager", "member"]),
  label: z.string().trim().max(80).default(""),
});

export async function createInvite(accountId: string, invitedBy: { uid: string; role: Role }, req: z.infer<typeof InviteRequest>) {
  if (req.role === "manager") requireRole(invitedBy, "owner", "invite managers");
  const account = (await db().collection(COLLECTIONS.users).doc(accountId).get()).data() as UserDoc | undefined;
  if (!account) throw new GatewayError("USER_NOT_FOUND", "We couldn't find your account.");
  if ((account as UserDoc & { isDemo?: boolean }).isDemo) {
    throw new GatewayError("FORBIDDEN", "Demo sandboxes can't invite people. Create an account to build a team.");
  }
  const token = randomBytes(18).toString("base64url");
  await invites().doc(token).set({
    accountId,
    businessName: account.businessName,
    role: req.role,
    label: req.label,
    invitedBy: invitedBy.uid,
    status: "open",
    expiresAt: Timestamp.fromMillis(Date.now() + INVITE_DAYS * 86_400_000),
    createdAt: FieldValue.serverTimestamp(),
  });
  return { token };
}

export async function revokeInvite(accountId: string, token: string) {
  const ref = invites().doc(token);
  const snap = await ref.get();
  if (!snap.exists || snap.get("accountId") !== accountId) throw new GatewayError("TASK_NOT_FOUND", "That invite doesn't exist.");
  await ref.update({ status: "revoked" });
}

/** What the join page shows before the person accepts. */
export async function describeInvite(token: string) {
  const invite = (await invites().doc(token).get()).data() as InviteDoc | undefined;
  if (!invite || invite.status !== "open" || invite.expiresAt.toMillis() < Date.now()) {
    throw new GatewayError("TASK_NOT_FOUND", "This invite link has expired or was already used. Ask for a new one.");
  }
  return { businessName: invite.businessName, role: invite.role };
}

/**
 * Joins the account behind an invite link. The person's own account (created
 * on first sign-in) is left as it was, so leaving later takes them back to it.
 */
export async function acceptInvite(caller: { uid: string; email?: string; name?: string; isAnonymous: boolean }, token: string) {
  if (caller.isAnonymous) throw new GatewayError("FORBIDDEN", "Sign in with email or Google to join a team.");
  const inviteRef = invites().doc(token);
  const memberRef = memberships().doc(caller.uid);

  return db().runTransaction(async (tx) => {
    const [inviteSnap, memberSnap] = await Promise.all([tx.get(inviteRef), tx.get(memberRef)]);
    const invite = inviteSnap.data() as InviteDoc | undefined;
    if (!invite || invite.status !== "open" || invite.expiresAt.toMillis() < Date.now()) {
      throw new GatewayError("TASK_NOT_FOUND", "This invite link has expired or was already used. Ask for a new one.");
    }
    if (invite.accountId === caller.uid) throw new GatewayError("INVALID_INPUT", "That's your own account. Send the link to the person you're inviting.");
    if (memberSnap.exists) {
      throw new GatewayError("INVALID_INPUT", "You're already on a team. Leave it first (Team → Leave this team).");
    }
    tx.set(memberRef, {
      accountId: invite.accountId,
      role: invite.role,
      email: caller.email ?? "",
      displayName: caller.name ?? caller.email?.split("@")[0] ?? "Teammate",
      invitedBy: invite.invitedBy,
      joinedAt: FieldValue.serverTimestamp(),
    });
    tx.update(inviteRef, { status: "used", usedBy: caller.uid });
    return { accountId: invite.accountId, businessName: invite.businessName, role: invite.role };
  });
}

/* ---------- members ---------- */

async function memberIn(accountId: string, uid: string) {
  const ref = memberships().doc(uid);
  const snap = await ref.get();
  if (!snap.exists || snap.get("accountId") !== accountId) throw new GatewayError("USER_NOT_FOUND", "That person isn't on your team.");
  return ref;
}

export async function setMemberRole(accountId: string, uid: string, role: "manager" | "member") {
  await (await memberIn(accountId, uid)).update({ role });
}

export async function removeMember(accountId: string, uid: string) {
  await (await memberIn(accountId, uid)).delete();
}

export async function leaveTeam(uid: string) {
  const ref = memberships().doc(uid);
  if (!(await ref.get()).exists) throw new GatewayError("INVALID_INPUT", "You own this account. Delete it instead if you want to leave.");
  await ref.delete();
}

/** Every membership pointing at an account, for account deletion. */
export async function deleteMemberships(accountId: string): Promise<number> {
  const [members, open] = await Promise.all([
    memberships().where("accountId", "==", accountId).get(),
    invites().where("accountId", "==", accountId).get(),
  ]);
  const batch = db().batch();
  [...members.docs, ...open.docs].forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return members.size + open.size;
}
