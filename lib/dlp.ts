import "server-only";
import { DlpServiceClient } from "@google-cloud/dlp";
import { env } from "./env";
import type { DlpFinding } from "@/types/firestore";

/**
 * Removes personal data before any agent sees it. Text is de-identified by
 * replacing each match with its type, e.g. "[EMAIL_ADDRESS]". Images are
 * redacted with black boxes. PDFs pass through unredacted (DLP's image
 * redaction doesn't take PDFs); the task log records that.
 *
 * DLP_MODE=local uses regexes instead of the API, for offline development.
 */

const INFO_TYPES = [
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "CREDIT_CARD_NUMBER",
  "IBAN_CODE",
  "US_SOCIAL_SECURITY_NUMBER",
  "UK_NATIONAL_INSURANCE_NUMBER",
  "STREET_ADDRESS",
] as const;

const IMAGE_TYPES: Record<string, "IMAGE_JPEG" | "IMAGE_PNG" | "IMAGE_BMP"> = {
  "image/jpeg": "IMAGE_JPEG",
  "image/png": "IMAGE_PNG",
  "image/bmp": "IMAGE_BMP",
};

export interface ScrubTextResult<K extends string> {
  fields: Record<K, string>;
  findings: DlpFinding[];
}

export interface ScrubFileResult {
  data: Buffer;
  findings: DlpFinding[];
  redacted: boolean;
  note?: string;
}

let client: DlpServiceClient | undefined;
const dlp = () => (client ??= new DlpServiceClient());
const parent = () => `projects/${env().GOOGLE_CLOUD_PROJECT}/locations/global`;
const inspectConfig = {
  infoTypes: INFO_TYPES.map((name) => ({ name })),
  minLikelihood: "POSSIBLE" as const,
};

export async function scrubText<K extends string>(fields: Record<K, string>): Promise<ScrubTextResult<K>> {
  const entries = Object.entries(fields) as [K, string][];
  const results = await Promise.all(
    entries.map(([, value]) => (env().DLP_MODE === "local" ? scrubLocal(value) : scrubWithApi(value))),
  );
  return {
    fields: Object.fromEntries(entries.map(([key], i) => [key, results[i].text])) as Record<K, string>,
    findings: mergeFindings(results.flatMap((r) => r.findings)),
  };
}

export async function scrubFile(data: Buffer, mimeType: string): Promise<ScrubFileResult> {
  const byteType = IMAGE_TYPES[mimeType];
  if (!byteType) {
    return { data, findings: [], redacted: false, note: `${mimeType} files are not redacted; sent to Gemini on Vertex AI only.` };
  }
  if (env().DLP_MODE === "local") {
    return { data, findings: [], redacted: false, note: "Image redaction skipped (DLP_MODE=local)." };
  }
  const [res] = await dlp().redactImage({
    parent: parent(),
    inspectConfig: { ...inspectConfig, includeQuote: false },
    imageRedactionConfigs: INFO_TYPES.map((name) => ({ infoType: { name } })),
    byteItem: { type: byteType, data },
    includeFindings: true,
  });
  const counts = new Map<string, number>();
  for (const f of res.inspectResult?.findings ?? []) {
    const name = f.infoType?.name ?? "UNKNOWN";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return {
    data: res.redactedImage ? Buffer.from(res.redactedImage as Uint8Array) : data,
    findings: [...counts].map(([infoType, count]) => ({ infoType, count })),
    redacted: true,
  };
}

async function scrubWithApi(value: string): Promise<{ text: string; findings: DlpFinding[] }> {
  if (!value.trim()) return { text: value, findings: [] };
  const [res] = await dlp().deidentifyContent({
    parent: parent(),
    inspectConfig,
    deidentifyConfig: {
      infoTypeTransformations: {
        transformations: [{ primitiveTransformation: { replaceWithInfoTypeConfig: {} } }],
      },
    },
    item: { value },
  });
  const findings = (res.overview?.transformationSummaries ?? []).map((s) => ({
    infoType: s.infoType?.name ?? "UNKNOWN",
    count: (s.results ?? []).reduce((n, r) => n + Number(r.count ?? 0), 0),
  }));
  return { text: res.item?.value ?? value, findings: findings.filter((f) => f.count > 0) };
}

const LOCAL_PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "EMAIL_ADDRESS"],
  [/\b(?:\d[ -]?){13,19}\b/g, "CREDIT_CARD_NUMBER"],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g, "IBAN_CODE"],
  [/(?:\+\d{1,3}[\s-]?)?\(?\d{2,5}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, "PHONE_NUMBER"],
];

function scrubLocal(value: string): { text: string; findings: DlpFinding[] } {
  const findings: DlpFinding[] = [];
  let text = value;
  for (const [re, infoType] of LOCAL_PATTERNS) {
    let count = 0;
    text = text.replace(re, () => {
      count++;
      return `[${infoType}]`;
    });
    if (count) findings.push({ infoType, count });
  }
  return { text, findings };
}

export function mergeFindings(list: DlpFinding[]): DlpFinding[] {
  const counts = new Map<string, number>();
  for (const f of list) counts.set(f.infoType, (counts.get(f.infoType) ?? 0) + f.count);
  return [...counts].map(([infoType, count]) => ({ infoType, count }));
}
