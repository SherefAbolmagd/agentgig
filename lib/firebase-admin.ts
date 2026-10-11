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

let firestore: Firestore | undefined;

export function db(): Firestore {
  if (!firestore) {
    firestore = getFirestore(adminApp(), env().FIRESTORE_DATABASE_ID);
    firestore.settings({ ignoreUndefinedProperties: true });
  }
  return firestore;
}

export function adminAuth() {
  return getAuth(adminApp());
}
