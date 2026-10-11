/**
 * Errors the gateway turns into HTTP responses. `code` is stable and safe to
 * show in the UI; `message` is plain English for the owner.
 */
export type GatewayErrorCode =
  | "UNAUTHENTICATED"
  | "USER_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_UNAVAILABLE"
  | "NOT_HIRED"
  | "INVALID_INPUT"
  | "INSUFFICIENT_TOKENS"
  | "AGENT_FAILED"
  | "AGENT_TIMEOUT"
  | "TASK_NOT_FOUND"
  | "ALREADY_SETTLED";

const HTTP_STATUS: Record<GatewayErrorCode, number> = {
  UNAUTHENTICATED: 401,
  USER_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  AGENT_UNAVAILABLE: 409,
  NOT_HIRED: 403,
  INVALID_INPUT: 400,
  INSUFFICIENT_TOKENS: 402,
  AGENT_FAILED: 502,
  AGENT_TIMEOUT: 504,
  TASK_NOT_FOUND: 404,
  ALREADY_SETTLED: 409,
};

export class GatewayError extends Error {
  readonly status: number;

  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = HTTP_STATUS[code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details && { details: this.details }) } };
  }
}

export function isGatewayError(err: unknown): err is GatewayError {
  return err instanceof GatewayError;
}
