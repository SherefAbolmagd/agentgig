/**
 * Publishes firestore.rules to the project's Firestore through the Firebase
 * Rules API (no Firebase CLI needed).
 *
 *   npm run deploy:rules
 *
 * Rules apply to the (default) database; named databases need their own
 * release name (cloud.firestore/<database-id>).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

const API = "https://firebaserules.googleapis.com/v1";

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("Set GOOGLE_CLOUD_PROJECT in .env.local");
  const dbId = process.env.FIRESTORE_DATABASE_ID ?? "(default)";
  const releaseId = dbId === "(default)" ? "cloud.firestore" : `cloud.firestore/${dbId}`;

  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
  const call = async <T>(method: string, url: string, data: unknown) =>
    (await client.request<T>({ method: method as "POST", url, data, headers: { "x-goog-user-project": project } })).data;

  const ruleset = await call<{ name: string }>("POST", `${API}/projects/${project}/rulesets`, {
    source: { files: [{ name: "firestore.rules", content: readFileSync("firestore.rules", "utf8") }] },
  });
  const name = `projects/${project}/releases/${releaseId}`;
  try {
    await call("POST", `${API}/projects/${project}/releases`, { name, rulesetName: ruleset.name });
  } catch {
    await call("PATCH", `${API}/${name}`, { release: { name, rulesetName: ruleset.name } });
  }
  console.log(`✓ ${releaseId} now uses ${ruleset.name}`);
}

main().catch((err) => {
  console.error("✗", err.response?.data?.error?.message ?? err.message ?? err);
  process.exit(1);
});
