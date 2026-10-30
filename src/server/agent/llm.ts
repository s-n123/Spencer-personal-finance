import Anthropic from "@anthropic-ai/sdk";
import { getEnv, type Env } from "@/server/config/env";
import { policy } from "@/server/config/policy";
import { logError } from "@/server/errors";
import { log } from "@/server/log";
import { toLlmCallError } from "./errors";
import { OfflineDemoLlm } from "./offline-llm";
import type { LlmCallOptions, LlmClient, LlmRequest, Message, MessageParams } from "./types";

// The real model client. Requests go through the beta endpoint so the server-side refusal fallback
// can be opted into (DECISIONS D-038); `fallbacks: "default"` needs exactly this header.

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Removed on API 2026-10-21 (400 on every model); stripped defensively before every call. */
const SAMPLING_PARAMS = ["temperature", "top_p", "top_k"] as const;

// One SDK client per process: it holds no per-request state, only the connection pool.
let sharedClient: Anthropic | undefined;

function anthropicClient(env: Env): Anthropic {
  sharedClient ??= new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Every call passes its own deadline-derived timeout and retry budget (D-035).
    timeout: policy.agent.llmCallTimeoutMs,
    maxRetries: 0,
    // D-036: no SDK spans, so no prompt or output can reach a trace exporter.
    openTelemetry: false,
  });
  return sharedClient;
}

/** The SDK surface AnthropicLlm uses; tests substitute a recorder. */
export interface BetaMessagesApi {
  create(
    body: MessageParams,
    options: { signal: AbortSignal; timeout: number; maxRetries: number },
  ): PromiseLike<Message>;
}

export class AnthropicLlm implements LlmClient {
  constructor(
    private readonly messages: BetaMessagesApi,
    private readonly fallbacks: boolean,
  ) {}

  async create(params: LlmRequest, opts: LlmCallOptions): Promise<Message> {
    const body: MessageParams & Partial<Record<(typeof SAMPLING_PARAMS)[number], unknown>> = this.fallbacks
      ? { ...params, betas: [FALLBACK_BETA], fallbacks: "default" }
      : { ...params };
    for (const key of SAMPLING_PARAMS) delete body[key];
    try {
      return await this.messages.create(body, {
        signal: opts.signal,
        timeout: opts.timeoutMs,
        maxRetries: opts.maxRetries,
      });
    } catch (err) {
      const mapped = toLlmCallError(err);
      if (mapped.kind === "aborted") {
        log.info("llm.call_aborted", { model: params.model });
      } else if (mapped.kind === "spend_cap") {
        // Holds until the next billing month; the SDK's own retry is the only one it gets.
        logError("llm.spend_cap_reached", mapped, { model: params.model });
      } else {
        logError("llm.call_failed", mapped, { model: params.model });
      }
      throw mapped;
    }
  }
}

/** LLM_PROVIDER=fake gives the deterministic offline model (DECISIONS D-120); otherwise the API. */
export function createLlmClient(env: Env = getEnv()): LlmClient {
  if (env.LLM_PROVIDER === "fake") return new OfflineDemoLlm();
  if (!env.ANTHROPIC_API_KEY) {
    log.warn("llm.api_key_missing", { reason: "set ANTHROPIC_API_KEY, or LLM_PROVIDER=fake for the offline demo" });
  }
  return new AnthropicLlm(anthropicClient(env).beta.messages, env.ANTHROPIC_FALLBACKS !== "off");
}
