import { log, type LogFields } from "@/server/log";

// Errors are reduced to non-content metadata before logging. DrizzleQueryError.message embeds every
// bound parameter, and pg errors carry "Failing row contains (...)" and "Key (phone_e164)=(...)" in
// `detail`, so message, detail, params and cause are never logged.

export interface SanitizedError extends LogFields {
  errorName: string;
  errorCode?: string;
  sqlState?: string;
  constraint?: string;
  table?: string;
  httpStatus?: number;
  requestId?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function pgFields(err: unknown): Partial<SanitizedError> {
  if (!err || typeof err !== "object") return {};
  const e = err as Record<string, unknown>;
  const out: Partial<SanitizedError> = {};
  if (typeof e.code === "string" && SQLSTATE.test(e.code)) out.sqlState = e.code;
  if (typeof e.constraint === "string") out.constraint = e.constraint.slice(0, 80);
  if (typeof e.table === "string") out.table = e.table.slice(0, 80);
  return out;
}

export function sanitizeError(err: unknown): SanitizedError {
  if (!(err instanceof Error)) {
    return { errorName: typeof err };
  }
  const result: SanitizedError = { errorName: err.name || "Error" };
  // Drizzle wraps the driver error in `cause`; take only structured fields from either level.
  Object.assign(result, pgFields((err as { cause?: unknown }).cause), pgFields(err));
  const anyErr = err as unknown as Record<string, unknown>;
  if (typeof anyErr.status === "number") result.httpStatus = anyErr.status;
  if (typeof anyErr.requestID === "string") result.requestId = anyErr.requestID;
  if (typeof anyErr.errorCode === "string") result.errorCode = anyErr.errorCode.slice(0, 60);
  return result;
}

/** Logs an error with only sanitized fields. */
export function logError(event: string, err: unknown, fields?: LogFields): void {
  log.error(event, { ...fields, ...sanitizeError(err) });
}

/** An error whose message is safe to show/log: it never carries user content. */
export class AppError extends Error {
  constructor(
    public readonly errorCode: string,
    message?: string,
  ) {
    super(message ?? errorCode);
    this.name = "AppError";
  }
}
