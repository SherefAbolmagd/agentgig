import "server-only";
import { Storage } from "@google-cloud/storage";
import { FieldValue } from "firebase-admin/firestore";
import { scrubText } from "./dlp";
import { env } from "./env";
import { GatewayError } from "./errors";
import { db } from "./firebase-admin";
import type { UploadedFile } from "./agents";
import { COLLECTIONS, type DlpFinding, type KnowledgeSourceDoc } from "@/types/firestore";

/**
 * Company knowledge files (FAQ, price list, past posts). Stored in Cloud
 * Storage and handed to agents whole: a small business's documents fit in
 * Gemini's context window, so there's no vector search to maintain.
 * Text files are scrubbed of personal data on upload.
 */

export const KNOWLEDGE_TYPES: Record<string, "pdf" | "text"> = {
  "application/pdf": "pdf",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
};
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_TOTAL_TOKENS = 300_000;

let storage: Storage | undefined;
function bucket() {
  const name = env().KNOWLEDGE_BUCKET;
  if (!name) throw new GatewayError("AGENT_UNAVAILABLE", "File uploads aren't configured (KNOWLEDGE_BUCKET).");
  storage ??= new Storage({ projectId: env().GOOGLE_CLOUD_PROJECT });
  return storage.bucket(name);
}

const sources = () => db().collection(COLLECTIONS.knowledgeSources);

export async function addKnowledge(userId: string, file: UploadedFile): Promise<{ id: string; doc: Omit<KnowledgeSourceDoc, "createdAt"> }> {
  const kind = KNOWLEDGE_TYPES[file.mimeType] ?? (/\.(md|txt|csv)$/i.test(file.name) ? "text" : undefined);
  if (!kind) throw new GatewayError("INVALID_INPUT", `“${file.name}” isn't supported. Upload a PDF, TXT, Markdown or CSV file.`);
  if (file.data.length > MAX_FILE_BYTES) throw new GatewayError("INVALID_INPUT", `“${file.name}” is larger than 5 MB.`);

  const existing = (await sources().where("userId", "==", userId).get()).docs.map((d) => d.data() as KnowledgeSourceDoc);
  if (existing.length >= MAX_FILES) throw new GatewayError("INVALID_INPUT", `You can keep up to ${MAX_FILES} files. Delete one first.`);

  let data = file.data;
  let dlpFindings: DlpFinding[] = [];
  if (kind === "text") {
    const res = await scrubText({ content: file.data.toString("utf8") });
    data = Buffer.from(res.fields.content, "utf8");
    dlpFindings = res.findings;
  }
  const approxTokens = kind === "text" ? Math.ceil(data.toString("utf8").length / 4) : estimatePdfTokens(data);
  const used = existing.reduce((n, s) => n + s.approxTokens, 0);
  if (used + approxTokens > MAX_TOTAL_TOKENS) {
    throw new GatewayError("INVALID_INPUT", "That would take your company knowledge past its size limit. Remove a large file first.");
  }

  const ref = sources().doc();
  const mimeType = kind === "pdf" ? "application/pdf" : "text/plain";
  const storagePath = `users/${userId}/${ref.id}/${file.name.replace(/[^\w.\- ]/g, "_")}`;
  await bucket().file(storagePath).save(data, { contentType: mimeType, resumable: false });

  const doc = { userId, name: file.name, mimeType, storagePath, sizeBytes: data.length, approxTokens, status: "ready" as const, dlpFindings };
  await ref.set({ ...doc, createdAt: FieldValue.serverTimestamp() });
  return { id: ref.id, doc };
}

export async function deleteKnowledge(userId: string, id: string): Promise<void> {
  const ref = sources().doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.get("userId") !== userId) throw new GatewayError("TASK_NOT_FOUND", "That file doesn't exist.");
  await bucket().file(snap.get("storagePath")).delete({ ignoreNotFound: true });
  await ref.delete();
}

/** Downloads the given knowledge files for a run. Missing or foreign IDs are skipped. */
export async function loadKnowledge(userId: string, ids: string[]): Promise<UploadedFile[]> {
  if (!ids.length) return [];
  const snaps = await db().getAll(...ids.map((id) => sources().doc(id)));
  const docs = snaps.filter((s) => s.exists && s.get("userId") === userId).map((s) => s.data() as KnowledgeSourceDoc);
  return Promise.all(
    docs.map(async (d) => {
      const [data] = await bucket().file(d.storagePath).download();
      return { name: d.name, mimeType: d.mimeType, data };
    }),
  );
}

/** Gemini bills roughly 258 tokens per PDF page plus its text; count pages from the PDF's page objects. */
function estimatePdfTokens(pdf: Buffer): number {
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length || 1;
  return pages * 800;
}
