import "server-only";
import { Type, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { NATIVE_AGENTS, type AnyNativeAgent } from "@/lib/agents";
import { partnerAgent } from "@/lib/agents/partner";
import { isGatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { resolveApproval } from "@/lib/gateway/approvals";
import { runTask } from "@/lib/gateway/pipeline";
import { addFact, expiryFrom } from "@/lib/memory";
import { hasRole } from "@/lib/org";
import { SHELF_INFO } from "@/lib/shelves";
import { filePart, generateWithTools, textPart } from "@/lib/vertex";
import { COLLECTIONS, SHELVES, type AgentDoc, type ApprovalDoc, type HireDoc, type MemoryDoc, type Role, type TaskDoc, type UserDoc } from "@/types/firestore";
import { escapeHtml, sendMessage, type InlineButton, type LiveStatus } from "./api";
import type { LinkedPerson } from "./link";

/**
 * The supervisor: every organization's team lead on Telegram. Each message is
 * one stateless Gemini call whose instructions, history and tools are built
 * from the sender's own account only. The account ID never comes from the
 * model; tools close over the LinkedPerson resolved from the Telegram link.
 */

export const SUPERVISOR_NAME = "Ada";
const HISTORY = 20;

type Speaker = "person" | "supervisor" | "agent";

export interface ChatTurn {
  role: Speaker;
  text: string;
  agentName?: string;
}

const chatRef = (p: { accountId: string; uid: string }) => db().collection(COLLECTIONS.telegramChats).doc(`${p.accountId}_${p.uid}`).collection("messages");

export async function saveTurn(p: { accountId: string; uid: string }, turn: ChatTurn) {
  await chatRef(p).add({ ...turn, at: FieldValue.serverTimestamp() });
}

async function history(p: LinkedPerson): Promise<ChatTurn[]> {
  const snap = await chatRef(p).orderBy("at", "desc").limit(HISTORY).get();
  return snap.docs.map((d) => d.data() as ChatTurn).reverse();
}

/**
 * Earlier turns as Gemini contents. Agents' posts go on the user side as a
 * note: shown as the supervisor's own words, the model learned to write fake
 * agent results itself.
 */
export function toContents(turns: ChatTurn[]): Content[] {
  return turns.map((t) => ({
    role: t.role === "supervisor" ? "model" : "user",
    parts: [{ text: t.role === "agent" ? `(Chat note: ${t.agentName} posted this result in the chat) ${t.text}` : t.text }],
  }));
}

const AFTER_POST_MAX = 280;

/**
 * The supervisor's closing words. Once an agent has posted its result, only a
 * short plain follow-up gets through: anything long, or dressed up as another
 * post, would be the model restating (or inventing) the agent's work.
 */
export function finalReply(text: string, calls: { name: string; result: unknown }[]): string {
  const posted = calls.some((c) => c.name === "delegate" && (c.result as { alreadyPostedInChat?: boolean } | null)?.alreadyPostedInChat);
  if (!posted) return text;
  if (text.length > AFTER_POST_MAX || /^[[(]/.test(text) || /\n\s*\n/.test(text)) return "";
  return text;
}

const FOLD_OVER = 280;

/**
 * Posts in the chat under a name, e.g. "Invoice Chaser", so each agent feels
 * like a colleague. A long `quote` (a draft post, a quote) arrives folded,
 * with Telegram's own "show more".
 */
export async function post(chatId: number, name: string, text: string, buttons?: InlineButton[][], quote?: string) {
  const body = quote
    ? `${text ? `${escapeHtml(text)}\n` : ""}<blockquote${quote.length > FOLD_OVER ? " expandable" : ""}>${escapeHtml(quote)}</blockquote>`
    : escapeHtml(text);
  return sendMessage(chatId, `<b>${escapeHtml(name)}</b>\n${body}`, buttons);
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

interface TeamMember {
  agent: AgentDoc;
  handler: AnyNativeAgent | undefined;
}

async function loadTeam(accountId: string): Promise<TeamMember[]> {
  const hires = await db().collection(COLLECTIONS.hires).where("userId", "==", accountId).get();
  const active = hires.docs.map((d) => d.data() as HireDoc).filter((h) => h.active);
  const agents = active.length ? await db().getAll(...active.map((h) => db().collection(COLLECTIONS.agents).doc(h.agentId))) : [];
  return agents
    .filter((s) => s.exists)
    .map((s) => {
      const agent = s.data() as AgentDoc;
      return { agent, handler: agent.source === "native" ? NATIVE_AGENTS[agent.slug] : agent.endpointUrl ? partnerAgent(agent) : undefined };
    });
}

/** "minDaysOverdue (number, default 1); tone (one of Friendly|Bold)": what the supervisor must fill in. */
export function describeInput(schema: z.ZodType | undefined): string {
  if (!schema) return "free-form details";
  let json: { properties?: Record<string, { type?: string; enum?: string[]; default?: unknown; description?: string }>; required?: string[] };
  try {
    json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as typeof json;
  } catch {
    return "free-form details";
  }
  const props = Object.entries(json.properties ?? {});
  if (!props.length) return "nothing; just run it";
  return props
    .map(([k, v]) => {
      const bits = [v.enum ? `one of ${v.enum.join("|")}` : (v.type ?? "value"), json.required?.includes(k) && v.default === undefined ? "required" : null, v.default !== undefined ? `default ${JSON.stringify(v.default)}` : null].filter(Boolean);
      return `${k} (${bits.join(", ")})${v.description ? `: ${v.description}` : ""}`;
    })
    .join("; ");
}

/** The business profile, so agent inputs like a website or audience come from it instead of a question. */
export function profileLines(account: Pick<UserDoc, "businessProfile">): string[] {
  const p = account.businessProfile;
  if (!p) return ["The business profile isn't filled in yet (Company knowledge page)."];
  return [
    "Business profile:",
    `- About: ${p.description}`,
    `- Products and prices: ${p.products}`,
    `- Customers: ${p.audience}`,
    `- Tone of voice: ${p.toneOfVoice}`,
    p.avoidWords.length ? `- Never use: ${p.avoidWords.join(", ")}` : "",
    p.website ? `- Website: ${p.website}` : "",
    p.location ? `- Location: ${p.location}` : "",
    p.openingHours ? `- Opening hours: ${p.openingHours}` : "",
    p.reviewUrl ? `- Review link: ${p.reviewUrl}` : "",
  ].filter(Boolean);
}

function systemPrompt(account: UserDoc, person: LinkedPerson, team: TeamMember[], pendingApprovals: number) {
  const tz = account.businessProfile?.timeZone ?? "Europe/London";
  const now = new Date();
  const today = `${now.toLocaleDateString("en-GB", { weekday: "long", timeZone: tz })} ${now.toLocaleDateString("en-CA", { timeZone: tz })}`;
  const roleRules: Record<Role, string> = {
    owner: "They own the account: they can do everything.",
    manager: "They are a manager: they can give tasks, approve drafts and add to company memory, but not buy tokens.",
    member: "They are a team member: they can give tasks and ask questions, but approving drafts and adding to company memory need an owner or manager. Say so kindly if they ask.",
  };
  return [
    `You are ${SUPERVISOR_NAME}, the team lead of ${account.businessName}'s AI staff on AgentGig. You are chatting on Telegram with ${person.link.firstName}. ${roleRules[person.role]}`,
    `Today is ${today}.`,
    ...profileLines(account),
    "",
    "Your team (name [agentId for tools]: what it does; inputs):",
    ...team.map(({ agent, handler }) =>
      `- ${agent.name} [${agent.slug}]: ${agent.description}${handler?.files?.required ? " Needs a file upload, which only works on the website for now." : ""} Inputs: ${describeInput(handler?.inputSchema)}`,
    ),
    team.length ? "" : "- Nobody is hired yet. Suggest hiring agents from the Marketplace at agentgig.si.",
    pendingApprovals ? `${pendingApprovals} draft(s) are waiting for approval.` : "",
    "",
    "How you work:",
    "- Hand work to the right agent with delegate. Never do an agent's job yourself and never invent results, numbers or customer details.",
    "- Fill inputs from the business profile above, the conversation and company memory (e.g. a website or audience input comes from the profile); use defaults when sensible. Only ask when something required is in none of these, and then ask one short question.",
    "- After delegate, the agent has already posted its full result in the chat, with buttons if it needs an OK. Don't announce, repeat or summarise it, and never say an agent is still working on it. Usually reply with nothing; add one short sentence only for a useful next step.",
    "- Asked about the business (customers, stock, payment habits), check company_memory before saying you don't know.",
    "- If they tell you something the whole team should know, save it with remember (pick the best shelf; give an expiry date for temporary facts).",
    "- If no hired agent can do something, say so and name the kind of agent they could hire.",
    "- Call agents by their names (\"Quote Builder\", not \"the Quote Builder\"), never by their ids.",
    "- Questions about tokens, spending, costs or the balance: use status and answer with the numbers.",
    "- Write like a capable colleague texting: short, warm, plain sentences, no markdown, no emoji. Use the person's language.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const TOOLS: FunctionDeclaration[] = [
  {
    name: "delegate",
    description: "Give a task to one hired agent. It runs now through AgentGig's gateway (costs the agent's tokens) and posts its result in the chat.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: "The agent's id from the team list" },
        input: { type: Type.OBJECT, description: "The agent's inputs as named in the team list. {} when it needs none." },
        why: { type: Type.STRING, description: "One line on what the person asked for" },
      },
      required: ["agentId", "input"],
    },
  },
  { name: "approvals", description: "List drafts waiting for approval.", parameters: { type: Type.OBJECT, properties: {} } },
  {
    name: "decide_approval",
    description: "Approve (send) or skip a waiting draft. Owners and managers only. Use editedText to send a changed version.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        approvalId: { type: Type.STRING },
        action: { type: Type.STRING, enum: ["approve", "skip"] },
        editedText: { type: Type.STRING },
      },
      required: ["approvalId", "action"],
    },
  },
  {
    name: "remember",
    description: "Save a fact to company memory so every agent knows it. Owners and managers only.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        shelf: { type: Type.STRING, enum: [...SHELVES] },
        fact: { type: Type.STRING, description: "One self-contained sentence with absolute dates" },
        expiresOn: { type: Type.STRING, description: "YYYY-MM-DD, last day it's true; omit if lasting" },
      },
      required: ["shelf", "fact"],
    },
  },
  {
    name: "company_memory",
    description: "Facts the team has saved, newest first. Use to answer questions about customers, stock, money, brand or staff.",
    parameters: { type: Type.OBJECT, properties: { shelf: { type: Type.STRING, enum: [...SHELVES] } } },
  },
  { name: "status", description: "Token balance, tokens spent today and the team's recent tasks with what each cost.", parameters: { type: Type.OBJECT, properties: {} } },
];

