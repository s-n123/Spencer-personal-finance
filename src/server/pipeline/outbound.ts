import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Provider, SendResult } from "@/server/channels/types";
import { outboundMessages } from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Db } from "@/server/db/types";
import type { Deps } from "@/server/deps";
import { logError } from "@/server/errors";
import { log } from "@/server/log";
import { leaseFence, resolveTiming, sqlTs, type LeaseHandle, type PipelineTiming } from "./lease";

// OutboundSender (PLAN §2.1 turn phases, §4). Replies are written as intents before any send and
// sent at most once: a conditional claim (intent -> sending) stops concurrent senders, and an
// ambiguous result becomes 'unknown', which is never resent (Sendblue has no idempotency key).

export type OutboundKind = "reply" | "proactive" | "command" | "onboarding" | "safety" | "priority";
export type OutboundStatus = "intent" | "sending" | "sent" | "unknown" | "suppressed" | "undeliverable" | "failed";

/** Kinds that still go out while the user is paused (crisis copy, STOP confirmation, commands). */
export const PAUSE_EXEMPT_KINDS: readonly OutboundKind[] = ["priority", "safety", "command"];

export function replyKey(anchorInboundId: string, seq: number): string {
  return `reply:${anchorInboundId}:${seq}`;
}

export interface ReplyIntentsInput {
  userId: string;
  turnId: string | null;
  /** The burst's anchor message; keys are reply:<anchor>:<i>, so re-runs can't duplicate. */
  anchorInboundId: string;
  bubbles: string[];
  kind: OutboundKind;
  lease: LeaseHandle;
}

export interface WriteIntentsResult {
  /** False when the lease was no longer ours; nothing was written. */
  fenced: boolean;
  inserted: number;
}

/** Inserts one intent per bubble, fenced on the lease (fence and insert share one snapshot). */
export async function writeReplyIntents(
  deps: Deps,
  input: ReplyIntentsInput,
  db: Db = deps.db,
): Promise<WriteIntentsResult> {
  const now = deps.clock.now();
  const fence = sql`select 1 from user_turn_state where user_id = ${input.lease.userId} and lease_owner = ${input.lease.owner} and lease_expires_at > ${sqlTs(now)}`;
  if (input.bubbles.length === 0) {
    const rows = await selectRows<{ ok: number }>(db, sql`${fence}`);
    return { fenced: rows.length > 0, inserted: 0 };
  }
  const values = sql.join(
    input.bubbles.map((text, i) => sql`(${i}::int, ${text}::text, ${replyKey(input.anchorInboundId, i)}::text)`),
    sql`, `,
  );
  const rows = await selectRows<{ fenced: unknown; inserted: unknown }>(
    db,
    sql`with fence as (${fence}),
        ins as (
          insert into outbound_messages (user_id, turn_id, kind, seq, text, idempotency_key, status)
          select ${input.userId}::uuid, ${input.turnId}::uuid, ${input.kind}, v.seq, v.text, v.key, 'intent'
          from (values ${values}) as v(seq, text, key)
          where exists (select 1 from fence)
          on conflict (idempotency_key) do nothing
          returning id)
        select (select count(*) from fence) as fenced, (select count(*) from ins) as inserted`,
  );
  return { fenced: Number(rows[0].fenced) > 0, inserted: Number(rows[0].inserted) };
}

export function mapSendStatus(status: SendResult["status"]): OutboundStatus {
  switch (status) {
    case "sent":
      return "sent";
    case "opted_out":
      return "undeliverable";
    case "failed":
    case "rate_limited":
      return "failed";
    case "unknown":
      return "unknown";
  }
}

export interface SendPendingOptions {
  /** Only these kinds (the priority path passes ['priority']). */
  kinds?: readonly OutboundKind[];
  /**
   * The lease holder's handle. Non-priority intents are then claimed only while the lease is still
   * ours, so a holder that lost its lease can't interleave sends with the new holder.
   */
  owner?: LeaseHandle;
  timing?: PipelineTiming;
}

export type SendSummary = Record<OutboundStatus | "skipped", number>;

