/**
 * Connects the Willow and Wick Shopify dev store to the video account. The
 * "AgentGig demo" app (made with the Shopify CLI and installed on the store)
 * exchanges its own credentials for an Admin API token, which is saved through
 * AgentGig's normal key connection (tested first, stored in Secret Manager).
 * Nothing is printed except the result.
 *
 *   SHOPIFY_APP_DIR=<app folder> npx tsx --conditions=react-server scripts/video-connect-shopify.ts
 *
 * Tokens from this exchange last 24 hours: run it again before a recording.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { execFileSync } from "node:child_process";

const STORE = process.env.SHOPIFY_STORE ?? "willow-and-wick.myshopify.com";
const APP_DIR = process.env.SHOPIFY_APP_DIR;

async function main() {
  if (!APP_DIR) throw new Error("Set SHOPIFY_APP_DIR to the AgentGig demo app's folder.");
  const env = execFileSync(process.platform === "win32" ? "shopify.cmd" : "shopify", ["app", "env", "show", "--path", APP_DIR, "--no-input"], { encoding: "utf8", shell: process.platform === "win32" });
  const read = (name: string) => new RegExp(`${name}=(\\S+)`).exec(env.replace(/\x1b\[[0-9;]*m/g, ""))?.[1];
  const clientId = read("SHOPIFY_API_KEY");
  const clientSecret = read("SHOPIFY_API_SECRET");
  if (!clientId || !clientSecret) throw new Error("Couldn't read the app's credentials.");

  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Shopify token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const { access_token: token, scope, expires_in: expires } = (await res.json()) as { access_token: string; scope: string; expires_in?: number };

  const { saveKeyConnection } = await import("@/lib/connectors/keys");
  const { testShopify } = await import("@/lib/connectors/shopify");
  const check = await saveKeyConnection("video-cafe-lumen", "shopify", { shopDomain: STORE, accessToken: token }, testShopify);
  console.log(`✓ Shopify connected to the video account: ${check.accountLabel}`);
  console.log(`  scopes: ${scope}${expires ? `; token valid for ${Math.round(expires / 3600)} h` : ""}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
