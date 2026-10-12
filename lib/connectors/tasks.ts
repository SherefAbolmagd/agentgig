import "server-only";
import { GatewayError } from "@/lib/errors";
import { keyFields, vendorFetch, type KeyTester } from "./keys";

/**
 * Task boards: action items become Trello cards, Asana tasks or Notion
 * database pages, in whichever tool is connected (first match wins).
 */

export interface NewTask {
  title: string;
  notes?: string;
  /** YYYY-MM-DD */
  due?: string | null;
}

const isoDate = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

/* ---------- Trello (API key + token) ---------- */

const trello = <T>(f: Record<string, string>, path: string, init: RequestInit = {}) => {
  const sep = path.includes("?") ? "&" : "?";
  return vendorFetch<T>("Trello", `https://api.trello.com/1${path}${sep}key=${encodeURIComponent(f.apiKey.trim())}&token=${encodeURIComponent(f.token.trim())}`, init);
};

export const testTrello: KeyTester = async (f) => {
  const me = await trello<{ fullName: string; username: string }>(f, "/members/me?fields=fullName,username");
  let boardId: string;
  let boardName: string;
  const short = f.boardUrl?.match(/trello\.com\/b\/([A-Za-z0-9]+)/)?.[1];
  if (short) {
    const b = await trello<{ id: string; name: string }>(f, `/boards/${short}?fields=name`);
    [boardId, boardName] = [b.id, b.name];
  } else {
    const boards = await trello<{ id: string; name: string; closed: boolean }[]>(f, "/members/me/boards?fields=name,closed");
    const b = boards.find((x) => !x.closed);
    if (!b) throw new GatewayError("INVALID_INPUT", "Your Trello account has no open boards. Create one or paste a board link.");
    [boardId, boardName] = [b.id, b.name];
  }
  const lists = await trello<{ id: string; name: string }[]>(f, `/boards/${boardId}/lists?filter=open&fields=name`);
  if (!lists[0]) throw new GatewayError("INVALID_INPUT", `The Trello board “${boardName}” has no lists. Add a list first.`);
  return { accountLabel: `Trello · ${boardName} → ${lists[0].name}`, meta: { listId: lists[0].id, boardName, user: me.username } };
};

/* ---------- Asana (personal access token) ---------- */

const asana = <T>(token: string, path: string, init: RequestInit = {}) =>
  vendorFetch<{ data: T }>("Asana", `https://app.asana.com/api/1.0${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json", accept: "application/json", ...(init.headers ?? {}) },
  }).then((r) => r.data);

export const testAsana: KeyTester = async (f) => {
  const me = await asana<{ gid: string; name: string; workspaces: { gid: string; name: string }[] }>(f.token, "/users/me");
  const projectId = f.projectUrl?.match(/app\.asana\.com\/(?:0|1\/\d+\/project)\/(\d+)/)?.[1] ?? null;
  if (projectId) {
    const p = await asana<{ name: string; workspace: { gid: string } }>(f.token, `/projects/${projectId}`);
    return { accountLabel: `Asana · ${p.name}`, meta: { projectId, workspaceId: p.workspace.gid } };
  }
  const ws = me.workspaces[0];
  if (!ws) throw new GatewayError("INVALID_INPUT", "Your Asana account has no workspace.");
  return { accountLabel: `Asana · ${me.name} (My Tasks)`, meta: { workspaceId: ws.gid, projectId: null } };
};

/* ---------- Notion (internal integration + shared database) ---------- */

const NOTION_VERSION = "2022-06-28";
const notion = <T>(token: string, path: string, init: RequestInit = {}) =>
  vendorFetch<T>("Notion", `https://api.notion.com/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token.trim()}`, "notion-version": NOTION_VERSION, "content-type": "application/json", ...(init.headers ?? {}) },
  });

/** Database ID from a Notion link (32 hex characters, with or without dashes). */
export function notionDatabaseId(url: string): string | null {
  const m = url.replace(/-/g, "").match(/([0-9a-f]{32})(?:\?|$|[^0-9a-f])/i);
  return m ? m[1].toLowerCase() : null;
}

export const testNotion: KeyTester = async (f) => {
  const id = notionDatabaseId(f.databaseUrl ?? "");
  if (!id) throw new GatewayError("INVALID_INPUT", "Paste the database's link (Share → Copy link). It ends in a 32-character ID.");
  const db = await notion<{ title: { plain_text: string }[]; properties: Record<string, { type: string }> }>(f.token, `/databases/${id}`).catch((err) => {
    if (err instanceof GatewayError && /couldn.t find/.test(err.message)) throw new GatewayError("INVALID_INPUT", "Notion can't see that database. Open it and add AgentGig under ••• → Connections.");
    throw err;
  });
  const titleProp = Object.entries(db.properties).find(([, p]) => p.type === "title")?.[0];
  const dateProp = Object.entries(db.properties).find(([, p]) => p.type === "date")?.[0] ?? null;
  if (!titleProp) throw new GatewayError("INVALID_INPUT", "That Notion database has no title column.");
  return { accountLabel: `Notion · ${db.title.map((t) => t.plain_text).join("") || "database"}`, meta: { databaseId: id, titleProp, dateProp } };
};

/* ---------- create ---------- */

/** Adds tasks to the first connected board. Returns where they went, or null if no task tool is connected. */
export async function createTasks(userId: string, tasks: NewTask[]): Promise<{ tool: string; count: number; url: string | null } | null> {
  if (!tasks.length) return null;
  const t = await keyFields(userId, "trello");
  if (t) {
    let url: string | null = null;
    for (const task of tasks) {
      const card = await trello<{ url: string }>(t.fields, "/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idList: t.conn.meta?.listId, name: task.title.slice(0, 500), desc: task.notes?.slice(0, 5000) ?? "", ...(isoDate(task.due) && { due: `${task.due}T17:00:00.000Z` }) }),
      });
      url ??= card.url;
    }
    return { tool: "Trello", count: tasks.length, url };
  }
  const a = await keyFields(userId, "asana");
  if (a) {
    let url: string | null = null;
    for (const task of tasks) {
      const created = await asana<{ permalink_url: string }>(a.fields.token, "/tasks", {
        method: "POST",
        body: JSON.stringify({
          data: {
            name: task.title.slice(0, 500),
            notes: task.notes?.slice(0, 5000) ?? "",
            ...(a.conn.meta?.projectId ? { projects: [a.conn.meta.projectId] } : { workspace: a.conn.meta?.workspaceId, assignee: "me" }),
            ...(isoDate(task.due) && { due_on: task.due }),
          },
        }),
      });
      url ??= created.permalink_url;
    }
    return { tool: "Asana", count: tasks.length, url };
  }
  const n = await keyFields(userId, "notion");
  if (n) {
    const m = n.conn.meta as { databaseId: string; titleProp: string; dateProp: string | null };
    let url: string | null = null;
    for (const task of tasks) {
      const page = await notion<{ url: string }>(n.fields.token, "/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: m.databaseId },
          properties: {
            [m.titleProp]: { title: [{ text: { content: task.title.slice(0, 2000) } }] },
            ...(m.dateProp && isoDate(task.due) && { [m.dateProp]: { date: { start: task.due } } }),
          },
          ...(task.notes && { children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: task.notes.slice(0, 2000) } }] } }] }),
        }),
      });
      url ??= page.url;
    }
    return { tool: "Notion", count: tasks.length, url };
  }
  return null;
}
