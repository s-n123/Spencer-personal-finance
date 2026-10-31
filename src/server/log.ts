import { getEnv } from "@/server/config/env";

// Structured logging with an allowlist of fields. Message bodies, photos, phone numbers, blob
// keys, LLM prompts/outputs and raw provider payloads must never be logged (SPEC Safety; CLAUDE.md).
// Anything not on the allowlist is dropped, so a careless call site can't leak content.

const ALLOWED_FIELDS = new Set([
  "userId",
  "turnId",
  "inboundId",
  "outboundId",
  "mediaId",
  "provider",
  "kind",
  "mode",
  "status",
  "count",
  "attempt",
  "durationMs",
  "latencyMs",
  "bytes",
  "width",
  "height",
  "contentType",
  "iterations",
  "stopReason",
  "refusalCategory",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "requestId",
  "errorName",
  "errorCode",
  "sqlState",
  "constraint",
  "table",
  "route",
  "httpStatus",
  "reason",
  "phase",
  "method",
  "model",
]);

/**
 * Turn modes logged as "handled": 'safety' (and M4's 'care') next to a user id would record that
 * the user hit the crisis path (MHMDA consumer health data), so every deterministic reply, a STOP
 * included, looks the same in logs (D-130).
 */
const MASKED_MODES = new Set(["safety", "care", "command"]);

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function threshold(): number {
  try {
    return LEVELS[getEnv().LOG_LEVEL];
  } catch {
    return LEVELS.info;
  }
}

export function filterFields(fields: LogFields | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || !ALLOWED_FIELDS.has(key)) continue;
    if (key === "mode" && typeof value === "string" && MASKED_MODES.has(value)) {
      out[key] = "handled";
      continue;
    }
    // Strings are capped so an allowlisted field can't smuggle a message body.
    out[key] = typeof value === "string" ? value.slice(0, 120) : value;
  }
  return out;
}

function emit(level: Level, event: string, fields?: LogFields): void {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({ level, event, ...filterFields(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};
