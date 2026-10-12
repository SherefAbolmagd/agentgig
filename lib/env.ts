import "server-only";
import { z } from "zod";

const ServerEnvSchema = z.object({
  GOOGLE_CLOUD_PROJECT: z.string().min(1, "Set GOOGLE_CLOUD_PROJECT in .env.local"),
  GOOGLE_CLOUD_LOCATION: z.string().default("us-central1"),
  FIRESTORE_DATABASE_ID: z.string().default("(default)"),
  GEMINI_FLASH_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_PRO_MODEL: z.string().default("gemini-2.5-pro"),
  /** "api" calls Cloud DLP; "local" uses the regex fallback (offline dev, faster demos). */
  DLP_MODE: z.enum(["api", "local"]).default("api"),
  KNOWLEDGE_BUCKET: z.string().optional(),
  /** Bucket for the invoice inbox; uploads there trigger ReceiptHero via Pub/Sub. */
  INBOX_BUCKET: z.string().optional(),
  /**
   * Public URL of this service. When set, triggered work goes through Cloud
   * Tasks and internal calls must carry a Google OIDC token for
   * TASKS_SERVICE_ACCOUNT. When unset (local dev), triggered work runs inline.
   */
  APP_URL: z.url().optional(),
  /**
   * Custom domain users see (e.g. https://agentgig.si), used for OAuth and
   * checkout redirects. Falls back to APP_URL, which stays the run.app URL
   * because Scheduler, Pub/Sub and Cloud Tasks tokens use it as audience.
   */
  PUBLIC_URL: z.url().optional(),
  TASKS_QUEUE: z.string().default("agent-tasks"),
  TASKS_LOCATION: z.string().default("us-central1"),
  TASKS_SERVICE_ACCOUNT: z.string().optional(),
  /** Accept `x-demo-user` instead of a Firebase ID token. Local and demo use only. */
  DEMO_AUTH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (!cached) {
    const parsed = ServerEnvSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid server environment:\n${z.prettifyError(parsed.error)}`);
    }
    // K_SERVICE is set by Cloud Run. The demo-header login must never be reachable there.
    if (parsed.data.DEMO_AUTH && process.env.K_SERVICE) {
      throw new Error("DEMO_AUTH=true is not allowed on Cloud Run: it lets anyone act as any user.");
    }
    cached = parsed.data;
  }
  return cached;
}
