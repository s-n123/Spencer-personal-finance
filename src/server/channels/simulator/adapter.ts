import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ChannelAdapter, NormalizedEvent, SendOptions, SendResult } from "@/server/channels/types";
import type { Db } from "@/server/db/types";
import { AppError } from "@/server/errors";
import type { MediaStorage } from "@/server/media/storage/types";
import { systemClock, type Clock } from "@/server/time";

// The dev-only channel behind /dev/chat (PLAN §3). Uploads are staged in storage under
// sim-inbox/<uuid> and referenced by a sim-inbox:<uuid> URL, so the media pipeline downloads them
// through fetchMedia exactly as it would a provider URL. Sends need no transport: the outbound row
// the pipeline writes is what the page shows. Typing indicators go to simulator_events.

const SIM_INBOX_PREFIX = "sim-inbox/";
const SIM_URL = /^sim-inbox:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The storage contract derives content types from key extensions; staged uploads have none. */
export const SIM_INBOX_CONTENT_TYPE = "application/octet-stream";

export function simInboxKey(uploadId: string): string {
  return `${SIM_INBOX_PREFIX}${uploadId}`;
}

export function simInboxUrl(uploadId: string): string {
  return `sim-inbox:${uploadId}`;
}

export function simInboxPrefix(): string {
  return SIM_INBOX_PREFIX;
}

export class SimulatorAdapter implements ChannelAdapter {
  readonly provider = "simulator" as const;
  readonly capabilities = { typing: true, reactions: false, readReceipts: false, outboundMedia: false };

  constructor(
    private readonly db: Db,
    private readonly storage: MediaStorage,
    private readonly clock: Clock = systemClock,
  ) {}

  // The simulator routes are guarded by simulatorEnabled() and the fictional-number check instead.
  async verify(): Promise<boolean> {
    return true;
  }

  // The simulator route builds InboundMessage objects directly; there is no webhook body.
  parse(): NormalizedEvent[] {
    return [];
  }

  async fetchMedia(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const match = SIM_URL.exec(url);
    if (!match) throw new AppError("sim_media_bad_url");
    signal.throwIfAborted();
    const obj = await this.storage.get(simInboxKey(match[1]));
    if (!obj) throw new AppError("sim_media_not_found");
    // The upload's declared type travels on InboundMedia.mimeType; the pipeline sniffs the bytes.
    return { bytes: obj.bytes, contentType: obj.contentType === SIM_INBOX_CONTENT_TYPE ? null : obj.contentType };
  }

  async sendText(_from: string | null, _to: string, _text: string, opts: SendOptions): Promise<SendResult> {
    opts.signal.throwIfAborted();
    return { status: "sent", providerMessageId: randomUUID() };
  }

  async startTyping(_from: string | null, to: string): Promise<void> {
    await this.typingEvent(to, "typing_start");
  }

  async stopTyping(_from: string | null, to: string): Promise<void> {
    await this.typingEvent(to, "typing_stop");
  }

  private async typingEvent(to: string, type: "typing_start" | "typing_stop"): Promise<void> {
    // created_at comes from the injected clock so the thread's typing window uses the same time base.
    await this.db.execute(
      sql`insert into simulator_events (user_id, type, created_at)
          select id, ${type}, ${this.clock.now().toISOString()}::timestamptz from users
          where phone_e164 = ${to} and provider = 'simulator'`,
    );
  }
}
