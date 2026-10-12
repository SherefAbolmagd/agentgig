import "server-only";
import { keyFields, vendorFetch, type KeyTester } from "./keys";

/** HubSpot CRM v3 with a private app token. */

function req<T>(token: string, path: string, init: RequestInit = {}) {
  return vendorFetch<T>("HubSpot", `https://api.hubapi.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export const testHubspot: KeyTester = async (f) => {
  const acct = await req<{ portalId: number; accountType?: string; companyCurrency?: string }>(f.token, "/account-info/v3/details");
  await req(f.token, "/crm/v3/objects/contacts?limit=1");
  return { accountLabel: `HubSpot · portal ${acct.portalId}`, meta: { portalId: acct.portalId } };
};

export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  company: string | null;
  jobTitle: string | null;
  source: string | null;
  createdAt: string;
  notes: string | null;
}

const PROPS = ["firstname", "lastname", "email", "company", "jobtitle", "hs_analytics_source", "createdate", "message"];

/** Contacts created in the last `days` days, newest first. */
export async function hubspotNewLeads(userId: string, days: number): Promise<{ leads: Lead[]; portalId: number } | null> {
  const k = await keyFields(userId, "hubspot");
  if (!k) return null;
  const since = Date.now() - days * 86_400_000;
  const res = await req<{ results: { id: string; properties: Record<string, string | null> }[] }>(k.fields.token, "/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "createdate", operator: "GTE", value: String(since) }] }],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      properties: PROPS,
      limit: 20,
    }),
  });
  return {
    portalId: k.conn.meta?.portalId as number,
    leads: res.results.map((r) => ({
      id: r.id,
      firstName: r.properties.firstname ?? "",
      lastName: r.properties.lastname ?? "",
      email: r.properties.email,
      company: r.properties.company,
      jobTitle: r.properties.jobtitle,
      source: r.properties.hs_analytics_source,
      createdAt: r.properties.createdate ?? "",
      notes: r.properties.message,
    })),
  };
}

/** Logs a note on a contact's timeline (association type 202 = note → contact). */
export async function hubspotAddNote(userId: string, contactId: string, body: string): Promise<boolean> {
  const k = await keyFields(userId, "hubspot");
  if (!k) return false;
  await req(k.fields.token, "/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body.slice(0, 5000) },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
    }),
  });
  return true;
}

export function hubspotContactUrl(portalId: number, contactId: string) {
  return `https://app.hubspot.com/contacts/${portalId}/record/0-1/${contactId}`;
}
