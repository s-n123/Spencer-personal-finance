import type Anthropic from "@anthropic-ai/sdk";
import { policy } from "@/server/config/policy";
import type { TurnIterationUsage } from "@/server/db/schema";
import type { Deps } from "@/server/deps";
import { logError } from "@/server/errors";
import { LlmCallError, toLlmCallError } from "./errors";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { ContentBlockParam, LlmCallOptions, LlmRequest, Message, MessageParam, ToolUnion } from "./types";

// The model loop: one turn is one append-only messages array. It is tool-ready (M2 registers
// tools) but owns no product logic: it reports how the turn ended and turn.ts picks the reply.
// Never sent: temperature/top_p/top_k (400 on API 2026-10-21), forced tool_choice (400 on
// Sonnet 5.5), a thinking config (adaptive default; constant within the turn).

type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type ToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
export type ToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type Effort = Deps["models"]["mainEffort"];

/** Runs one iteration's tool calls and returns one tool_result per tool_use, in order (M2+). */
export type ToolExecutor = (calls: ToolUseBlock[], signal: AbortSignal) => Promise<ToolResultBlockParam[]>;

/** The max_tokens retry doubles up to this. Non-streaming calls must stay below the SDK's ~21,333. */
export const MAX_TOKENS_RETRY_CAP = 16_000;

export interface RequestSpec {
  model: string;
  effort: Effort;
  maxTokens: number;
  /** Opaque user UUID for metadata.user_id; never the phone number. */
  userId: string;
  tools: readonly ToolUnion[];
  messages: MessageParam[];
}

export function buildRequest(spec: RequestSpec): LlmRequest {
  const request: LlmRequest = {
    model: spec.model,
    max_tokens: spec.maxTokens,
    output_config: { effort: spec.effort },
    // 1 h breakpoints (tools, system) come before the 5 m automatic one, as the API requires.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }],
    // Automatic caching: a 5-minute breakpoint on the last cacheable block, so loop
    // iterations 2+ read the turn prefix.
    cache_control: { type: "ephemeral" },
    metadata: { user_id: spec.userId },
    messages: spec.messages,
  };
  if (spec.tools.length > 0) {
    request.tools = withLastToolCached(spec.tools);
    request.tool_choice = { type: "auto" };
  }
  return request;
}

export function withLastToolCached(tools: readonly ToolUnion[]): ToolUnion[] {
  const last = tools.length - 1;
  return tools.map((tool, i) => (i === last ? { ...tool, cache_control: { type: "ephemeral", ttl: "1h" } } : tool));
}

/**
 * Per-call budget from the invocation deadline (DECISIONS D-035). Returns null when too little is
 * left to make a call at all. The signal also cuts short the SDK's retry-after sleeps.
 */
export function callOptions(now: Date, deadlineMs: number, signal: AbortSignal): LlmCallOptions | null {
  const remaining = deadlineMs - now.getTime();
  const timeoutMs = Math.min(policy.agent.llmCallTimeoutMs, remaining - policy.agent.llmDeadlineMarginMs);
  if (timeoutMs <= 0) return null;
  return { signal, timeoutMs, maxRetries: remaining > policy.agent.llmRetryMinRemainingMs ? 1 : 0 };
}

export interface LoopInput extends Omit<RequestSpec, "messages"> {
  messages: MessageParam[];
  signal: AbortSignal;
  /** Invocation deadline (epoch ms). */
  deadlineMs: number;
  maxIterations: number;
  /** Absent when no tools are registered: a tool_use stop then ends the loop. */
  executeTools?: ToolExecutor;
}

export type LoopOutcome =
  | { kind: "text"; text: string }
  | { kind: "refusal"; category: string | null }
  | { kind: "max_tokens" }
  | { kind: "tool_unavailable" }
  | { kind: "iterations_exhausted" }
  | { kind: "error"; error: LlmCallError };

export interface LoopResult {
  outcome: LoopOutcome;
  /** stop_reason of the last response; null if none came back. */
  stopReason: string | null;
  usage: TurnIterationUsage[];
  /** The messages the final request was built from (append-only; never the final response). */
  transcript: MessageParam[];
}

