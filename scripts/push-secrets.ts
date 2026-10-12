/**
 * Copies provider keys from .env.local into Secret Manager and attaches them
 * to the Cloud Run service. Creates the Stripe webhook endpoint when needed.
 * Never prints secret values.
 *
 *   npm run push:secrets
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { execFileSync } from "node:child_process";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import Stripe from "stripe";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "agentexchange-hackathon";
const SERVICE = "agentexchange";
const REGION = "us-central1";
const APP_URL = process.env.PROD_APP_URL ?? "https://agentexchange-653235000565.us-central1.run.app";

const KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
] as const;

const sm = new SecretManagerServiceClient();
const secretId = (k: string) => `app-${k.toLowerCase().replace(/_/g, "-")}`;

async function put(key: string, value: string) {
  const parent = `projects/${PROJECT}`;
  const name = `${parent}/secrets/${secretId(key)}`;
  try {
    await sm.createSecret({ parent, secretId: secretId(key), secret: { replication: { automatic: {} }, labels: { app: "agentexchange" } } });
  } catch (err) {
    if ((err as { code?: number }).code !== 6) throw err;
  }
  // Skip a new version if the value hasn't changed.
  try {
    const [v] = await sm.accessSecretVersion({ name: `${name}/versions/latest` });
    if (Buffer.from(v.payload?.data as Uint8Array).toString("utf8") === value) return "unchanged";
  } catch {
    /* no versions yet */
  }
  await sm.addSecretVersion({ parent: name, payload: { data: Buffer.from(value, "utf8") } });
  return "updated";
}

async function ensureStripeWebhook(): Promise<string | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const stripe = new Stripe(key);
  const url = `${APP_URL}/api/billing/webhook`;
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === url);
  if (existing && process.env.STRIPE_WEBHOOK_SECRET) return null; // already set up; secret is in .env.local
  if (existing) await stripe.webhookEndpoints.del(existing.id); // its secret can't be read back, so recreate
  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
    description: "AgentExchange token top-ups",
  });
  console.log(`✓ Stripe webhook endpoint created for ${url}`);
  return created.secret ?? null;
}

async function main() {
  const webhookSecret = await ensureStripeWebhook();
  if (webhookSecret) process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;

  const present = KEYS.filter((k) => process.env[k]?.trim());
  const missing = KEYS.filter((k) => !process.env[k]?.trim());
  for (const k of present) console.log(`✓ ${k}: ${await put(k, process.env[k]!.trim())}`);
  if (missing.length) console.log(`• not set yet (skipped): ${missing.join(", ")}`);
  if (!present.length) return;

  const gcloud = process.platform === "win32" ? `${process.env.LOCALAPPDATA}\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd` : "gcloud";
  const mapping = present.map((k) => `${k}=${secretId(k)}:latest`).join(",");
  console.log(`Attaching ${present.length} secret(s) to Cloud Run ${SERVICE}…`);
  execFileSync(process.platform === "win32" ? `"${gcloud}"` : gcloud, ["run", "services", "update", SERVICE, "--region", REGION, "--project", PROJECT, "--update-secrets", mapping, "--quiet"], {
    stdio: ["ignore", "ignore", "inherit"],
    shell: process.platform === "win32",
  });
  console.log("✓ Cloud Run updated; the new revision uses these keys.");
}

main().catch((err) => {
  console.error("✗", err.message ?? err);
  process.exit(1);
});
