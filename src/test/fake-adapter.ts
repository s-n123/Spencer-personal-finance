import { randomUUID } from "node:crypto";
import type {
  AdapterRegistry,
  ChannelAdapter,
  NormalizedEvent,
  Provider,
  SendOptions,
  SendResult,
} from "@/server/channels/types";

export interface SentMessage {
  from: string | null;
  to: string;
  text: string;
  idempotencyKey: string;
  at: number;
}

/** Records sends; can simulate provider opt-out blocks, failures and slow sends. */
export class FakeAdapter implements ChannelAdapter {
  readonly provider: Provider;
  readonly capabilities = { typing: true, reactions: false, readReceipts: false, outboundMedia: false };
  readonly sent: SentMessage[] = [];
  readonly typing: string[] = [];
  readonly media = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  /** URLs passed to releaseMedia, in order. */
  readonly released: string[] = [];
  /** Numbers whose sends return opted_out (simulates Sendblue blocking after STOP). */
  readonly optedOut = new Set<string>();
  /** Next N sends fail with this status. */
  failNext: { status: SendResult["status"]; count: number } | null = null;
  /** Called before each send resolves (lets tests interleave work mid-send). */
  onSend: ((msg: SentMessage) => Promise<void> | void) | null = null;

  constructor(provider: Provider = "simulator") {
    this.provider = provider;
  }

  async verify(): Promise<boolean> {
    return true;
  }

  parse(rawBody: string): NormalizedEvent[] {
    return JSON.parse(rawBody) as NormalizedEvent[];
  }

  async fetchMedia(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const item = this.media.get(url);
    if (!item) throw new Error("fake media not found");
    return item;
  }

  async releaseMedia(url: string): Promise<void> {
    this.released.push(url);
  }

  async sendText(from: string | null, to: string, text: string, opts: SendOptions): Promise<SendResult> {
    if (opts.signal.aborted) throw opts.signal.reason;
    const msg: SentMessage = { from, to, text, idempotencyKey: opts.idempotencyKey, at: Date.now() };
    await this.onSend?.(msg);
    if (this.optedOut.has(to)) return { status: "opted_out", errorCode: "OPTED_OUT" };
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count -= 1;
      return { status: this.failNext.status, errorCode: "FAKE_FAILURE" };
    }
    this.sent.push(msg);
    return { status: "sent", providerMessageId: randomUUID() };
  }

  async startTyping(_from: string | null, to: string): Promise<void> {
    this.typing.push(to);
  }

  textsTo(to: string): string[] {
    return this.sent.filter((m) => m.to === to).map((m) => m.text);
  }
}

export function registryOf(...adapters: ChannelAdapter[]): AdapterRegistry {
  const map = new Map(adapters.map((a) => [a.provider, a]));
  return {
    get(provider) {
      const a = map.get(provider);
      if (!a) throw new Error(`no adapter for ${provider}`);
      return a;
    },
  };
}
