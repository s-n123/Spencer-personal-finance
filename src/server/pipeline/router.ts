import { and, eq, inArray, sql } from "drizzle-orm";
import type { Provider } from "@/server/channels/types";
import { getEnv } from "@/server/config/env";
import { inboundMessages, media, turns, users } from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Deps } from "@/server/deps";
import { AppError, logError, sanitizeError } from "@/server/errors";
import { log } from "@/server/log";
import { fireAndForget } from "@/server/safe";
import { START_CONFIRMATION, TURN_FAILED_REPLY } from "@/server/safety/copy";
import { isValidTimeZone } from "@/server/time";
import type { ClaimedTurn, TurnMode } from "./claim";
import type { AgentTurnOutput, ClaimedMessage, UserRow } from "./contracts";
import { LeaseLostError, leaseFence, sqlTs, type LeaseHandle, type PipelineTiming } from "./lease";
import { sendPending, writeReplyIntents, type OutboundKind } from "./outbound";

// TurnRouter (PLAN §2.2) for one claimed burst. The order is a safety property: rows the priority
// path already answered -> commands -> (M4: onboarding, triage/care; M7: access gate) -> agent.
// Every write here is fenced on the lease; a fence miss throws LeaseLostError and the new holder's
// recovery takes the turn over.

export interface TurnContext {
  lease: LeaseHandle;
  /** Aborts when the lease is lost. */
  signal: AbortSignal;
  /** Invocation deadline (epoch ms). */
  deadlineMs: number;
  timing: PipelineTiming;
  /** Renews the lease at a checkpoint, or throws LeaseLostError. */
  checkpoint(): Promise<void>;
}

export interface TurnResult {
  mode: TurnMode;
  status: "done" | "failed";
}

interface RowOutcomes {
  done: string[];
  ignored: string[];
  failed: string[];
}

export async function runTurn(deps: Deps, ctx: TurnContext, turn: ClaimedTurn): Promise<TurnResult> {
  const userId = ctx.lease.userId;
  const rows = turn.messages;
  const outcome: RowOutcomes = { done: [], ignored: [], failed: [] };

  // 1. Answered by the priority path at ingest (crisis copy, the STOP confirmation).
  for (const r of rows) if (r.crisisKind || r.keyword === "STOP") outcome.done.push(r.id);
  const hasCrisis = rows.some((r) => r.crisisKind !== null);
  const hasStop = rows.some((r) => r.keyword === "STOP");

  // 2. Commands, in message order. M1 implements START; the other keywords reach the agent (M4).
  for (const r of rows) {
    if (r.keyword !== "START" || r.crisisKind) continue;
    if (await applyStart(deps, ctx, r)) {
      await commitReply(deps, ctx, turn, { anchor: r.id, bubbles: [START_CONFIRMATION], kind: "command" });
      outcome.done.push(r.id);
    } else {
      outcome.ignored.push(r.id);
    }
  }

  const user = await loadUser(deps, userId);
  const rest = rows.filter((r) => !r.crisisKind && r.keyword !== "STOP" && r.keyword !== "START");

  let mode: TurnMode;
  if (!user) mode = "command";
  else if (hasCrisis) mode = "safety";
  else if (hasStop || user.messagingPausedAt) mode = "command";
  else if (!user.consentedAt) mode = "onboarding";
  else if (rest.length === 0) mode = "command";
  else mode = "agent";

  if (mode !== "agent" || !user) {
    // A crisis burst ends here (no agent, no totals); a paused user's ordinary messages are ignored.
    outcome.ignored.push(...rest.map((r) => r.id));
    if (mode === "onboarding" && rest.length > 0) {
      // M4 replaces this with the age and consent prompts.
      log.info("turn.onboarding_pending", { userId, turnId: turn.id, count: rest.length });
    }
    if (user) await sendPending(deps, userId, { owner: ctx.lease, timing: ctx.timing });
    await finishTurn(deps, ctx, turn, outcome, mode, "done");
    return { mode, status: "done" };
  }

  let output: AgentTurnOutput;
  try {
    output = await runAgentStep(deps, ctx, turn, user, rest);
  } catch (err) {
    if (err instanceof LeaseLostError) throw err;
    if (ctx.signal.aborted) throw new LeaseLostError();
    logError("turn.failed", err, { userId, turnId: turn.id });
    const sanitized = sanitizeError(err);
    const errorCode = (sanitized.errorCode ?? sanitized.errorName).slice(0, 60);
    await failTurn(deps, ctx, turn, rest, errorCode, outcome);
    return { mode: "agent", status: "failed" };
  }
  // From here the reply is committed: a failure leaves the turn reply_written, and recovery sends
  // whatever is unsent without re-running it.
  await sendPending(deps, userId, { owner: ctx.lease, timing: ctx.timing });
  outcome.done.push(...rest.map((r) => r.id));
  await finishTurn(deps, ctx, turn, outcome, output.mode, "done");
  return { mode: output.mode, status: "done" };
}

