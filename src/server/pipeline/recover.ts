import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { inboundMessages, turns } from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Deps } from "@/server/deps";
import { log } from "@/server/log";
import { claimedMessageColumns, insertTurn, messageOrder, type ClaimedTurn, type TurnMode } from "./claim";
import { holdsLease, LeaseLostError, leaseFence } from "./lease";
import { replyKey, sendPending } from "./outbound";
import { failTurn, finishTurn, runTurn, type TurnContext } from "./router";

// Orphaned-turn recovery (PLAN §2.1 turn semantics; D-044). Runs right after ACQUIRE: every live
// turn holds the lease, so any unfinished turn of this user belongs to a holder that died or
// stalled (and is now fenced out). Sends are at most once, so a turn is re-run only when nothing
// of it was committed, and only once.

const OPEN_TURN_STATUSES = ["claimed", "effects_committed", "reply_written"];

export async function recoverOrphanedTurns(deps: Deps, ctx: TurnContext): Promise<number> {
  const userId = ctx.lease.userId;
  const orphans = await deps.db
    .select({ id: turns.id, status: turns.status, mode: turns.mode, clockAt: turns.clockAt })
    .from(turns)
    .where(and(eq(turns.userId, userId), inArray(turns.status, OPEN_TURN_STATUSES)))
    .orderBy(asc(turns.createdAt), asc(turns.id));

  for (const orphan of orphans) {
    const mode = orphan.mode as TurnMode;
    log.info("turn.recovering", { userId, turnId: orphan.id, status: orphan.status, mode });
    const rows = await processingRows(deps, orphan.id);
    // A START confirmation is written before the agent runs and doesn't commit the turn: the re-run
    // repeats it idempotently (applyStart is, and the intent key dedupes).
    const confirmations = rows.filter((r) => r.keyword === "START").map((r) => sql`${replyKey(r.id, 0)}`);
    const [{ total }] = await selectRows<{ total: unknown }>(
      deps.db,
      sql`select count(*) as total from outbound_messages where turn_id = ${orphan.id}
          ${confirmations.length > 0 ? sql`and idempotency_key not in (${sql.join(confirmations, sql`, `)})` : sql``}`,
    );

    if (Number(total) > 0 || orphan.status !== "claimed") {
      await closeCommitted(deps, ctx, orphan.id, mode);
      continue;
    }

    const turn: ClaimedTurn = { id: orphan.id, clockAt: orphan.clockAt, mode, messages: rows };
    if (mode === "recovery") {
      // Already re-run once and orphaned again: stop retrying and tell the user.
      await failTurn(deps, ctx, turn, rows, "orphaned_twice");
      continue;
    }
    const rerun = await moveToRecoveryTurn(deps, ctx, turn);
    if (rerun === "committed_meanwhile") {
      // The stalled holder's last transaction passed its fence before our takeover and committed
      // after our read: the turn is committed now, so it is finished, never re-run.
      await closeCommitted(deps, ctx, orphan.id, mode);
    } else if (rerun) {
      await runTurn(deps, ctx, rerun);
    }
  }
  return orphans.length;
}

/**
 * Something of the turn was committed: send what is still unsent and close it; never re-run it.
 * (M2 adds the deterministic recap for effects committed without a reply.)
 */
async function closeCommitted(deps: Deps, ctx: TurnContext, turnId: string, mode: TurnMode): Promise<void> {
  const [current] = await deps.db.select({ status: turns.status }).from(turns).where(eq(turns.id, turnId));
  if (!current || !OPEN_TURN_STATUSES.includes(current.status)) return;
  await sendPending(deps, ctx.lease.userId, { owner: ctx.lease, timing: ctx.timing });
  const rows = await processingRows(deps, turnId);
  await finishTurn(deps, ctx, { id: turnId, mode }, { done: rows.map((r) => r.id), ignored: [], failed: [] }, mode, "done");
}

function processingRows(deps: Deps, turnId: string) {
  return deps.db
    .select(claimedMessageColumns)
    .from(inboundMessages)
    .where(and(eq(inboundMessages.turnId, turnId), eq(inboundMessages.status, "processing")))
    .orderBy(...messageOrder);
}

/**
 * Fails the orphan and moves its rows to a fresh 'recovery' turn, fenced, in one transaction.
 * Returns null when it had no rows, or "committed_meanwhile" when the orphan moved past 'claimed'
 * after we read it.
 */
async function moveToRecoveryTurn(
  deps: Deps,
  ctx: TurnContext,
  orphan: ClaimedTurn,
): Promise<ClaimedTurn | null | "committed_meanwhile"> {
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const fence = leaseFence(ctx.lease, now);
    const closed = await tx
      .update(turns)
      .set({ status: "failed", errorCode: "orphaned", finishedAt: now })
      .where(and(eq(turns.id, orphan.id), eq(turns.status, "claimed"), fence))
      .returning({ id: turns.id });
    if (closed.length === 0) {
      if (!(await holdsLease(tx, ctx.lease, now))) throw new LeaseLostError();
      return "committed_meanwhile";
    }
    if (orphan.messages.length === 0) return null;

    const turn: ClaimedTurn = { id: randomUUID(), clockAt: orphan.clockAt, mode: "recovery", messages: [] };
    await insertTurn(tx, ctx.lease.userId, turn, now);
    const moved = await tx
      .update(inboundMessages)
      .set({ turnId: turn.id })
      .where(and(eq(inboundMessages.turnId, orphan.id), eq(inboundMessages.status, "processing"), fence))
      .returning({ id: inboundMessages.id });
    // This last write must be checked too: a takeover between statements would otherwise commit
    // the orphan's closure without its rows, stranding them in 'processing' for good.
    if (moved.length === 0) throw new LeaseLostError();
    const movedIds = new Set(moved.map((r) => r.id));
    return { ...turn, messages: orphan.messages.filter((m) => movedIds.has(m.id)) };
  });
}
