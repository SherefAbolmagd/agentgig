/**
 * Demo data for the online-store video in a Stripe SANDBOX, created with the
 * Stripe CLI (`stripe login` first; its key stays in the CLI). Revenue Pulse
 * reads it once the sandbox is connected on agentgig.si (Connections → Stripe,
 * a read-only restricted key).
 *
 *   STRIPE=<path to stripe.exe> npx tsx scripts/video-seed-stripe.ts
 *   STRIPE=... npx tsx --conditions=react-server scripts/video-seed-stripe.ts --refund "#1006"
 *       only Emma's payment for her delivered Shopify order (the refund request)
 *
 * Creates this week's paid orders and one declined card. Stripe won't take an
 * invoice due in the past, and test-clock data (its way round that) is hidden
 * from the lists Revenue Pulse reads, so there's no overdue invoice.
 */
import { execFileSync } from "node:child_process";

const STRIPE = process.env.STRIPE ?? "stripe";
const TAG = "agentgig-video";

type Obj = { id: string; [k: string]: unknown };

/** One Stripe API call through the CLI (sandbox), with form fields as `-d key=value`. */
function call(method: "get" | "post", path: string, fields: Record<string, string | number> = {}): Obj {
  const args = [method, path, ...Object.entries(fields).flatMap(([k, v]) => ["-d", `${k}=${v}`])];
  const out = execFileSync(STRIPE, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const json = JSON.parse(out.slice(out.indexOf("{"))) as Obj & { error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json;
}

const THIS_WEEK: [string, string, number, string][] = [
  ["Emma Clarke", "emma.clarke@example.com", 4200, "#1043 · Fig & Cedar candle ×2"],
  ["Tom Reid", "tom.reid@example.com", 2800, "#1044 · Sea Salt & Sage candle"],
  ["Aisha Khan", "aisha.khan@example.com", 6400, "#1045 · Autumn gift set"],
  ["Lucy Fernandes", "lucy.f@example.com", 1900, "#1046 · Wax melts, Amber"],
  ["Oliver Grant", "oliver.grant@example.com", 5600, "#1047 · Fig & Cedar ×2, matches"],
  ["Mia Novak", "mia.novak@example.com", 3400, "#1048 · Black Pepper & Vetiver candle"],
  ["Emma Clarke", "emma.clarke@example.com", 2800, "#1049 · Sea Salt & Sage candle"],
];
const DECLINED: [string, string, number, string] = ["Ben Walsh", "ben.walsh@example.com", 4800, "#1050 · Autumn gift set"];

/** Emma's card payment for the order she asks to refund, tagged with its Shopify number. */
async function refundable(orderName: string) {
  const { config } = await import("dotenv");
  config({ path: ".env.local" });
  const { videoAddresses, PEOPLE } = await import("./video-inbox");
  const email = (await videoAddresses()).emma;
  const cust = call("post", "/v1/customers", { name: PEOPLE.emma.name, email, "metadata[source]": TAG }).id;
  const pi = call("post", "/v1/payment_intents", {
    amount: 2800,
    currency: "gbp",
    customer: cust,
    description: `${orderName} · Fig & Cedar candle, Long matches`,
    payment_method: "pm_card_visa",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
    confirm: "true",
    "metadata[order]": orderName,
    "metadata[source]": TAG,
  });
  console.log(`✓ Emma's £28.00 payment for ${orderName}: ${pi.id}`);
}

function main() {
  const i = process.argv.indexOf("--refund");
  if (i > 0) return void refundable(process.argv[i + 1]).then(() => process.exit(0), (err) => (console.error(err), process.exit(1)));
  const customers = new Map<string, string>();
  const customer = (name: string, email: string, clock?: string) => {
    if (!customers.has(email)) {
      customers.set(email, call("post", "/v1/customers", { name, email, "metadata[source]": TAG, ...(clock && { test_clock: clock }) }).id);
    }
    return customers.get(email)!;
  };
  const pay = (cust: string, amount: number, description: string, pm = "pm_card_visa") =>
    call("post", "/v1/payment_intents", {
      amount,
      currency: "gbp",
      customer: cust,
      description,
      payment_method: pm,
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
      confirm: "true",
      "metadata[source]": TAG,
    });

  for (const [name, email, amount, desc] of THIS_WEEK) pay(customer(name, email), amount, desc);
  try {
    pay(customer(DECLINED[0], DECLINED[1]), DECLINED[2], DECLINED[3], "pm_card_chargeDeclined");
  } catch {
    // Declined, as intended: the failed charge is what Revenue Pulse should spot.
  }
  console.log(`✓ ${THIS_WEEK.length} paid orders and 1 declined card this week`);

}

main();
