import type { NormalizedEvent } from "@/server/channels/types";
import type { Deps } from "@/server/deps";
import { log } from "@/server/log";
import type { Sleeper } from "@/server/time";
import { ingestMessage } from "./ingest";
import { kick } from "./kick";
import { resolveTiming, type PipelineTiming } from "./lease";

// Entry point for webhook and simulator routes: ingest each event, then schedule kicks on
// deps.runner (after() in production). Group chats, tapbacks, status callbacks and non-E.164
// handles are acknowledged and only counted (D-047). A DB error propagates: the route returns 503
// and the provider redelivers, which dedupe makes safe.

export interface InboundSummary {
  accepted: number;
  duplicates: number;
  ignored: number;
}

export interface HandleInboundOptions {
  timing?: Partial<PipelineTiming>;
  heartbeatSleeper?: Sleeper;
}

const E164 = /^\+[1-9]\d{7,14}$/;

export async function handleInboundEvents(
  deps: Deps,
  events: NormalizedEvent[],
  opts: HandleInboundOptions = {},
): Promise<InboundSummary> {
  const timing = resolveTiming(opts.timing);
  const summary: InboundSummary = { accepted: 0, duplicates: 0, ignored: 0 };
  // One kick per user per call, carrying the media this call stored for prefetch.
  const kicks = new Map<string, string[]>();
  try {
    for (const event of events) {
      if (event.kind !== "message" || !E164.test(event.message.fromE164)) {
        summary.ignored += 1;
        log.info("inbound.ignored", {
          kind: event.kind,
          reason: event.kind === "ignored" ? event.reason : event.kind === "message" ? "non_e164" : undefined,
        });
        continue;
      }
      const result = await ingestMessage(deps, event.message, timing);
      if (result.status === "accepted") {
        summary.accepted += 1;
        kicks.set(result.userId, [...(kicks.get(result.userId) ?? []), ...result.mediaIds]);
      } else {
        summary.duplicates += 1;
        if (result.rekick && !kicks.has(result.userId)) kicks.set(result.userId, []);
      }
    }
  } finally {
    // Messages committed before a failure still get their kick.
    for (const [userId, ownMediaIds] of kicks) {
      deps.runner.run("kick", async () => {
        await kick(deps, userId, { ownMediaIds, timing: opts.timing, heartbeatSleeper: opts.heartbeatSleeper });
      });
    }
  }
  return summary;
}
