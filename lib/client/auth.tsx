"use client";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { clientAuth } from "@/lib/firebase-client";
import { api } from "./api";
import type { Role } from "@/types/firestore";

interface AuthContextValue {
  user: User | null;
  /** Firebase has reported the sign-in state. */
  ready: boolean;
  /** The server has created this user's account (POST /api/me). */
  accountReady: boolean;
  /** Why the account couldn't be set up (e.g. rate limited), if it failed. */
  accountError: string | null;
  /** The organization account this person works in (their own uid unless they joined a team). */
  accountId: string | null;
  role: Role | null;
  /** Re-reads which account the person belongs to, after joining or leaving a team. */
  refreshAccount(): Promise<void>;
  signInDemo(): Promise<void>;
  signInGoogle(): Promise<void>;
  signInEmail(email: string, password: string): Promise<void>;
  signUpEmail(name: string, email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<{ uid: string; accountId: string; role: Role } | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  async function loadAccount(u: User) {
    try {
      const me = await api<{ accountId: string; role: Role }>("/api/me");
      setAccount({ uid: u.uid, accountId: me.accountId, role: me.role });
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "We couldn't set up your account.");
    }
  }

  useEffect(
    () =>
      onAuthStateChanged(clientAuth, async (u) => {
        setUser(u);
        setReady(true);
        setAccountError(null);
        if (!u) return setAccount(null);
        await loadAccount(u);
      }),
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      ready,
      accountReady: !!user && account?.uid === user.uid,
      accountError,
      accountId: user && account?.uid === user.uid ? account.accountId : null,
      role: user && account?.uid === user.uid ? account.role : null,
      async refreshAccount() {
        if (clientAuth.currentUser) await loadAccount(clientAuth.currentUser);
      },
      async signInDemo() {
        await signInAnonymously(clientAuth);
      },
      async signInGoogle() {
        await signInWithPopup(clientAuth, new GoogleAuthProvider());
      },
      async signInEmail(email, password) {
        await signInWithEmailAndPassword(clientAuth, email, password);
      },
      async signUpEmail(name, email, password) {
        const cred = await createUserWithEmailAndPassword(clientAuth, email, password);
        if (name) await updateProfile(cred.user, { displayName: name });
        await cred.user.getIdToken(true); // so /api/me sees the name
      },
      async signOut() {
        await firebaseSignOut(clientAuth);
      },
    }),
    [user, ready, account, accountError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Turns Firebase Auth error codes into something an owner can act on. */
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const messages: Record<string, string> = {
    "auth/invalid-credential": "That email and password don't match. Check them or create an account.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/email-already-in-use": "There's already an account with this email. Sign in instead.",
    "auth/weak-password": "Use a password with at least 6 characters.",
    "auth/popup-closed-by-user": "The Google window was closed before sign-in finished.",
    "auth/operation-not-allowed": "This sign-in method isn't switched on yet. Try the demo or use email.",
    "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
    "auth/network-request-failed": "You seem to be offline. Check your connection.",
  };
  return messages[code] ?? (err instanceof Error ? err.message : "Sign-in failed. Try again.");
}
