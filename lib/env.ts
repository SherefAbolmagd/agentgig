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
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (!cached) {
    const parsed = ServerEnvSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid server environment:\n${z.prettifyError(parsed.error)}`);
    }
    cached = parsed.data;
  }
  return cached;
}
