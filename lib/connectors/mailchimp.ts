import "server-only";
import { GatewayError } from "@/lib/errors";
import { keyFields, vendorFetch, type KeyTester } from "./keys";

/** Mailchimp Marketing API v3 with an API key; the data centre is the key's suffix. */

export function mailchimpDc(apiKey: string): string {
  const dc = apiKey.trim().split("-").pop() ?? "";
  if (!/^[a-z]{2}\d{1,3}$/.test(dc)) throw new GatewayError("INVALID_INPUT", "Mailchimp API keys end with a data centre like -us21. Copy the whole key.");
  return dc;
}

function req<T>(apiKey: string, path: string, init: RequestInit = {}) {
  return vendorFetch<T>("Mailchimp", `https://${mailchimpDc(apiKey)}.api.mailchimp.com/3.0${path}`, {
    ...init,
    headers: { authorization: `Basic ${Buffer.from(`agentgig:${apiKey.trim()}`).toString("base64")}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export const testMailchimp: KeyTester = async (f) => {
  const root = await req<{ account_name: string; login_id: string }>(f.apiKey, "/");
  const lists = await req<{ lists: { id: string; name: string; stats: { member_count: number } }[] }>(f.apiKey, "/lists?count=10&fields=lists.id,lists.name,lists.stats.member_count");
  if (!lists.lists.length) throw new GatewayError("INVALID_INPUT", "This Mailchimp account has no audience yet. Create one first.");
  const main = [...lists.lists].sort((a, b) => b.stats.member_count - a.stats.member_count)[0];
  return { accountLabel: `Mailchimp · ${root.account_name} · ${main.name}`, meta: { dc: mailchimpDc(f.apiKey), listId: main.id, listName: main.name } };
};

/** Creates a regular campaign as a draft (never sends) and sets its HTML. */
export async function mailchimpDraftCampaign(userId: string, c: { subject: string; previewText: string; html: string; fromName: string }) {
  const k = await keyFields(userId, "mailchimp");
  if (!k) return null;
  const listId = k.conn.meta?.listId as string;
  const list = await req<{ campaign_defaults: { from_email: string; from_name: string } }>(k.fields.apiKey, `/lists/${listId}?fields=campaign_defaults`);
  const campaign = await req<{ id: string; web_id: number }>(k.fields.apiKey, "/campaigns", {
    method: "POST",
    body: JSON.stringify({
      type: "regular",
      recipients: { list_id: listId },
      settings: {
        subject_line: c.subject.slice(0, 150),
        preview_text: c.previewText.slice(0, 150),
        title: `AgentGig · ${c.subject.slice(0, 80)}`,
        from_name: c.fromName || list.campaign_defaults.from_name,
        reply_to: list.campaign_defaults.from_email,
      },
    }),
  });
  await req(k.fields.apiKey, `/campaigns/${campaign.id}/content`, { method: "PUT", body: JSON.stringify({ html: c.html }) });
  return { campaignId: campaign.id, url: `https://${k.conn.meta?.dc}.admin.mailchimp.com/campaigns/edit?id=${campaign.web_id}` };
}
