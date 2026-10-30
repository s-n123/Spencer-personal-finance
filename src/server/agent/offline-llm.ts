import { CONTEXT_HEADER } from "./context";
import type { ContentBlockParam, LlmCallOptions, LlmClient, LlmRequest, Message, MessageParam } from "./types";

// Deterministic stand-in for the model (LLM_PROVIDER=fake, DECISIONS D-120). No network: it says
// what it received so the simulator → pipeline → reply loop can be tried without an API key.

const SETUP_HINT = "Live photo analysis needs an ANTHROPIC_API_KEY — set it in .env.local with LLM_PROVIDER=anthropic.";
const IMAGE_LABEL = /^img\d+:$/;

export class OfflineDemoLlm implements LlmClient {
  async create(params: LlmRequest, opts: LlmCallOptions): Promise<Message> {
    opts.signal.throwIfAborted();
    return offlineMessage(params.model, describeTurn(lastUserContent(params.messages)));
  }
}

export function describeTurn(content: ContentBlockParam[]): string {
  const photos: string[] = [];
  let hasNote = false;
  for (const block of content) {
    if (block.type === "image") {
      const size = block.source.type === "base64" ? jpegSize(block.source.data) : null;
      photos.push(size ? `${size.width}x${size.height}` : "unknown size");
    } else if (block.type === "text" && !block.text.startsWith(CONTEXT_HEADER) && !IMAGE_LABEL.test(block.text.trim())) {
      hasNote = hasNote || block.text.trim().length > 0;
    }
  }
  if (photos.length === 0) {
    return `I got your message. I'm the offline demo model, so I can't reply for real yet. ${SETUP_HINT}`;
  }
  const what = photos.length === 1 ? `1 photo (${photos[0]})` : `${photos.length} photos (${photos.join(", ")})`;
  return `I got ${what}${hasNote ? " and your note" : ""}. ${SETUP_HINT}`;
}

function lastUserContent(messages: MessageParam[]): ContentBlockParam[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    return typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
  }
  return [];
}

/** Reads width and height from a baseline or progressive JPEG's SOF segment. */
export function jpegSize(base64: string): { width: number; height: number } | null {
  const b = Buffer.from(base64, "base64");
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= b.length) return null;
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function offlineMessage(model: string, text: string): Message {
  return {
    id: "msg_offline_demo",
    type: "message",
    role: "assistant",
    model,
    container: null,
    context_management: null,
    diagnostics: null,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 0,
      iterations: null,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}