interface ToolContext {
  person: LinkedPerson;
  account: UserDoc;
  team: TeamMember[];
  live?: LiveStatus;
}

async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { person } = ctx;
  switch (name) {
    case "delegate":
      return delegate(ctx, String(args.agentId ?? ""), (args.input as Record<string, unknown>) ?? {});
    case "approvals": {
      const snap = await db().collection(COLLECTIONS.approvals).where("userId", "==", person.accountId).where("status", "==", "open").get();
      return snap.docs.map((d) => {
        const a = d.data() as ApprovalDoc;
        return { approvalId: d.id, agent: a.agentId, title: a.title, preview: a.preview.slice(0, 300) };
      });
    }
    case "decide_approval": {
      if (!hasRole(person.role, "manager")) return { error: "Only an owner or manager can approve drafts." };
      const res = await resolveApproval(person.accountId, String(args.approvalId), {
        action: args.action === "skip" ? "skip" : "approve",
        ...(typeof args.editedText === "string" && args.editedText.trim() && { editedText: args.editedText.trim() }),
      });
      return res.status === "delivered" ? { done: true, result: res.delivery?.summary } : { done: true, result: "Skipped; nothing was sent." };
    }
    case "remember": {
      if (!hasRole(person.role, "manager")) return { error: "Only an owner or manager can add to company memory." };
      const shelf = SHELVES.find((s) => s === args.shelf) ?? "brand";
      const fact = String(args.fact ?? "").trim();
      if (fact.length < 8) return { error: "Write the fact as a full sentence." };
      await addFact(person.accountId, { uid: person.uid, name: person.link.firstName }, { shelf, fact, expiresOn: expiryFrom(args.expiresOn as string) ? (args.expiresOn as string) : null });
      return { saved: true, shelf: SHELF_INFO[shelf].label };
    }
    case "company_memory": {
      const snap = await db().collection(COLLECTIONS.memory).where("userId", "==", person.accountId).limit(300).get();
      const now = Date.now();
      return snap.docs
        .map((d) => d.data() as MemoryDoc)
        .filter((m) => m.status === "saved" && (!m.expiresAt || m.expiresAt.toMillis() > now) && (!args.shelf || m.shelf === args.shelf))
        .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0))
        .slice(0, 40)
        .map((m) => `[${m.shelf}] ${m.fact}`);
    }
    case "status": {
      const tasks = await db().collection(COLLECTIONS.tasks).where("userId", "==", person.accountId).orderBy("createdAt", "desc").limit(30).get();
      const names = new Map(ctx.team.map((t) => [t.agent.slug, t.agent.name]));
      const startOfDay = new Date().setHours(0, 0, 0, 0);
      const recent = tasks.docs.map((d) => d.data() as TaskDoc);
      return {
        tokenBalance: ctx.account.tokenBalance,
        tokensSpentToday: recent.filter((t) => t.settlement === "charged" && (t.createdAt?.toMillis() ?? 0) >= startOfDay).reduce((n, t) => n + t.cost, 0),
        note: "Tokens are charged only for finished work; failed tasks are free.",
        recentTasks: recent.slice(0, 12).map((t) => ({
          agent: names.get(t.agentId) ?? t.agentId,
          status: t.status,
          tokens: t.settlement === "charged" ? t.cost : 0,
          at: t.createdAt?.toDate().toISOString(),
        })),
      };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

/** Runs a hired agent and posts its result in the chat under the agent's name. */
async function delegate(ctx: ToolContext, agentId: string, input: Record<string, unknown>) {
  const member = ctx.team.find((t) => t.agent.slug === agentId);
  if (!member) return { error: `${agentId} isn't on this team. Hired: ${ctx.team.map((t) => t.agent.slug).join(", ") || "nobody"}.` };
  if (member.handler?.files?.required) return { error: `${member.agent.name} needs a file. Ask them to upload it on agentgig.si for now.` };
  const { person } = ctx;
  await ctx.live?.set(`Handing this to ${member.agent.name}…`);
  try {
    const res = await runTask({
      userId: person.accountId,
      agentId,
      rawInput: input,
      files: [],
      origin: "manual",
      requestedBy: person.uid,
      telegramChatId: person.link.chatId,
    });
    ctx.live?.stop();
    await postResult(person, member, res.taskId, res.status, res.output, res.approvalId, res.delivery?.summary as string | undefined);
    return { status: res.status, tokensCharged: res.tokensCharged, balance: res.balance, alreadyPostedInChat: true };
  } catch (err) {
    if (isGatewayError(err)) return { error: err.message, ...(err.details?.issues ? { missing: err.details.issues } : {}) };
    throw err;
  }
}

/** The agent's own message: a draft with buttons (for people who can approve) or what it did. */
async function postResult(person: LinkedPerson, member: TeamMember, taskId: string, status: string, output: Record<string, unknown>, approvalId?: string, summary?: string) {
  const name = member.agent.name;
  const draft = member.handler?.approval(output);
  const preview = draft?.preview.trim() ?? "";
  let text: string;
  let buttons: InlineButton[][] | undefined;
  if (status === "awaiting_approval" && approvalId) {
    if (hasRole(person.role, "manager")) {
      text = draft?.title ?? "Here's my draft.";
      buttons = [[
        { text: "Approve", callback_data: `ap:${approvalId}:a` },
        ...(member.handler?.editableField ? [{ text: "Edit", callback_data: `ap:${approvalId}:e` }] : []),
        { text: "Skip", callback_data: `ap:${approvalId}:s` },
      ]];
    } else {
      text = `${draft?.title ?? "Here's my draft."} It needs an owner or manager's OK; I've let them know.`;
    }
  } else {
    text = summary ?? draft?.title ?? "Done.";
  }
  await post(person.link.chatId, name, text, buttons, preview || undefined);
  await saveTurn(person, { role: "agent", agentName: name, text: `${text}\n${preview}`.slice(0, 1500) });
  void taskId;
}

/* ------------------------------------------------------------------ */
/* One message                                                         */
/* ------------------------------------------------------------------ */

export async function handlePersonMessage(person: LinkedPerson, message: { text?: string; voice?: Buffer }, live?: LiveStatus) {
  const [accountSnap, team, openApprovals, turns] = await Promise.all([
    db().collection(COLLECTIONS.users).doc(person.accountId).get(),
    loadTeam(person.accountId),
    db().collection(COLLECTIONS.approvals).where("userId", "==", person.accountId).where("status", "==", "open").count().get(),
    history(person),
  ]);
  const account = accountSnap.data() as UserDoc | undefined;
  if (!account) return;

  const parts: Part[] = message.voice
    ? [filePart(message.voice, "audio/ogg"), textPart("(A voice note. Understand it and act on it as if it were typed.)")]
    : [textPart(message.text ?? "")];
  await saveTurn(person, { role: "person", text: message.text ?? "[voice note]" });

  const ctx: ToolContext = { person, account, team, live };
  const reply = await generateWithTools({
    system: systemPrompt(account, person, team, openApprovals.data().count),
    contents: [...toContents(turns), { role: "user", parts }],
    tools: TOOLS,
    run: (name, args) => runTool(ctx, name, args),
  });
  const text = finalReply(reply.text, reply.calls);
  live?.stop();
  if (text) {
    await post(person.link.chatId, SUPERVISOR_NAME, text);
    await saveTurn(person, { role: "supervisor", text });
  }
}
