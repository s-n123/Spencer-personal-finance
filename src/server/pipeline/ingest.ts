import { and, eq, sql } from "drizzle-orm";
import type { InboundMessage } from "@/server/channels/types";
import { getEnv } from "@/server/config/env";
import { inboundMessages, media } from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Db } from "@/server/db/types";
import type { Deps } from "@/server/deps";
import { log } from "@/server/log";
import { isValidTimeZone } from "@/server/time";
import { addMs, resolveTiming, sqlTs, toDate, type PipelineTiming } from "./lease";
import { writePriorityIntents } from "./priority";
import { matchExactKeyword, screenMessage } from "./screen";

// ingest() (PLAN §2.1 steps 3-8): one short DB-only transaction per message. The screen runs on
// the in-memory text before anything is stored; STOP pauses the user and the priority intents are
// written in the same transaction. A DB error propagates so the route answers 503 and the provider
// redelivers (D-043).

export type IngestResult =
  | { status: "accepted"; userId: string; inboundId: string; mediaIds: string[] }
  | { status: "duplicate"; userId: string; inboundId: string; rekick: boolean };

interface UserRef {
  id: string;
  consentedAt: Date | null;
}

export async function ingestMessage(
  deps: Deps,
  msg: InboundMessage,
  timing: PipelineTiming = resolveTiming(),
): Promise<IngestResult> {
  const screen = screenMessage(msg.text);

  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now();

    const existing = await findExisting(tx, msg);
    if (existing) return existing;

    const user = await upsertUser(tx, msg, now);
    const consented = user.consentedAt !== null;
    // Phrase hits (crisis, plain-language opt-outs) store only their tag, never the text (PLAN §2.1
    // step 4). M4 seam (D-086): before consent, text is kept only when the whole message is a
    // command, and no media rows or URLs are stored.
    const exactKeyword = msg.text !== null && matchExactKeyword(msg.text) !== null;
    const phraseHit = screen.crisisKind !== null || (screen.keyword !== null && !exactKeyword);
    const storeText = !phraseHit && (consented || exactKeyword);

    const inserted = await tx
      .insert(inboundMessages)
      .values({
        userId: user.id,
        provider: msg.provider,
        providerMessageId: msg.providerMessageId,
        toLine: msg.toLine,
        text: storeText ? msg.text : null,
        keyword: screen.keyword,
        crisisKind: screen.crisisKind,
        sentAt: msg.sentAt,
        receivedAt: now,
        status: "pending",
        preConsent: !consented,
        preConsentMediaCount: consented ? 0 : msg.media.length,
      })
      .onConflictDoNothing({ target: [inboundMessages.provider, inboundMessages.providerMessageId] })
      .returning({ id: inboundMessages.id });
    if (inserted.length === 0) {
      // A concurrent delivery of the same message won the insert.
      const dup = await findExisting(tx, msg);
      if (!dup) throw new Error("inbound insert conflicted but no row was found");
      return dup;
    }
    const inboundId = inserted[0].id;

    if (screen.keyword === "STOP") {
      // Keep the start of an ongoing pause so repeated STOPs share one confirmation.
      await tx.execute(
        sql`update users set messaging_paused_at = coalesce(messaging_paused_at, ${sqlTs(now)}), updated_at = ${sqlTs(now)}
            where id = ${user.id}`,
      );
    }

    let mediaIds: string[] = [];
    if (consented && msg.media.length > 0) {
      const rows = await tx
        .insert(media)
        .values(
          msg.media.map((m) => ({
            userId: user.id,
            inboundMessageId: inboundId,
            providerUrl: m.url,
            sourceContentType: m.mimeType ?? null,
            status: "pending",
          })),
        )
        .returning({ id: media.id });
      mediaIds = rows.map((r) => r.id);
    }

    await bumpDebounce(tx, user.id, now, timing);

    await writePriorityIntents(tx, {
      userId: user.id,
      inboundId,
      crisisKind: screen.crisisKind,
      stop: screen.keyword === "STOP",
      now,
    });

    // No crisis kind here: an inferred health category tied to a user id is consumer health data
    // (MHMDA) and doesn't belong in logs. It lives only on the row (and in safety_events from M4).
    log.info("inbound.accepted", {
      userId: user.id,
      inboundId,
      provider: msg.provider,
      count: msg.media.length,
      kind: screen.keyword ?? undefined,
    });
    return { status: "accepted", userId: user.id, inboundId, mediaIds };
  });
}

