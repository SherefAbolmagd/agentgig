import { z } from "zod";
import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { GatewayError } from "@/lib/errors";
import { saveKeyConnection, type KeyTester } from "@/lib/connectors/keys";
import { testAcuity, testCalendly } from "@/lib/connectors/bookings";
import { testPipedrive } from "@/lib/connectors/crm";
import { testJotform, testTypeform } from "@/lib/connectors/forms";
import { testHubspot } from "@/lib/connectors/hubspot";
import { testPaypal } from "@/lib/connectors/paypal";
import { testAsana, testNotion, testTrello } from "@/lib/connectors/tasks";
import { testMailchimp } from "@/lib/connectors/mailchimp";
import { parseProvider } from "@/lib/connectors/manage";
import { testShopify } from "@/lib/connectors/shopify";
import { testStripe } from "@/lib/connectors/stripe-data";
import { testWoo } from "@/lib/connectors/woocommerce";
import { handle, readJson } from "@/lib/http";
import { INTEGRATIONS, type KeyProvider } from "@/lib/integrations";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TESTERS: Record<KeyProvider, KeyTester> = {
  shopify: testShopify,
  woocommerce: testWoo,
  stripe: testStripe,
  mailchimp: testMailchimp,
  hubspot: testHubspot,
  paypal: testPaypal,
  pipedrive: testPipedrive,
  calendly: testCalendly,
  acuity: testAcuity,
  typeform: testTypeform,
  jotform: testJotform,
  trello: testTrello,
  asana: testAsana,
  notion: testNotion,
};

/**
 * POST /api/connections/{provider}/key — { fields } → { accountLabel }
 * Checks the key with a live call to the vendor, then stores it in Secret Manager.
 */
export const POST = handle<{ params: Promise<{ provider: string }> }>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "manager", "connect tools");
  const uid = member.accountId;
  const provider = parseProvider((await params).provider);
  const tester = TESTERS[provider as KeyProvider];
  if (!tester) throw new GatewayError("INVALID_INPUT", `${INTEGRATIONS[provider].name} connects with a sign-in, not a key.`);
  await consume("registrationsPerUser", uid);
  const { fields } = await readJson(req, z.object({ fields: z.record(z.string(), z.string().max(500)) }));
  const check = await saveKeyConnection(uid, provider as KeyProvider, fields, tester);
  return { accountLabel: check.accountLabel };
});
