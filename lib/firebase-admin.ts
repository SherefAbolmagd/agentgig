import "server-only";
import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, initializeFirestore, type Firestore } from "firebase-admin/firestore";
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
    const app = adminApp();
    const dbId = env().FIRESTORE_DATABASE_ID;
    try {
      cache.__axFirestore = initializeFirestore(app, { ignoreUndefinedProperties: true }, dbId);
    } catch {
      // Already initialised by an earlier module instance (dev hot reload).
      cache.__axFirestore = getFirestore(app, dbId);
    }
  }
  return cache.__axFirestore;
}

export function adminAuth() {
  return getAuth(adminApp());
}
