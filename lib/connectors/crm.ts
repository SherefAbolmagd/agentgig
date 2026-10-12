import "server-only";
import { getConnection } from "./index";
import { hubspotAddNote, hubspotContactUrl, hubspotNewLeads, type Lead } from "./hubspot";
import { keyFields, vendorFetch, type KeyTester } from "./keys";
import { accessToken } from "./tokens";

/**
 * One view of the owner's CRM: HubSpot, Pipedrive or Zoho CRM (first one
 * connected, in that order). New leads, open deals, and notes logged back.
 */

export type CrmSystem = "HubSpot" | "Pipedrive" | "Zoho CRM";
export type { Lead };

export interface Deal {
  id: string;
  title: string;
  value: number | null;
  currency: string | null;
  stage: string | null;
  contactName: string | null;
  contactEmail: string | null;
  company: string | null;
  /** Last time anything happened on the deal. */
  lastActivity: string;
  url: string;
}

/* ---------- Pipedrive (personal API token) ---------- */

const pd = <T>(token: string, path: string, init: RequestInit = {}) =>
  vendorFetch<{ success: boolean; data: T; additional_data?: unknown }>("Pipedrive", `https://api.pipedrive.com${path}`, {
    ...init,
    headers: { "x-api-token": token.trim(), "content-type": "application/json", accept: "application/json", ...(init.headers ?? {}) },
  }).then((r) => r.data);

export const testPipedrive: KeyTester = async (f) => {
  const me = await pd<{ name: string; company_name: string; company_domain: string }>(f.apiToken, "/v1/users/me");
  return { accountLabel: `Pipedrive · ${me.company_name}`, meta: { companyDomain: me.company_domain } };
};

async function pipedriveLeads(token: string, domain: string, days: number): Promise<{ leads: Lead[]; urlFor(id: string): string }> {
  const since = Date.now() - days * 86_400_000;
  type P = { id: number; first_name: string | null; last_name: string | null; email: { value: string; primary: boolean }[]; org_name: string | null; add_time: string; job_title?: string | null };
  const people = (await pd<P[] | null>(token, "/v1/persons?limit=100&sort=add_time%20DESC")) ?? [];
  const leads = people
    .filter((p) => Date.parse(`${p.add_time.replace(" ", "T")}Z`) >= since)
    .map((p) => ({
      id: String(p.id),
      firstName: p.first_name ?? "",
      lastName: p.last_name ?? "",
      email: p.email.find((e) => e.primary)?.value ?? p.email[0]?.value ?? null,
      company: p.org_name,
      jobTitle: p.job_title ?? null,
      source: null,
      createdAt: p.add_time,
      notes: null,
    }));
  return { leads, urlFor: (id) => `https://${domain}.pipedrive.com/person/${id}` };
}

async function pipedriveDeals(token: string, domain: string): Promise<Deal[]> {
  type D = {
    id: number;
    title: string;
    value: number;
    currency: string;
    stage_id: number;
    person_name: string | null;
    person_id: { email?: { value: string; primary: boolean }[] } | null;
    org_name: string | null;
    update_time: string;
    last_activity_date: string | null;
  };
  const deals = (await pd<D[] | null>(token, "/v1/deals?status=open&limit=200&sort=update_time%20ASC")) ?? [];
  const stages = new Map(((await pd<{ id: number; name: string }[] | null>(token, "/v1/stages")) ?? []).map((s) => [s.id, s.name]));
  return deals.map((d) => ({
    id: String(d.id),
    title: d.title,
    value: d.value || null,
    currency: d.currency || null,
    stage: stages.get(d.stage_id) ?? null,
    contactName: d.person_name,
    contactEmail: d.person_id?.email?.find((e) => e.primary)?.value ?? d.person_id?.email?.[0]?.value ?? null,
    company: d.org_name,
    lastActivity: [d.last_activity_date, d.update_time.slice(0, 10)].filter(Boolean).sort().pop()!,
    url: `https://${domain}.pipedrive.com/deal/${d.id}`,
  }));
}

/* ---------- Zoho CRM (OAuth) ---------- */

