import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { AppError } from "@/server/errors";

// LLM failures reduced to what the loop acts on. The SDK error's message and body are dropped:
// only the kind, HTTP status and request ID survive, so nothing from a prompt can reach a log.

export type LlmErrorKind =
  | "spend_cap"
  | "rate_limited"
  | "overloaded"
  | "server"
  | "timeout"
  | "connection"
  | "aborted"
  | "auth"
  | "bad_request"
  | "billing"
  | "too_large"
  /** Not enough of the invocation deadline left to make a call. */
  | "deadline"
  /** The model finished without any text. */
  | "empty_reply"
  /** A stop reason the loop doesn't handle (model_context_window_exceeded, compaction, none). */
  | "unexpected_stop"
  | "unknown";

export class LlmCallError extends AppError {
  readonly kind: LlmErrorKind;
  /** Whether a later attempt could succeed. The spend cap holds until the next billing month. */
  readonly retryable: boolean;
  // Named `status` and `requestID` so sanitizeError() picks them up.
  readonly status: number | undefined;
  readonly requestID: string | undefined;

  constructor(kind: LlmErrorKind, opts: { retryable: boolean; status?: number; requestID?: string | null }) {
    super(`llm_${kind}`);
    this.name = "LlmCallError";
    this.kind = kind;
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.requestID = opts.requestID ?? undefined;
  }
}

/** The spend-cap 429 has `error.details.error_code` and no retry-after (docs/research/anthropic.md §8). */
export function isSpendCapError(err: RateLimitError): boolean {
  const body = asRecord(err.error);
  const inner = asRecord(body?.error);
  const details = asRecord(inner?.details) ?? asRecord(body?.details);
  return details?.error_code === "enforced_spend_limit_reached";
}

export function toLlmCallError(err: unknown): LlmCallError {
  if (err instanceof LlmCallError) return err;
  // Subclasses before their parents: APIUserAbortError and the connection errors extend APIError.
  if (err instanceof APIUserAbortError) return new LlmCallError("aborted", { retryable: false });
  if (err instanceof APIConnectionTimeoutError) return new LlmCallError("timeout", { retryable: true });
  if (err instanceof APIConnectionError) return new LlmCallError("connection", { retryable: true });
  if (err instanceof APIError) {
    const meta = { status: err.status, requestID: err.requestID };
    if (err instanceof RateLimitError) {
      return isSpendCapError(err)
        ? new LlmCallError("spend_cap", { retryable: false, ...meta })
        : new LlmCallError("rate_limited", { retryable: true, ...meta });
    }
    if (err instanceof InternalServerError) {
      const overloaded = err.status === 529 || err.type === "overloaded_error";
      return new LlmCallError(overloaded ? "overloaded" : "server", { retryable: true, ...meta });
    }
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
      return new LlmCallError("auth", { retryable: false, ...meta });
    }
    if (err instanceof BadRequestError) return new LlmCallError("bad_request", { retryable: false, ...meta });
    if (err.status === 402 || err.type === "billing_error") {
      return new LlmCallError("billing", { retryable: false, ...meta });
    }
    if (err.status === 413) return new LlmCallError("too_large", { retryable: false, ...meta });
    return new LlmCallError("unknown", { retryable: false, ...meta });
  }
  if (err instanceof Error && err.name === "AbortError") return new LlmCallError("aborted", { retryable: false });
  return new LlmCallError("unknown", { retryable: false });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
