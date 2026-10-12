import "server-only";
import { GatewayError } from "@/lib/errors";
import { keyFields, vendorFetch, type KeyTester } from "./keys";
import type { SalesSummary } from "./square";

/**
 * PayPal, read-only, with the owner's own REST app credentials (client
 * credentials grant). Transaction search must be enabled on the app.
 */

const HOSTS = { live: "https://api-m.paypal.com", sandbox: "https://api-m.sandbox.paypal.com" } as const;

async function token(f: Record<string, string>, host: string): Promise<string | null> {
  const res = await fetch(`${host}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${f.clientId.trim()}:${f.clientSecret.trim()}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json()) as { access_token: string }).access_token;
}

export const testPaypal: KeyTester = async (f) => {
  for (const env of ["live", "sandbox"] as const) {
    const t = await token(f, HOSTS[env]);
    if (!t) continue;
    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000);
    await vendorFetch(
      "PayPal",
      `${HOSTS[env]}/v1/reporting/transactions?start_date=${start.toISOString().slice(0, 19)}Z&end_date=${end.toISOString().slice(0, 19)}Z&page_size=1`,
      { headers: { authorization: `Bearer ${t}` } },
    ).catch((err) => {
      if (err instanceof GatewayError && /rejected|permissions/.test(err.message)) throw new GatewayError("INVALID_INPUT", "PayPal accepted the app but Transaction search isn't enabled. Tick it in the app's features, then try again.");
      throw err;
    });
    return { accountLabel: `PayPal · ${env === "live" ? "live" : "sandbox"} app`, meta: { env } };
  }
  throw new GatewayError("INVALID_INPUT", "PayPal rejected that Client ID and Secret. Check you copied the Live credentials in full.");
};

/** Sales, refunds and open disputes over the last `days` days and the period before. */
export async function paypalSales(userId: string, days: number): Promise<SalesSummary | null> {
  const k = await keyFields(userId, "paypal");
  if (!k) return null;
  const host = HOSTS[(k.conn.meta?.env as "live" | "sandbox") ?? "live"];
  const t = await token(k.fields, host);
  if (!t) throw new GatewayError("AGENT_FAILED", "PayPal rejected the stored credentials. Reconnect PayPal in Company knowledge.");
  const headers = { authorization: `Bearer ${t}` };
  const now = Date.now();
  const cut = now - days * 86_400_000;
  type Tx = { transaction_info: { transaction_event_code: string; transaction_amount: { value: string; currency_code: string }; transaction_initiation_date: string; transaction_status: string } };
  const txs: Tx[] = [];
  // Transaction search allows at most 31 days per request.
  for (let end = now; end > now - 2 * days * 86_400_000; end -= 31 * 86_400_000) {
    const start = Math.max(end - 31 * 86_400_000, now - 2 * days * 86_400_000);
    for (let page = 1; page <= 10; page++) {
      const q = new URLSearchParams({ start_date: `${new Date(start).toISOString().slice(0, 19)}Z`, end_date: `${new Date(end).toISOString().slice(0, 19)}Z`, page_size: "500", page: String(page) });
      const res = await vendorFetch<{ transaction_details: Tx[]; total_pages: number }>("PayPal", `${host}/v1/reporting/transactions?${q}`, { headers });
      txs.push(...res.transaction_details);
      if (page >= res.total_pages) break;
    }
  }
  const amount = (x: Tx) => Number(x.transaction_info.transaction_amount.value);
  const when = (x: Tx) => Date.parse(x.transaction_info.transaction_initiation_date);
  // T00xx = payments received; T11xx = refunds and reversals.
  const sales = txs.filter((x) => /^T00/.test(x.transaction_info.transaction_event_code) && amount(x) > 0 && x.transaction_info.transaction_status === "S");
  const refunds = txs.filter((x) => /^T11/.test(x.transaction_info.transaction_event_code) && when(x) >= cut);
  const disputes = await vendorFetch<{ items?: { status: string }[] }>("PayPal", `${host}/v1/customer/disputes?page_size=50`, { headers }).catch(() => ({ items: [] }));
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    source: "PayPal",
    currency: sales[0]?.transaction_info.transaction_amount.currency_code ?? "USD",
    gross: r(sales.filter((x) => when(x) >= cut).reduce((t2, x) => t2 + amount(x), 0)),
    prevGross: r(sales.filter((x) => when(x) < cut).reduce((t2, x) => t2 + amount(x), 0)),
    refunds: r(Math.abs(refunds.reduce((t2, x) => t2 + amount(x), 0))),
    count: sales.filter((x) => when(x) >= cut).length,
    disputes: (disputes.items ?? []).filter((d) => !/RESOLVED/.test(d.status)).length,
  };
}