function emptySummary(): SendSummary {
  return { intent: 0, sending: 0, sent: 0, unknown: 0, suppressed: 0, undeliverable: 0, failed: 0, skipped: 0 };
}

/** Sends every unsent intent for the user: priority first (crisis before STOP), then by age and seq. */
export async function sendPending(deps: Deps, userId: string, opts: SendPendingOptions = {}): Promise<SendSummary> {
  const kindFilter: SQL = opts.kinds
    ? sql`and kind in (${sql.join(
        opts.kinds.map((k) => sql`${k}`),
        sql`, `,
      )})`
    : sql``;
  const ids = await selectRows<{ id: string }>(
    deps.db,
    sql`select id from outbound_messages
        where user_id = ${userId} and status = 'intent' ${kindFilter}
        order by (kind = 'priority') desc, (idempotency_key like 'priority:%:crisis') desc, created_at, seq, id`,
  );
  const summary = emptySummary();
  for (const { id } of ids) {
    const status = await sendIntent(deps, id, opts);
    summary[status] += 1;
  }
  return summary;
}

interface ClaimedIntent {
  status: OutboundStatus;
  kind: OutboundKind;
  text: string | null;
  idempotency_key: string;
  user_id: string;
  phone_e164: string;
  provider: string;
  line: string | null;
}

/**
 * Claims one intent and sends it. The claim re-reads the user in the same statement: a paused
 * user's non-exempt intent becomes 'suppressed' instead of 'sending', and a deleted user's intent
 * no longer exists.
 */
export async function sendIntent(
  deps: Deps,
  outboundId: string,
  opts: { owner?: LeaseHandle; timing?: PipelineTiming } = {},
): Promise<OutboundStatus | "skipped"> {
  const timing = opts.timing ?? resolveTiming();
  const now = deps.clock.now();
  const exempt = sql.join(
    PAUSE_EXEMPT_KINDS.map((k) => sql`${k}`),
    sql`, `,
  );
  const ownerGate = opts.owner ? sql`and (o.kind = 'priority' or ${leaseFence(opts.owner, now)})` : sql``;
  const claimed = await selectRows<ClaimedIntent>(
    deps.db,
    sql`update outbound_messages o
        set status = case when u.messaging_paused_at is not null and o.kind not in (${exempt})
                          then 'suppressed' else 'sending' end,
            from_line = u.line
        from users u
        where o.id = ${outboundId} and o.status = 'intent' and u.id = o.user_id ${ownerGate}
        returning o.status, o.kind, o.text, o.idempotency_key, o.user_id, u.phone_e164, u.provider, u.line`,
  );
  if (claimed.length === 0) return "skipped";
  const row = claimed[0];
  if (row.status === "suppressed") {
    log.info("outbound.suppressed", { userId: row.user_id, outboundId, kind: row.kind, reason: "paused" });
    return "suppressed";
  }

  let result: SendResult;
  try {
    const adapter = deps.adapters.get(row.provider as Provider);
    if (!row.text) {
      result = { status: "failed", errorCode: "empty_text" };
    } else {
      result = await adapter.sendText(row.line, row.phone_e164, row.text, {
        idempotencyKey: row.idempotency_key,
        signal: AbortSignal.timeout(timing.perSendTimeoutMs),
      });
    }
  } catch (err) {
    // A throw or timeout is ambiguous: the provider may have sent it. Never auto-resent.
    logError("outbound.send_threw", err, { userId: row.user_id, outboundId, kind: row.kind });
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    result = { status: "unknown", errorCode: timedOut ? "timeout" : "send_threw" };
  }

  const status = mapSendStatus(result.status);
  await deps.db
    .update(outboundMessages)
    .set({
      status,
      providerMessageId: result.providerMessageId ?? null,
      errorCode: status === "sent" ? null : (result.errorCode ?? result.status).slice(0, 60),
      sentAt: status === "sent" ? deps.clock.now() : null,
    })
    .where(and(eq(outboundMessages.id, outboundId), eq(outboundMessages.status, "sending")));
  log.info("outbound.result", { userId: row.user_id, outboundId, kind: row.kind, status });
  return status;
}
