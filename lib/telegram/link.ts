import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { membershipOf } from "@/lib/org";
import { COLLECTIONS, type Role, type TelegramLinkDoc, type UserDoc } from "@/types/firestore";
import { botLink, telegramEnabled } from "./api";

/**
 * Linking a team member's Telegram to AgentGig. Telegram only tells us a
 * numeric user ID, so linking starts on the signed-in website: it makes a
 * one-time code, the person opens t.me/<bot>?start=<code>, and the webhook
 * redeems the code for whoever sent it. Only the code's hash is stored.
 */

const CODE_MINUTES = 10;

const links = () => db().collection(COLLECTIONS.telegramLinks);
const tokens = () => db().collection(COLLECTIONS.telegramTokens);
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

/** Telegram allows A–Z, a–z, 0–9, _ and - in a start parameter, up to 64 characters. */
export function isLinkCode(s: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(s);
}

export async function createLinkCode(member: { uid: string; accountId: string; isAnonymous: boolean }) {
  if (!telegramEnabled()) throw new GatewayError("AGENT_UNAVAILABLE", "Telegram isn't set up on this server yet.");
  if (member.isAnonymous) throw new GatewayError("FORBIDDEN", "Create a free account to use Telegram; demo sandboxes can't link it.");
  const code = randomBytes(24).toString("base64url"); // 32 characters
  const expiresAt = Timestamp.fromMillis(Date.now() + CODE_MINUTES * 60_000);
  await tokens().doc(hash(code)).set({ accountId: member.accountId, uid: member.uid, expiresAt, usedAt: null, createdAt: FieldValue.serverTimestamp() });
  return { url: botLink(code), expiresAt: expiresAt.toDate().toISOString() };
}

export interface TelegramSender {
  id: number;
  username?: string;
  first_name: string;
}

/**
 * Redeems a code for the Telegram account that sent it. One Telegram account
 * belongs to one person, so any older link for it (or for that person) is replaced.
 */
export async function redeemLinkCode(code: string, from: TelegramSender, chatId: number) {
  const tokenRef = tokens().doc(hash(code));
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(tokenRef);
    const t = snap.data() as { accountId: string; uid: string; expiresAt: Timestamp; usedAt: Timestamp | null } | undefined;
    if (!t || t.usedAt || t.expiresAt.toMillis() < Date.now()) return null;
    const others = await tx.get(links().where("telegramUserId", "==", from.id));
    others.docs.filter((d) => d.id !== t.uid).forEach((d) => tx.delete(d.ref));
    tx.set(links().doc(t.uid), {
      accountId: t.accountId,
      uid: t.uid,
      telegramUserId: from.id,
      chatId,
      username: from.username ?? null,
      firstName: from.first_name,
      linkedAt: FieldValue.serverTimestamp(),
      pendingEdit: null,
    });
    tx.update(tokenRef, { usedAt: FieldValue.serverTimestamp() });
    return { accountId: t.accountId, uid: t.uid };
  });
  if (!result) return null;
  const [account, membership] = await Promise.all([
    db().collection(COLLECTIONS.users).doc(result.accountId).get(),
    membershipOf(result.uid),
  ]);
  return { ...result, role: membership.role, businessName: (account.data() as UserDoc | undefined)?.businessName ?? "your business" };
}

export async function unlinkTelegram(uid: string): Promise<boolean> {
  const ref = links().doc(uid);
  if (!(await ref.get()).exists) return false;
  await ref.delete();
  return true;
}

export interface LinkedPerson {
  link: TelegramLinkDoc;
  accountId: string;
  uid: string;
  role: Role;
}

/**
 * Who a Telegram account belongs to, checked fresh on every message: the
 * person must still be on the team the link was made for. A link left behind
 * after someone leaves or is removed is deleted here.
 */
export async function resolveSender(telegramUserId: number): Promise<LinkedPerson | null> {
  const snap = await links().where("telegramUserId", "==", telegramUserId).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return null;
  const link = doc.data() as TelegramLinkDoc;
  const membership = await membershipOf(link.uid);
  if (membership.accountId !== link.accountId) {
    await doc.ref.delete();
    return null;
  }
  return { link, accountId: link.accountId, uid: link.uid, role: membership.role };
}

/** Linked people on an account, e.g. to tell owners and managers a draft is waiting. */
export async function linkedPeople(accountId: string): Promise<LinkedPerson[]> {
  const snap = await links().where("accountId", "==", accountId).get();
  const people = await Promise.all(
    snap.docs.map(async (d) => {
      const link = d.data() as TelegramLinkDoc;
      const m = await membershipOf(link.uid);
      return m.accountId === accountId ? { link, accountId, uid: link.uid, role: m.role } : null;
    }),
  );
  return people.filter((p): p is LinkedPerson => !!p);
}

export async function setPendingEdit(uid: string, approvalId: string | null) {
  await links().doc(uid).update({ pendingEdit: approvalId ? { approvalId, at: Timestamp.now() } : null });
}

/** Account deletion: every link and chat history for the account. */
export async function deleteTelegramData(accountId: string): Promise<number> {
  const linkSnap = await links().where("accountId", "==", accountId).get();
  let n = 0;
  for (const d of linkSnap.docs) {
    await db().recursiveDelete(db().collection(COLLECTIONS.telegramChats).doc(`${accountId}_${d.id}`));
    await d.ref.delete();
    n++;
  }
  return n;
}
