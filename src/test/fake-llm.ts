import type { LlmCallOptions, LlmClient, LlmRequest, Message } from "@/server/agent/types";

type Scripted = Message | ((req: LlmRequest) => Message) | Error;

/** Scripted LLM: returns queued responses in order and records every request. */
export class ScriptedLlm implements LlmClient {
  readonly requests: { params: LlmRequest; opts: LlmCallOptions }[] = [];
  private readonly queue: Scripted[] = [];

  push(...items: Scripted[]): this {
    this.queue.push(...items);
    return this;
  }

  async create(params: LlmRequest, opts: LlmCallOptions): Promise<Message> {
    this.requests.push({ params, opts });
    if (opts.signal.aborted) throw opts.signal.reason;
    const next = this.queue.shift();
    if (!next) return textMessage("ok");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(params) : next;
  }
}

/** Builds a minimal BetaMessage with text content. */
export function textMessage(text: string, stopReason: Message["stop_reason"] = "end_turn"): Message {
  return {
    id: `msg_fake_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Message;
}
