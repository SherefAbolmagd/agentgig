import "server-only";
import { env } from "@/lib/env";
import { GatewayError } from "@/lib/errors";
import { vendorFetch } from "./keys";

/** UK Companies House public data (free API key, read-only, no owner sign-in). */

export interface CompanyFilings {
  name: string;
  status: string;
  accountsDue: string | null;
  /** End of the next accounting period, which sets the Corporation Tax dates. */
  accountsMadeUpTo: string | null;
  confirmationDue: string | null;
}

export async function companyFilings(companyNumber: string): Promise<CompanyFilings> {
  const key = env().COMPANIES_HOUSE_API_KEY;
  if (!key) throw new GatewayError("AGENT_UNAVAILABLE", "Companies House lookups aren't set up yet.");
  const res = await vendorFetch<{
    company_name: string;
    company_status: string;
    accounts?: { next_due?: string; next_made_up_to?: string };
    confirmation_statement?: { next_due?: string };
  }>("Companies House", `https://api.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}`, {
    headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, accept: "application/json" },
  }).catch((err) => {
    if (err instanceof GatewayError && /couldn.t find/.test(err.message)) throw new GatewayError("INVALID_INPUT", `Companies House has no company ${companyNumber}. Check the number in your profile.`);
    throw err;
  });
  return {
    name: res.company_name,
    status: res.company_status,
    accountsDue: res.accounts?.next_due ?? null,
    accountsMadeUpTo: res.accounts?.next_made_up_to ?? null,
    confirmationDue: res.confirmation_statement?.next_due ?? null,
  };
}