async function runAgentStep(
  deps: Deps,
  ctx: TurnContext,
  turn: ClaimedTurn,
  user: UserRow,
  rest: ClaimedMessage[],
): Promise<AgentTurnOutput> {
  startTyping(deps, user);
  await ctx.checkpoint();
  const ready = await deps.pipeline.ensureMedia(
    deps,
    rest.map((r) => r.id),
    ctx.signal,
  );
  await ctx.checkpoint();
  const output = await deps.pipeline.runAgent(deps, {
    user,
    turnId: turn.id,
    turnClock: turn.clockAt,
    timezone: effectiveTimezone(user),
    messages: rest,
    images: ready.ready,
    failedImageCount: ready.failed.length,
    signal: ctx.signal,
    deadlineMs: ctx.deadlineMs,
  });
  if (ctx.signal.aborted) throw new LeaseLostError();
  await ctx.checkpoint();
  const bubbles = output.bubbles.map((b) => b.trim()).filter((b) => b.length > 0);
  // Nothing to send would leave the user unanswered; the caller turns this into the apology.
  if (bubbles.length === 0) throw new AppError("empty_reply");
  await commitReply(deps, ctx, turn, {
    anchor: rest[rest.length - 1].id,
    bubbles,
    // A refusal is the agent's reply, not crisis copy: it stays pause-checked so a STOP sent
    // during the model call still suppresses it. The turn's 'safety' mode (set at commit) keeps it
    // out of history.
    kind: "reply",
    agent: output,
  });
  return output;
}

/** Writes reply intents and moves the turn to reply_written, atomically and fenced. */
async function commitReply(
  deps: Deps,
  ctx: TurnContext,
  turn: ClaimedTurn,
  reply: { anchor: string; bubbles: string[]; kind: OutboundKind; agent?: AgentTurnOutput },
): Promise<void> {
  const userId = ctx.lease.userId;
  await deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const fence = leaseFence(ctx.lease, now);
    for (const s of reply.agent?.mediaSummaries ?? []) {
      await tx
        .update(media)
        .set({ summary: s.summary, kind: s.kind, updatedAt: now })
        .where(and(eq(media.id, s.mediaId), eq(media.userId, userId), fence));
    }
    const written = await writeReplyIntents(
      deps,
      { userId, turnId: turn.id, anchorInboundId: reply.anchor, bubbles: reply.bubbles, kind: reply.kind, lease: ctx.lease },
      tx,
    );
    if (!written.fenced) throw new LeaseLostError();
    const agentFields = reply.agent
      ? {
          iterations: reply.agent.usage.length,
          usage: reply.agent.usage,
          stopReason: reply.agent.stopReason,
          ...(reply.agent.mode === "safety" ? { mode: "safety" as const } : {}),
        }
      : {};
    const updated = await tx
      .update(turns)
      .set({ status: "reply_written", ...agentFields })
      .where(and(eq(turns.id, turn.id), fence))
      .returning({ id: turns.id });
    if (updated.length === 0) throw new LeaseLostError();
  });
}

