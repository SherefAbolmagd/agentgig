import "server-only";
import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { env } from "./env";

// Uses Application Default Credentials: `gcloud auth application-default login`
// locally, the service account on Cloud Run.
function adminApp(): App {
  return (
    getApps()[0] ??
    initializeApp({ credential: applicationDefault(), projectId: env().GOOGLE_CLOUD_PROJECT })
  );
}

// Cached on globalThis so dev hot reloads reuse the instance; Firestore
// throws if settings() is called on an instance that's already in use.
const cache = globalThis as unknown as { __axFirestore?: Firestore };

export function db(): Firestore {
  if (!cache.__axFirestore) {
    const store = getFirestore(adminApp(), env().FIRESTORE_DATABASE_ID);
    try {
      store.settings({ ignoreUndefinedProperties: true });
    } catch {
      // Already configured and in use by an earlier module instance (dev hot reload).
    }
    cache.__axFirestore = store;
  }
  return cache.__axFirestore;
}

export function adminAuth() {
  return getAuth(adminApp());
}
