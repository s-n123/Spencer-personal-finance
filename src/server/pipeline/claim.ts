import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { inboundMessages, turns } from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Db } from "@/server/db/types";
import type { Deps } from "@/server/deps";
import type { ClaimedMessage } from "./contracts";
import { sqlTs, toDate, type LeaseHandle } from "./lease";

// CLAIM (PLAN §2.1 kick step 5). Gated on lease ownership AND process_after <= $now in one
// transaction: a message that lands between ACQUIRE and CLAIM pushes process_after forward, so the
// claim fails and the holder re-reads and waits for the rest of the burst.

export type TurnMode = "agent" | "onboarding" | "command" | "care" | "gated" | "safety" | "recovery";

export interface ClaimedTurn {
  id: string;
  /** Turn clock: max(sent_at) of the claimed messages. */
  clockAt: Date;
  mode: TurnMode;
  /** In message order (sent_at, then received_at). */
  messages: ClaimedMessage[];
}

export const claimedMessageColumns = {
  id: inboundMessages.id,
  provider: inboundMessages.provider,
  providerMessageId: inboundMessages.providerMessageId,
  text: inboundMessages.text,
  keyword: inboundMessages.keyword,
  crisisKind: inboundMessages.crisisKind,
  sentAt: inboundMessages.sentAt,
  receivedAt: inboundMessages.receivedAt,
};

export const messageOrder = [asc(inboundMessages.sentAt), asc(inboundMessages.receivedAt), asc(inboundMessages.id)];

export function turnClock(messages: ClaimedMessage[]): Date {
  return new Date(Math.max(...messages.map((m) => m.sentAt.getTime())));
}

export async function claimBurst(deps: Deps, lease: LeaseHandle): Promise<ClaimedTurn | null> {
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    // Locks the state row, so a concurrent ingest's debounce upsert waits for this claim to commit
    // and then starts a fresh burst (burst_started_at is cleared here).
    const gate = await selectRows<{ user_id: string }>(
      tx,
      sql`update user_turn_state set burst_started_at = null, updated_at = ${sqlTs(now)}
          where user_id = ${lease.userId} and lease_owner = ${lease.owner}
            and lease_expires_at > ${sqlTs(now)} and process_after <= ${sqlTs(now)}
          returning user_id`,
    );
    if (gate.length === 0) return null;

    const messages = await tx
      .select(claimedMessageColumns)
      .from(inboundMessages)
      .where(and(eq(inboundMessages.userId, lease.userId), eq(inboundMessages.status, "pending")))
      .orderBy(...messageOrder)
      .for("update");
    if (messages.length === 0) return null;

    const turn: ClaimedTurn = { id: randomUUID(), clockAt: turnClock(messages), mode: "agent", messages };
    await insertTurn(tx, lease.userId, turn, now);
    await tx
      .update(inboundMessages)
      .set({ status: "processing", turnId: turn.id })
      .where(
        inArray(
          inboundMessages.id,
          messages.map((m) => m.id),
        ),
      );
    return turn;
  });
}

export async function insertTurn(tx: Db, userId: string, turn: ClaimedTurn, now: Date): Promise<void> {
  await tx.insert(turns).values({
    id: turn.id,
    userId,
    status: "claimed",
    mode: turn.mode,
    clockAt: turn.clockAt,
    startedAt: now,
  });
}

export interface TurnStateView {
  processAfter: Date;
  leaseOwner: string | null;
  hasPending: boolean;
}

/** The holder loop's re-read: debounce deadline, lease owner, and whether anything is pending. */
export async function readTurnState(db: Db, userId: string): Promise<TurnStateView | null> {
  const rows = await selectRows<{ process_after: unknown; lease_owner: string | null; has_pending: boolean }>(
    db,
    sql`select s.process_after, s.lease_owner,
               exists (select 1 from inbound_messages m where m.user_id = s.user_id and m.status = 'pending') as has_pending
        from user_turn_state s where s.user_id = ${userId}`,
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { processAfter: toDate(r.process_after), leaseOwner: r.lease_owner, hasPending: Boolean(r.has_pending) };
}

export async function hasPendingMessages(db: Db, userId: string): Promise<boolean> {
  const rows = await selectRows<{ id: string }>(
    db,
    sql`select id from inbound_messages where user_id = ${userId} and status = 'pending' limit 1`,
  );
  return rows.length > 0;
}
