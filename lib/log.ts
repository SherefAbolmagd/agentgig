/**
 * One JSON object per line on stdout. Cloud Run forwards these to Cloud
 * Logging as structured entries; ERROR entries whose message holds a stack
 * trace are picked up by Error Reporting.
 */
type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export function log(severity: Severity, message: string, fields: Record<string, unknown> = {}) {
  const entry = { severity, message, ...fields, ...(process.env.K_REVISION && { revision: process.env.K_REVISION }) };
  const line = JSON.stringify(entry);
  if (severity === "ERROR") console.error(line);
  else console.log(line);
}

/** Logs an unexpected error with its stack so Error Reporting groups it. */
export function logError(err: unknown, fields: Record<string, unknown> = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  log("ERROR", e.stack ?? e.message, { ...fields, "@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent" });
}