/** Runs the model until it produces a final answer. Rethrows only when `signal` aborted. */
export async function runLoop(deps: Deps, input: LoopInput): Promise<LoopResult> {
  const messages = [...input.messages];
  const usage: TurnIterationUsage[] = [];
  let maxTokens = input.maxTokens;
  let truncationRetried = false;
  let stopReason: string | null = null;
  const done = (outcome: LoopOutcome): LoopResult => ({ outcome, stopReason, usage, transcript: [...messages] });

  for (let i = 0; i < input.maxIterations; i++) {
    input.signal.throwIfAborted();
    const opts = callOptions(deps.clock.now(), input.deadlineMs, input.signal);
    if (!opts) return done({ kind: "error", error: new LlmCallError("deadline", { retryable: false }) });

    const startedAt = deps.clock.now().getTime();
    let res: Message;
    try {
      // A snapshot, so later appends never alter a request already handed to the client.
      res = await deps.llm.create(buildRequest({ ...input, maxTokens, messages: [...messages] }), opts);
    } catch (err) {
      if (input.signal.aborted) throw err;
      return done({ kind: "error", error: mapUnlogged("agent.call_failed", err) });
    }
    stopReason = res.stop_reason;
    usage.push(iterationUsage(res, deps.clock.now().getTime() - startedAt));

    switch (res.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        return done(textOutcome(res.content));
      case "tool_use": {
        const calls = afterLastFallback(res.content).filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (calls.length === 0) return done(textOutcome(res.content));
        if (!input.executeTools || input.tools.length === 0) return done({ kind: "tool_unavailable" });
        messages.push({ role: "assistant", content: echoContent(res.content) });
        let results: ToolResultBlockParam[];
        try {
          results = await input.executeTools(calls, input.signal);
        } catch (err) {
          if (input.signal.aborted) throw err;
          return done({ kind: "error", error: mapUnlogged("agent.tools_failed", err) });
        }
        messages.push({ role: "user", content: results });
        continue;
      }
      case "pause_turn":
        messages.push({ role: "assistant", content: echoContent(res.content) });
        continue;
      case "refusal":
        // Partial output from a refused response is discarded, never shown.
        return done({ kind: "refusal", category: res.stop_details?.category ?? null });
      case "max_tokens":
        // Never run tools from a truncated response: a cut-off tool input can still parse.
        if (!truncationRetried && maxTokens < MAX_TOKENS_RETRY_CAP) {
          truncationRetried = true;
          maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_RETRY_CAP);
          continue;
        }
        return done({ kind: "max_tokens" });
      default:
        // model_context_window_exceeded, compaction (not used) or a missing stop reason.
        return done({ kind: "error", error: new LlmCallError("unexpected_stop", { retryable: false }) });
    }
  }
  return done({ kind: "iterations_exhausted" });
}

/**
 * LLM clients log their own failures and throw LlmCallError. Anything else (a tool executor's DB
 * error, a bug) would otherwise vanish into a canned reply, so it is logged here, sanitized.
 */
function mapUnlogged(event: string, err: unknown): LlmCallError {
  if (!(err instanceof LlmCallError)) logError(event, err);
  return toLlmCallError(err);
}

function textOutcome(content: ContentBlock[]): LoopOutcome {
  const text = finalText(content);
  return text ? { kind: "text", text } : { kind: "error", error: new LlmCallError("empty_reply", { retryable: false }) };
}

/**
 * The reply text: text blocks only (thinking and other blocks are skipped), from after the last
 * server-side fallback boundary. Adjacent text blocks are one passage; others are paragraphs.
 */
export function finalText(content: ContentBlock[]): string {
  const segments: string[] = [];
  let current = "";
  for (const block of afterLastFallback(content)) {
    if (block.type === "text") {
      current += block.text;
    } else if (current) {
      segments.push(current);
      current = "";
    }
  }
  if (current) segments.push(current);
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Assistant content to send back within this turn. After a mid-output fallback, thinking and
 * tool_use blocks before the last `fallback` block are omitted (Anthropic's echo rule); everything
 * else goes back unchanged, thinking blocks included.
 */
export function echoContent(content: ContentBlock[]): ContentBlockParam[] {
  const boundary = lastFallbackIndex(content);
  return content.filter(
    (b, i) => i >= boundary || !(b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use"),
  );
}

function lastFallbackIndex(content: ContentBlock[]): number {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === "fallback") return i;
  }
  return -1;
}

function afterLastFallback(content: ContentBlock[]): ContentBlock[] {
  return content.slice(lastFallbackIndex(content) + 1);
}

function iterationUsage(res: Message, latencyMs: number): TurnIterationUsage {
  return {
    latencyMs,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    stopReason: res.stop_reason,
  };
}
