// Provider-agnostic channel contract (SPEC Architecture 1). Everything provider-specific lives in
// src/server/channels/<provider>/; the rest of the app only sees these types.

export type Provider = "simulator" | "sendblue" | "linq" | "blooio";

export interface InboundMedia {
  url: string;
  mimeType?: string;
}

export interface InboundMessage {
  provider: Provider;
  /** Dedupe key (Sendblue: message_handle, one per attachment). */
  providerMessageId: string;
  /** Sender, normalized to E.164. */
  fromE164: string;
  /** Our line (E.164) the message was sent to, when the provider reports it. */
  toLine: string | null;
  text: string | null;
  media: InboundMedia[];
  /** Provider timestamp. */
  sentAt: Date;
  service?: "iMessage" | "SMS" | "RCS";
  providerConversationId?: string;
  /** IANA timezone hint (the simulator sends the browser's zone); used only if the user has none. */
  timezoneHint?: string;
}

export type IgnoredReason = "group" | "reaction" | "non_e164" | "outbound_echo" | "unknown";

export type NormalizedEvent =
  | { kind: "message"; message: InboundMessage }
  | { kind: "status"; providerMessageId: string; status: string }
  | { kind: "ignored"; reason: IgnoredReason };

export type SendStatus = "sent" | "unknown" | "opted_out" | "rate_limited" | "failed";

export interface SendResult {
  status: SendStatus;
  providerMessageId?: string;
  errorCode?: string;
}

export interface SendOptions {
  idempotencyKey: string;
  signal: AbortSignal;
}

export type Reaction = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export interface ChannelCapabilities {
  typing: boolean;
  reactions: boolean;
  readReceipts: boolean;
  outboundMedia: boolean;
}

export interface ChannelAdapter {
  readonly provider: Provider;
  readonly capabilities: ChannelCapabilities;
  /** Verifies authenticity of an inbound webhook request (constant-time comparisons). */
  verify(req: { rawBody: string; headers: Headers; url: URL }): Promise<boolean>;
  /** Parses a verified webhook body into normalized events. Never throws on unknown shapes. */
  parse(rawBody: string, headers: Headers): NormalizedEvent[];
  fetchMedia(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string | null }>;
  /**
   * Called once a media row no longer needs its source (stored, or failed for good), so an
   * adapter that staged the original can delete it. Best-effort; provider-hosted media needs none.
   */
  releaseMedia?(url: string): Promise<void>;
  sendText(from: string | null, to: string, text: string, opts: SendOptions): Promise<SendResult>;
  sendImage?(
    from: string | null,
    to: string,
    image: { bytes: Uint8Array; contentType: string },
    opts: SendOptions,
  ): Promise<SendResult>;
  /** Best-effort; failures are logged and never block a reply. */
  startTyping?(from: string | null, to: string): Promise<void>;
  stopTyping?(from: string | null, to: string): Promise<void>;
  react?(from: string | null, to: string, providerMessageId: string, reaction: Reaction): Promise<void>;
  /** Fetch a message back from the provider (consent/delete verification, M4/M6). */
  fetchMessage?(providerMessageId: string): Promise<{ text: string | null; fromE164: string } | null>;
  setOptOut?(to: string, optedOut: boolean): Promise<void>;
}

export interface AdapterRegistry {
  get(provider: Provider): ChannelAdapter;
}