async function findExisting(tx: Db, msg: InboundMessage): Promise<IngestResult | null> {
  const [row] = await tx
    .select({ id: inboundMessages.id, userId: inboundMessages.userId, status: inboundMessages.status })
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.provider, msg.provider),
        eq(inboundMessages.providerMessageId, msg.providerMessageId),
      ),
    );
  if (!row) return null;
  // A redelivery of a message still in flight doubles as a free retry of its kick.
  const rekick = row.status === "pending" || row.status === "processing";
  log.info("inbound.duplicate", { userId: row.userId, inboundId: row.id, status: row.status });
  return { status: "duplicate", userId: row.userId, inboundId: row.id, rekick };
}

async function upsertUser(tx: Db, msg: InboundMessage, now: Date): Promise<UserRef> {
  // D-007: until M4's consent gate, simulator users are created as consented (never in production).
  const autoConsent = msg.provider === "simulator" && getEnv().VERCEL_ENV !== "production";
  // D-097: only the simulator supplies a timezone hint, and it never overrides one already set.
  const tzHint =
    msg.provider === "simulator" && msg.timezoneHint && isValidTimeZone(msg.timezoneHint) ? msg.timezoneHint : null;

  const rows = await selectRows<{ id: string; consented_at: unknown }>(
    tx,
    sql`insert into users (phone_e164, provider, line, status, consented_at, timezone, timezone_source, last_inbound_at, updated_at)
        values (${msg.fromE164}, ${msg.provider}, ${msg.toLine}, ${autoConsent ? "active" : "onboarding"},
                ${autoConsent ? sqlTs(now) : null}, ${tzHint}, ${tzHint ? "simulator" : null}, ${sqlTs(now)}, ${sqlTs(now)})
        on conflict (phone_e164) do update set
          provider = excluded.provider,
          line = coalesce(excluded.line, users.line),
          timezone = coalesce(users.timezone, excluded.timezone),
          timezone_source = case when users.timezone is null and excluded.timezone is not null
                                 then excluded.timezone_source else users.timezone_source end,
          last_inbound_at = excluded.last_inbound_at,
          updated_at = excluded.updated_at
        returning id, consented_at`,
  );
  const row = rows[0];
  return { id: row.id, consentedAt: row.consented_at == null ? null : toDate(row.consented_at) };
}

/**
 * Debounce from the newest message, capped per burst (PLAN §2.1 step 6). CLAIM clears
 * burst_started_at, so every burst gets its own cap.
 */
async function bumpDebounce(tx: Db, userId: string, now: Date, timing: PipelineTiming): Promise<void> {
  const debounced = sqlTs(addMs(now, timing.debounceMs));
  await tx.execute(
    sql`insert into user_turn_state (user_id, process_after, burst_started_at, updated_at)
        values (${userId}, ${debounced}, ${sqlTs(now)}, ${sqlTs(now)})
        on conflict (user_id) do update set
          burst_started_at = coalesce(user_turn_state.burst_started_at, ${sqlTs(now)}),
          process_after = least(
            greatest(user_turn_state.process_after, ${debounced}),
            coalesce(user_turn_state.burst_started_at, ${sqlTs(now)}) + (${timing.maxDebounceMs}::int * interval '1 millisecond')),
          updated_at = ${sqlTs(now)}`,
  );
}
