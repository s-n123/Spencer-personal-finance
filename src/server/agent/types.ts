import type Anthropic from "@anthropic-ai/sdk";

// The LLM contract. Real calls go through the beta Messages endpoint (needed for server-side
// refusal fallbacks); tests and the offline demo use a fake implementing the same interface.

export type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type Message = Anthropic.Beta.Messages.BetaMessage;
export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
export type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

export interface LlmCallOptions {
  /** Turn deadline / lease-loss signal. Also interrupts the SDK's retry-after sleeps. */
  signal: AbortSignal;
  timeoutMs: number;
  maxRetries: number;
}

/** Request params without the fields the client owns (betas, fallbacks). */
export type LlmRequest = Omit<MessageParams, "betas" | "fallbacks">;

export interface LlmClient {
  create(params: LlmRequest, opts: LlmCallOptions): Promise<Message>;
}