async function zoho(userId: string) {
  const conn = await getConnection(userId, "zoho");
  if (!conn) return null;
  const token = await accessToken(conn);
  const api = String(conn.meta?.apiDomain ?? "https://www.zohoapis.com");
  const call = <T>(path: string, init: RequestInit = {}) =>
    vendorFetch<T>("Zoho CRM", `${api}/crm/v6${path}`, { ...init, headers: { authorization: `Zoho-oauthtoken ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } }).catch((err) => {
      // Zoho answers 204 (no body) when a module is empty.
      if (err instanceof SyntaxError) return { data: [] } as T;
      throw err;
    });
  return { call, api };
}

async function zohoLeads(z: NonNullable<Awaited<ReturnType<typeof zoho>>>, days: number): Promise<Lead[]> {
  const fields = "First_Name,Last_Name,Email,Company,Designation,Lead_Source,Description,Created_Time";
  const res = await z.call<{ data?: Record<string, string | null>[] }>(`/Leads?fields=${fields}&sort_by=Created_Time&sort_order=desc&per_page=50`);
  const since = Date.now() - days * 86_400_000;
  return (res.data ?? [])
    .filter((l) => Date.parse(String(l.Created_Time)) >= since)
    .map((l) => ({
      id: String(l.id),
      firstName: l.First_Name ?? "",
      lastName: l.Last_Name ?? "",
      email: l.Email,
      company: l.Company,
      jobTitle: l.Designation,
      source: l.Lead_Source,
      createdAt: String(l.Created_Time),
      notes: l.Description,
    }));
}

async function zohoDeals(z: NonNullable<Awaited<ReturnType<typeof zoho>>>): Promise<Deal[]> {
  type Z = { id: string; Deal_Name: string; Amount: number | null; Stage: string | null; Contact_Name: { id: string; name: string } | null; Account_Name: { name: string } | null; Modified_Time: string; Last_Activity_Time: string | null; Closing_Date: string | null };
  const res = await z.call<{ data?: Z[] }>("/Deals?fields=Deal_Name,Amount,Stage,Contact_Name,Account_Name,Modified_Time,Last_Activity_Time&sort_by=Modified_Time&sort_order=asc&per_page=100");
  const open = (res.data ?? []).filter((d) => !/^closed/i.test(d.Stage ?? ""));
  const contactIds = [...new Set(open.map((d) => d.Contact_Name?.id).filter(Boolean))] as string[];
  const emails = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += 100) {
    const c = await z.call<{ data?: { id: string; Email: string | null }[] }>(`/Contacts?ids=${contactIds.slice(i, i + 100).join(",")}&fields=Email`);
    for (const x of c.data ?? []) if (x.Email) emails.set(x.id, x.Email);
  }
  return open.map((d) => ({
    id: d.id,
    title: d.Deal_Name,
    value: d.Amount,
    currency: null,
    stage: d.Stage,
    contactName: d.Contact_Name?.name ?? null,
    contactEmail: d.Contact_Name ? (emails.get(d.Contact_Name.id) ?? null) : null,
    company: d.Account_Name?.name ?? null,
    lastActivity: (d.Last_Activity_Time ?? d.Modified_Time).slice(0, 10),
    url: `https://crm.zoho.com/crm/tab/Potentials/${d.id}`,
  }));
}

/* ---------- combined ---------- */

/** New contacts/leads from the first connected CRM. */
export async function crmNewLeads(userId: string, days: number): Promise<{ system: CrmSystem; leads: (Lead & { url: string })[] } | null> {
  const hs = await hubspotNewLeads(userId, days);
  if (hs) return { system: "HubSpot", leads: hs.leads.map((l) => ({ ...l, url: hubspotContactUrl(hs.portalId, l.id) })) };
  const p = await keyFields(userId, "pipedrive");
  if (p) {
    const { leads, urlFor } = await pipedriveLeads(p.fields.apiToken, String(p.conn.meta?.companyDomain ?? "app"), days);
    return { system: "Pipedrive", leads: leads.map((l) => ({ ...l, url: urlFor(l.id) })) };
  }
  const z = await zoho(userId);
  if (z) return { system: "Zoho CRM", leads: (await zohoLeads(z, days)).map((l) => ({ ...l, url: `https://crm.zoho.com/crm/tab/Leads/${l.id}` })) };
  return null;
}

/** Open deals from Pipedrive or Zoho CRM. (HubSpot deals need extra scopes, so they aren't read.) */
export async function crmOpenDeals(userId: string): Promise<{ system: CrmSystem; deals: Deal[] } | null> {
  const p = await keyFields(userId, "pipedrive");
  if (p) return { system: "Pipedrive", deals: await pipedriveDeals(p.fields.apiToken, String(p.conn.meta?.companyDomain ?? "app")) };
  const z = await zoho(userId);
  if (z) return { system: "Zoho CRM", deals: await zohoDeals(z) };
  return null;
}

/** Logs a note against a lead/contact or deal in the CRM it came from. */
export async function crmAddNote(userId: string, system: CrmSystem, target: { kind: "lead" | "deal"; id: string }, text: string): Promise<boolean> {
  if (system === "HubSpot") return target.kind === "lead" ? hubspotAddNote(userId, target.id, text) : false;
  if (system === "Pipedrive") {
    const p = await keyFields(userId, "pipedrive");
    if (!p) return false;
    await pd(p.fields.apiToken, "/v1/notes", { method: "POST", body: JSON.stringify({ content: text.slice(0, 5000), [target.kind === "deal" ? "deal_id" : "person_id"]: Number(target.id) }) });
    return true;
  }
  const z = await zoho(userId);
  if (!z) return false;
  await z.call("/Notes", {
    method: "POST",
    body: JSON.stringify({ data: [{ Note_Title: "AgentGig", Note_Content: text.slice(0, 5000), Parent_Id: { module: { api_name: target.kind === "deal" ? "Deals" : "Leads" }, id: target.id } }] }),
  });
  return true;
}
