import "server-only";
import { GatewayError } from "@/lib/errors";
import { keyFields, vendorFetch, type KeyTester } from "./keys";

/** New responses from Typeform and Jotform, normalised to question → answer pairs. */

export interface FormEntry {
  /** Stable across runs, used to process each entry once. */
  key: string;
  source: "Typeform" | "Jotform";
  form: string;
  submittedAt: string;
  answers: { question: string; answer: string }[];
  name: string | null;
  email: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- Typeform ---------- */

const tf = <T>(token: string, path: string) => vendorFetch<T>("Typeform", `https://api.typeform.com${path}`, { headers: { authorization: `Bearer ${token.trim()}` } });

export const testTypeform: KeyTester = async (f) => {
  const me = await tf<{ alias?: string; email?: string }>(f.token, "/me");
  await tf(f.token, "/forms?page_size=1");
  return { accountLabel: `Typeform · ${me.alias ?? me.email ?? "account"}`, meta: {} };
};

async function typeformEntries(token: string, since: Date): Promise<FormEntry[]> {
  const forms = await tf<{ items: { id: string; title: string }[] }>(token, "/forms?page_size=50");
  const out: FormEntry[] = [];
  for (const form of forms.items.slice(0, 20)) {
    const def = await tf<{ fields?: { id: string; title: string }[] }>(token, `/forms/${form.id}`);
    const titles = new Map((def.fields ?? []).map((x) => [x.id, x.title]));
    const res = await tf<{
      items: {
        response_id: string;
        submitted_at: string;
        answers?: { field: { id: string }; type: string; text?: string; email?: string; number?: number; boolean?: boolean; choice?: { label?: string }; choices?: { labels?: string[] }; date?: string; phone_number?: string; url?: string }[];
      }[];
    }>(token, `/forms/${form.id}/responses?since=${encodeURIComponent(since.toISOString())}&page_size=100&completed=true`);
    for (const r of res.items) {
      const answers = (r.answers ?? []).map((a) => ({
        question: titles.get(a.field.id) ?? a.field.id,
        answer: String(a.text ?? a.email ?? a.number ?? a.boolean ?? a.choice?.label ?? a.choices?.labels?.join(", ") ?? a.date ?? a.phone_number ?? a.url ?? ""),
      }));
      out.push({ key: `typeform-${r.response_id}`, source: "Typeform", form: form.title, submittedAt: r.submitted_at, answers, ...contactOf(answers) });
    }
  }
  return out;
}

/* ---------- Jotform ---------- */

async function jotformBase(apiKey: string): Promise<string> {
  // EU accounts live on a separate API host; try the main one first.
  for (const host of ["https://api.jotform.com", "https://eu-api.jotform.com"]) {
    const r = await fetch(`${host}/user?apiKey=${encodeURIComponent(apiKey.trim())}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.ok) return host;
  }
  throw new GatewayError("INVALID_INPUT", "Jotform rejected that API key. Check it was copied in full.");
}

export const testJotform: KeyTester = async (f) => {
  const host = await jotformBase(f.apiKey);
  const me = await vendorFetch<{ content: { username: string; name?: string } }>("Jotform", `${host}/user?apiKey=${encodeURIComponent(f.apiKey.trim())}`);
  return { accountLabel: `Jotform · ${me.content.name || me.content.username}`, meta: { host } };
};

async function jotformEntries(apiKey: string, host: string, since: Date): Promise<FormEntry[]> {
  const filter = JSON.stringify({ "created_at:gt": since.toISOString().slice(0, 19).replace("T", " ") });
  const res = await vendorFetch<{
    content: { id: string; form_id: string; created_at: string; status: string; answers: Record<string, { text?: string; answer?: unknown; prettyFormat?: string; type?: string }> }[];
  }>("Jotform", `${host}/user/submissions?apiKey=${encodeURIComponent(apiKey.trim())}&limit=100&orderby=created_at&filter=${encodeURIComponent(filter)}`);
  const titles = new Map<string, string>();
  const out: FormEntry[] = [];
  for (const s of res.content.filter((x) => x.status === "ACTIVE")) {
    if (!titles.has(s.form_id)) {
      const f = await vendorFetch<{ content: { title: string } }>("Jotform", `${host}/form/${s.form_id}?apiKey=${encodeURIComponent(apiKey.trim())}`).catch(() => ({ content: { title: "Form" } }));
      titles.set(s.form_id, f.content.title);
    }
    const answers = Object.values(s.answers)
      .filter((a) => a.answer !== undefined && a.answer !== "" && !["control_head", "control_button", "control_text"].includes(a.type ?? ""))
      .map((a) => ({ question: a.text ?? "Field", answer: a.prettyFormat ?? (typeof a.answer === "object" ? Object.values(a.answer as Record<string, string>).filter(Boolean).join(" ") : String(a.answer)) }));
    out.push({ key: `jotform-${s.id}`, source: "Jotform", form: titles.get(s.form_id)!, submittedAt: `${s.created_at.replace(" ", "T")}Z`, answers, ...contactOf(answers) });
  }
  return out;
}

/** Picks the respondent's name and email out of the answers. */
export function contactOf(answers: { question: string; answer: string }[]): { name: string | null; email: string | null } {
  const email = answers.find((a) => EMAIL.test(a.answer.trim()))?.answer.trim() ?? null;
  const name = answers.find((a) => /\bname\b/i.test(a.question) && !/company|business/i.test(a.question) && a.answer.trim().length < 80)?.answer.trim() ?? null;
  return { name, email };
}

/** Entries submitted after `since` from every connected form tool. Null if none is connected. */
export async function newFormEntries(userId: string, since: Date): Promise<{ sources: string[]; entries: FormEntry[] } | null> {
  const [t, j] = await Promise.all([keyFields(userId, "typeform"), keyFields(userId, "jotform")]);
  if (!t && !j) return null;
  const [a, b] = await Promise.all([t ? typeformEntries(t.fields.token, since) : [], j ? jotformEntries(j.fields.apiKey, String(j.conn.meta?.host ?? "https://api.jotform.com"), since) : []]);
  return { sources: [t && "Typeform", j && "Jotform"].filter(Boolean) as string[], entries: [...a, ...b].sort((x, y) => x.submittedAt.localeCompare(y.submittedAt)) };
}