/** Closes the turn: row statuses plus the turn's final status and mode, fenced. */
export async function finishTurn(
  deps: Deps,
  ctx: { lease: LeaseHandle },
  turn: Pick<ClaimedTurn, "id" | "mode">,
  rows: RowOutcomes,
  mode: TurnMode,
  status: "done" | "failed",
  errorCode: string | null = null,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const fence = leaseFence(ctx.lease, now);
    const groups = [
      [rows.done, "done"],
      [rows.ignored, "ignored"],
      [rows.failed, "failed"],
    ] as const;
    for (const [ids, rowStatus] of groups) {
      if (ids.length === 0) continue;
      await tx
        .update(inboundMessages)
        .set({ status: rowStatus })
        .where(
          and(
            inArray(inboundMessages.id, [...ids]),
            eq(inboundMessages.turnId, turn.id),
            eq(inboundMessages.status, "processing"),
            fence,
          ),
        );
    }
    const updated = await tx
      .update(turns)
      .set({ status, mode: turn.mode === "recovery" ? "recovery" : mode, finishedAt: now, errorCode })
      .where(and(eq(turns.id, turn.id), fence))
      .returning({ id: turns.id });
    if (updated.length === 0) throw new LeaseLostError();
  });
}

/** A turn that failed after its claim still answers, so the user isn't left hanging. */
export async function failTurn(
  deps: Deps,
  ctx: TurnContext,
  turn: ClaimedTurn,
  failedRows: ClaimedMessage[],
  errorCode: string,
  outcome: RowOutcomes = { done: [], ignored: [], failed: [] },
): Promise<void> {
  if (failedRows.length > 0) {
    await commitReply(deps, ctx, turn, {
      anchor: failedRows[failedRows.length - 1].id,
      bubbles: [TURN_FAILED_REPLY],
      kind: "reply",
    });
  }
  await sendPending(deps, ctx.lease.userId, { owner: ctx.lease, timing: ctx.timing });
  await finishTurn(
    deps,
    ctx,
    turn,
    { ...outcome, failed: [...outcome.failed, ...failedRows.map((r) => r.id)] },
    turn.mode,
    "failed",
    errorCode,
  );
}

/**
 * START resumes replies unless a STOP sent after it supersedes it (e.g. [START, STOP] in one
 * burst). Returns whether the user is now unpaused.
 */
async function applyStart(deps: Deps, ctx: TurnContext, row: ClaimedMessage): Promise<boolean> {
  const userId = ctx.lease.userId;
  const resumed = await deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    // Lock the user row first, so the STOP check runs on a snapshot taken after any in-flight STOP
    // ingest (which holds this row) has committed. A bare UPDATE would wait for it too, but then
    // re-check only the user row and miss the new STOP row, unpausing a user who just opted out.
    await tx.execute(sql`select 1 from users where id = ${userId} for update`);
    const res = await selectRows<{ resumed: boolean }>(
      tx,
      sql`update users set
            messaging_paused_at = case when exists (
                select 1 from inbound_messages m
                where m.user_id = ${userId} and m.keyword = 'STOP'
                  and (m.sent_at, m.received_at) > (${sqlTs(row.sentAt)}, ${sqlTs(row.receivedAt)}))
              then messaging_paused_at else null end,
            updated_at = ${sqlTs(now)}
          where id = ${userId} and ${leaseFence(ctx.lease, now)}
          returning messaging_paused_at is null as resumed`,
    );
    if (res.length === 0) throw new LeaseLostError();
    return Boolean(res[0].resumed);
  });
  log.info("turn.command", { userId, inboundId: row.id, kind: "START", status: resumed ? "resumed" : "superseded" });
  return resumed;
}

async function loadUser(deps: Deps, userId: string): Promise<UserRow | null> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}

export function effectiveTimezone(user: Pick<UserRow, "timezone">): string {
  return user.timezone && isValidTimeZone(user.timezone) ? user.timezone : getEnv().DEFAULT_TIMEZONE;
}

function startTyping(deps: Deps, user: UserRow): void {
  fireAndForget("turn.typing", async () => {
    const adapter = deps.adapters.get(user.provider as Provider);
    await adapter.startTyping?.(user.line, user.phoneE164);
  });
}
