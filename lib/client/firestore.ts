"use client";
import {
  collection,
  doc,
  limit as limitTo,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import { clientDb } from "@/lib/firebase-client";
import { useAuth } from "./auth";
import {
  COLLECTIONS,
  type AgentDoc,
  type ApprovalDoc,
  type ConnectionDoc,
  type HireDoc,
  type KnowledgeSourceDoc,
  type TaskDoc,
  type TokenTransactionDoc,
  type UserDoc,
} from "@/types/firestore";

export type WithId<T> = T & { id: string };

interface Live<T> {
  data: T;
  loading: boolean;
  error: Error | null;
}

/** Live document. `path` null means "not yet" (e.g. signed out). */
export function useLiveDoc<T>(path: string | null): Live<WithId<T> | null> {
  const [state, setState] = useState<Live<WithId<T> | null>>({ data: null, loading: !!path, error: null });
  useEffect(() => {
    if (!path) return setState({ data: null, loading: false, error: null });
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      doc(clientDb, path),
      (snap) => setState({ data: snap.exists() ? ({ id: snap.id, ...snap.data() } as WithId<T>) : null, loading: false, error: null }),
      (error) => setState({ data: null, loading: false, error }),
    );
  }, [path]);
  return state;
}

/**
 * Live query. `key` identifies the query; it re-subscribes when the key
 * changes. Pass null as the collection to skip.
 */
export function useLiveQuery<T>(col: string | null, constraints: QueryConstraint[], key: string): Live<WithId<T>[]> {
  const [state, setState] = useState<Live<WithId<T>[]>>({ data: [], loading: !!col, error: null });
  useEffect(() => {
    if (!col) return setState({ data: [], loading: false, error: null });
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      query(collection(clientDb, col), ...constraints),
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WithId<T>), loading: false, error: null }),
      (error) => {
        console.error(`Live query ${col} failed`, error);
        setState({ data: [], loading: false, error });
      },
    );
    // constraints are described by `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [col, key]);
  return state;
}

/* ---------- domain hooks ---------- */

function useUid(): string | null {
  const { user, accountReady } = useAuth();
  return accountReady && user ? user.uid : null;
}

export function useMe() {
  const uid = useUid();
  return useLiveDoc<UserDoc>(uid ? `${COLLECTIONS.users}/${uid}` : null);
}

export function useAgents() {
  return useLiveQuery<AgentDoc>(COLLECTIONS.agents, [where("status", "==", "listed")], "listed");
}

export function useHires() {
  const uid = useUid();
  const res = useLiveQuery<HireDoc>(uid && COLLECTIONS.hires, [where("userId", "==", uid)], `hires:${uid}`);
  return { ...res, data: res.data.filter((h) => h.active) };
}

export function useOpenApprovals() {
  const uid = useUid();
  return useLiveQuery<ApprovalDoc>(
    uid && COLLECTIONS.approvals,
    [where("userId", "==", uid), where("status", "==", "open"), orderBy("createdAt", "desc")],
    `approvals:${uid}`,
  );
}

export function useRecentTasks(n = 30) {
  const uid = useUid();
  return useLiveQuery<TaskDoc>(
    uid && COLLECTIONS.tasks,
    [where("userId", "==", uid), orderBy("createdAt", "desc"), limitTo(n)],
    `tasks:${uid}:${n}`,
  );
}

export function useTask(taskId: string | null) {
  return useLiveDoc<TaskDoc & { delivery?: Record<string, unknown> }>(taskId ? `${COLLECTIONS.tasks}/${taskId}` : null);
}

export function useTransactions(n = 20) {
  const uid = useUid();
  return useLiveQuery<TokenTransactionDoc>(
    uid && COLLECTIONS.tokenTransactions,
    [where("userId", "==", uid), orderBy("createdAt", "desc"), limitTo(n)],
    `txns:${uid}:${n}`,
  );
}

export function useKnowledge() {
  const uid = useUid();
  return useLiveQuery<KnowledgeSourceDoc>(
    uid && COLLECTIONS.knowledgeSources,
    [where("userId", "==", uid), orderBy("createdAt", "desc")],
    `knowledge:${uid}`,
  );
}

export function useConnections() {
  const uid = useUid();
  return useLiveQuery<ConnectionDoc>(uid && COLLECTIONS.connections, [where("userId", "==", uid)], `connections:${uid}`);
}
