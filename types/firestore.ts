/**
 * Firestore document shapes. One interface per collection; the document ID
 * pattern is noted on each. All writes go through API routes (Admin SDK);
 * clients only read their own docs.
 */
import type { AgentCategory, AgentSkill } from "./a2a";

/** Works for both Admin and client SDK timestamps. */
export type Ts = { toDate(): Date; toMillis(): number };

export const COLLECTIONS = {
  users: "users",
  agents: "agents",
  hires: "hires",
  connections: "connections",
  tasks: "tasks",
  tokenTransactions: "token_transactions",
  approvals: "approvals",
  knowledgeSources: "knowledge_sources",
  styleExamples: "style_examples",
} as const;

export type ToolProvider =
  | "linkedin"
  | "google_drive"
  | "gmail"
  | "google_sheets"
  | "google_business"
  | "slack"
  | "discord"
  | "shopify"
  | "bank_feed";

/* ---------- users/{uid} ---------- */

export interface BusinessProfile {
  description: string; // what the business does, in the owner's words
  products: string; // what you sell, with prices if relevant
  audience: string;
  toneOfVoice: string;
  avoidWords: string[];
  website?: string;
  location?: string;
  openingHours?: string;
  /** IANA zone used for scheduling, e.g. "Europe/London". */
  timeZone?: string;
}

export interface UserDoc {
  displayName: string;
  email: string;
  businessName: string;
  /** Spendable tokens. Never negative; only lib/ledger.ts writes it. */
  tokenBalance: number;
  /** Reserved for running tasks; moves to spent or back to balance on settle. */
  tokensHeld: number;
  tokensSpent: number;
  businessProfile?: BusinessProfile;
  createdAt: Ts;
  updatedAt: Ts;
}

/* ---------- agents/{slug} ---------- */

export interface TriggerOption {
  id: string;
  label: string; // shown in the hire wizard, e.g. "Every Tue and Thu at 08:30"
  type: "schedule" | "event" | "manual";
  cron?: string; // for schedule, in the owner's time zone
  event?: string; // for event, e.g. "google_drive.file_created"
}

export interface AgentDoc {
  slug: string;
  name: string;
  initials: string;
  category: AgentCategory;
  description: string;
  provider: { name: string; url?: string };
  tokensPerTask: number;
  /** native = handler in lib/agents; a2a = partner endpoint called over A2A. */
  source: "native" | "a2a";
  /** Native agents only; resolved to GEMINI_FLASH_MODEL / GEMINI_PRO_MODEL. */
  model?: "flash" | "pro";
  cardUrl?: string;
  endpointUrl?: string;
  skills: AgentSkill[];
  tools: ToolProvider[];
  triggers: TriggerOption[];
  /** Marketing copy for the card, e.g. "3 h/week". */
  timeSaved: string;
  estTasksPerWeek: number;
  rating: number | null;
  taskCount: number;
  status: "pending" | "listed" | "suspended";
  listedAt: Ts;
  /** A2A listings: who registered it, and how the gateway authenticates to it. */
  ownerUid?: string;
  auth?: { type: "apiKey"; header: string; secretRef: string } | null;
  version?: string;
  protocolVersion?: string;
}

/* ---------- hires/{uid}_{slug} ---------- */

export interface HireDoc {
  userId: string;
  agentId: string;
  trigger: TriggerOption;
  approvalMode: "ask" | "auto";
  connectionIds: string[];
  /** "profile" for the business profile, otherwise knowledge_sources IDs. */
  knowledgeAccess: string[];
  /** Max tokens this agent may spend per calendar month; null = no cap. */
  monthlyCapTokens: number | null;
  /** Tokens held or charged this month, for the cap. Written only by lib/ledger.ts. */
  spend?: { period: string; tokens: number };
  active: boolean;
  createdAt: Ts;
  updatedAt: Ts;
}

/* ---------- connections/{id} ---------- */

export interface ConnectionDoc {
  userId: string;
  provider: ToolProvider;
  accountLabel: string; // e.g. "Café Lumen company page"
  scopes: string[];
  /** Secret Manager resource name holding the refresh token. Never the token itself. */
  secretRef: string;
  status: "active" | "expired" | "revoked";
  expiresAt?: Ts;
  createdAt: Ts;
}

/* ---------- tasks/{id} ---------- */

export type TaskStatus =
  | "requested"
  | "reserved"
  | "running"
  | "awaiting_approval"
  | "delivered"
  | "rejected"
  | "failed"
  | "discarded";

export type GatewayStep = "verify" | "reserve" | "scrub" | "ground" | "run" | "deliver";

export interface TaskStepLog {
  step: GatewayStep;
  status: "ok" | "error" | "skipped";
  message: string;
  at: Ts;
}

export interface DlpFinding {
  infoType: string; // e.g. EMAIL_ADDRESS
  count: number;
}

export interface TaskDoc {
  userId: string;
  agentId: string;
  hireId: string | null;
  skillId: string;
  origin: "manual" | "schedule" | "event" | "a2a";
  status: TaskStatus;
  cost: number;
  /** Set once by lib/ledger.ts settleTask; makes settling idempotent. */
  settlement?: "charged" | "released";
  /** Month the task counted against its hire's cap. */
  spendPeriod?: string;
  /** Stored after scrubbing only. */
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  dlpFindings: DlpFinding[];
  steps: TaskStepLog[];
  error?: { code: string; message: string };
  createdAt: Ts;
  updatedAt: Ts;
  finishedAt?: Ts;
}

/* ---------- token_transactions/{id} (append-only) ---------- */

export interface TokenTransactionDoc {
  userId: string;
  type: "topup" | "hold" | "charge" | "release";
  /** Change to tokenBalance: negative for hold, positive for topup and release, 0 for charge. */
  amount: number;
  balanceAfter: number;
  description: string;
  taskId?: string;
  agentId?: string;
  createdAt: Ts;
}

/* ---------- approvals/{id} ---------- */

export interface ApprovalAction {
  id: string;
  label: string;
  kind: "approve" | "edit" | "alternative" | "skip";
}

export interface ApprovalDoc {
  userId: string;
  taskId: string;
  agentId: string;
  title: string;
  preview: string;
  severity: "info" | "check";
  actions: ApprovalAction[];
  status: "open" | "approved" | "skipped";
  editedOutput?: Record<string, unknown>;
  createdAt: Ts;
  resolvedAt?: Ts;
}

/* ---------- knowledge_sources/{id} ---------- */

export interface KnowledgeSourceDoc {
  userId: string;
  name: string; // e.g. "FAQ.pdf"
  mimeType: string;
  storagePath: string; // gs:// path in the knowledge bucket
  sizeBytes: number;
  approxTokens: number;
  status: "processing" | "ready" | "error";
  dlpFindings: DlpFinding[];
  createdAt: Ts;
}

/* ---------- style_examples/{id} ---------- */

export interface StyleExampleDoc {
  userId: string;
  agentId: string;
  draft: string;
  edited: string;
  createdAt: Ts;
}
