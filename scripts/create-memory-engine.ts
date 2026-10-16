/**
 * Creates the Vertex AI Agent Engine instance that holds company memory
 * (Memory Bank only, no deployed code) and prints the MEMORY_ENGINE value.
 *
 *   npm run memory:create
 *
 * Run once per project. Without MEMORY_ENGINE the app keeps memory in
 * Firestore only, so this is optional for local development.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { GoogleAuth } from "google-auth-library";

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  if (!project) throw new Error("Set GOOGLE_CLOUD_PROJECT in .env.local");
  if (process.env.MEMORY_ENGINE) {
    console.log(`MEMORY_ENGINE is already set: ${process.env.MEMORY_ENGINE}`);
    return;
  }

  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
  const base = `https://${location}-aiplatform.googleapis.com/v1beta1`;
  const call = async <T>(method: "GET" | "POST", url: string, data?: unknown) =>
    (await client.request<T>({ method, url, data, headers: { "x-goog-user-project": project } })).data;

  type Op = { name: string; done?: boolean; error?: { message: string }; response?: { name: string } };
  let op = await call<Op>("POST", `${base}/projects/${project}/locations/${location}/reasoningEngines`, {
    displayName: "AgentGig company memory",
    description: "Memory Bank for facts agents share within an organization account.",
    contextSpec: { memoryBankConfig: {} },
  });
  process.stdout.write("Creating");
  while (!op.done) {
    await new Promise((r) => setTimeout(r, 5000));
    process.stdout.write(".");
    op = await call<Op>("GET", `${base}/${op.name}`);
  }
  console.log();
  if (op.error) throw new Error(op.error.message);
  const name = op.response?.name ?? op.name.replace(/\/operations\/.*$/, "");
  console.log(`✓ Created. Add this to .env.local and the Cloud Run service:\n\nMEMORY_ENGINE=${name}\n`);
  console.log("The app's service account needs roles/aiplatform.user to read and write memories.");
}

main().catch((err) => {
  console.error("✗", err?.response?.data?.error?.message ?? err?.message ?? err);
  process.exit(1);
});
