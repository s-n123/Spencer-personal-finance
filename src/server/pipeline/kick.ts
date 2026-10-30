import { randomUUID } from "node:crypto";
import { getDeadline } from "@vercel/functions";
import { eq } from "drizzle-orm";
import { users } from "@/server/db/schema";
import type { Deps } from "@/server/deps";
import { logError } from "@/server/errors";
import { log } from "@/server/log";
import { realSleeper, systemClock, type Sleeper } from "@/server/time";
import { claimBurst, hasPendingMessages, readTurnState } from "./claim";
import {
  acquireLease,
  LeaseLostError,
  releaseLease,
  renewLease,
  resolveTiming,
  startHeartbeat,
  type LeaseHandle,
  type PipelineTiming,
} from "./lease";
import { sendPriorityIntents } from "./priority";
import { recoverOrphanedTurns } from "./recover";
import { runTurn, type TurnContext } from "./router";
import { opportunisticSweep } from "./sweep";

// kick(user) (PLAN §2.1; D-040). Idempotent and safe to call any number of times concurrently:
// from after() at ingest, /api/internal/kick, duplicate deliveries and sweeps.
//   1. priority path (outside the lease and debounce)   3. media prefetch during the debounce
//   4. lease first, with heartbeat                       5. holder loop: wait, claim, route, repeat
//   6. release, recheck, opportunistic sweep
// (2, triage, arrives in M4.)

export interface KickOptions {
  /** Media rows of the message(s) that scheduled this kick; prefetched during the debounce. */
  ownMediaIds?: string[];
  /** Overrides of policy.pipeline (tests). Carried into re-scheduled kicks. */
  timing?: Partial<PipelineTiming>;
  /** Wall-clock sleeper for the lease heartbeat (see startHeartbeat). Carried into re-scheduled kicks. */
  heartbeatSleeper?: Sleeper;
  /** Invocation deadline in epoch ms on deps.clock; defaults to getDeadline(), else start + maxDurationMs. */
  deadlineMs?: number;
}

export type KickOutcome = "idle" | "busy" | "done" | "handed_off" | "lease_lost" | "gave_up";

export interface KickResult {
  outcome: KickOutcome;
  turns: number;
}

export async function kick(deps: Deps, userId: string, opts: KickOptions = {}): Promise<KickResult> {
  const timing = resolveTiming(opts.timing);
  const platformDeadlineMs = invocationDeadlineMs(deps);
  const deadlineMs = opts.deadlineMs ?? platformDeadlineMs ?? deps.clock.now().getTime() + timing.maxDurationMs;
  // Without an HTTP handoff the continuation is a runner task, and after() nests inside this same
  // invocation: on the platform it gets no more time, so handing off would only loop. Run instead.
  const canHandOff = deps.handoff !== null || platformDeadlineMs === null;

  await sendPriorityIntents(deps, userId, timing);

  // Awaited before returning so the platform keeps the invocation alive for it.
  const prefetch = prefetchOwnMedia(deps, userId, opts.ownMediaIds ?? [], deadlineMs);
  let result: KickResult;
  try {
    result = await processTurns(deps, userId, timing, { deadlineMs, canHandOff }, opts);
  } finally {
    await prefetch;
  }

  await opportunisticSweep(deps, {
    timing,
    excludeUserId: userId,
    handoff: (id) => continueKick(deps, id, opts),
  });
  log.info("kick.done", { userId, status: result.outcome, count: result.turns });
  return result;
}

/** Continues a user's processing in a fresh invocation (or, without one, a fresh runner task). */
export async function continueKick(deps: Deps, userId: string, opts: KickOptions = {}): Promise<void> {
  if (deps.handoff) {
    await deps.handoff(userId);
    return;
  }
  const carried: KickOptions = { timing: opts.timing, heartbeatSleeper: opts.heartbeatSleeper };
  deps.runner.run("kick", async () => {
    await kick(deps, userId, carried);
  });
}

interface Budget {
  deadlineMs: number;
  canHandOff: boolean;
}

async function processTurns(
  deps: Deps,
  userId: string,
  timing: PipelineTiming,
  budget: Budget,
  opts: KickOptions,
): Promise<KickResult> {
  const lease: LeaseHandle = { userId, owner: randomUUID() };
  let turns = 0;
  let canHandOff = budget.canHandOff;
  for (;;) {
    const acquired = await acquireLease(deps, lease, timing);
    if (acquired !== "acquired") return { outcome: acquired === "no_state" ? "idle" : acquired, turns };

    let held: HoldResult;
    try {
      held = await holdLease(deps, lease, timing, { deadlineMs: budget.deadlineMs, canHandOff }, opts);
    } catch (err) {
      // Unexpected failure: free the lease so the next kick can recover the turn right away.
      await releaseLease(deps, lease).catch((e: unknown) => logError("kick.release_failed", e, { userId }));
      throw err;
    }
    turns += held.turns;
    if (held.end === "lease_lost") {
      log.warn("kick.lease_lost", { userId, count: turns });
      return { outcome: "lease_lost", turns };
    }

    await releaseLease(deps, lease);
    if (held.end === "handoff") {
      // Released first, so the fresh invocation can acquire.
      try {
        await continueKick(deps, userId, opts);
        return { outcome: "handed_off", turns };
      } catch (err) {
        // Run on here with what's left rather than leave the burst to a sweep that may be hours
        // away on Hobby. If the handoff did land, the lease keeps the two from overlapping.
        logError("kick.handoff_failed", err, { userId });
        canHandOff = false;
        continue;
      }
    }
    // Recheck after release: a kick that saw our fresh lease returned, trusting us to see its rows.
    if (!(await hasPendingMessages(deps.db, userId))) return { outcome: "done", turns };
  }
}

interface HoldResult {
  end: "drained" | "handoff" | "lease_lost";
  turns: number;
}

async function holdLease(
  deps: Deps,
  lease: LeaseHandle,
  timing: PipelineTiming,
  { deadlineMs, canHandOff }: Budget,
  opts: KickOptions,
): Promise<HoldResult> {
  const ctrl = new AbortController();
  const lost = () => {
    if (!ctrl.signal.aborted) ctrl.abort(new LeaseLostError());
  };
  const heartbeat = startHeartbeat(deps, lease, {
    ttlMs: timing.leaseTtlMs,
    intervalMs: timing.heartbeatMs,
    sleeper: opts.heartbeatSleeper ?? realSleeper,
    onLost: lost,
  });
  const ctx: TurnContext = {
    lease,
    signal: ctrl.signal,
    deadlineMs,
    timing,
    async checkpoint() {
      if (ctrl.signal.aborted || !(await renewLease(deps, lease, timing.leaseTtlMs))) {
        lost();
        throw new LeaseLostError();
      }
    },
  };

  let turns = 0;
  let warnedNoHandoff = false;
  try {
    await recoverOrphanedTurns(deps, ctx);
    for (;;) {
      const state = await readTurnState(deps.db, lease.userId);
      if (ctrl.signal.aborted || !state || state.leaseOwner !== lease.owner) return { end: "lease_lost", turns };
      if (!state.hasPending) return { end: "drained", turns };

      const now = deps.clock.now().getTime();
      const startAt = Math.max(now, state.processAfter.getTime());
      if (deadlineMs - startAt < timing.minTurnBudgetMs) {
        if (canHandOff) return { end: "handoff", turns };
        if (!warnedNoHandoff) {
          warnedNoHandoff = true;
          log.warn("kick.no_handoff", { userId: lease.userId, reason: "handoff_not_configured" });
        }
      }
      if (startAt > now) {
        // Never exit on an early wake: sleep, then re-read (v1 stranded messages this way).
        await deps.sleeper.sleep(startAt - now, ctrl.signal);
        continue;
      }

      await ctx.checkpoint();
      const turn = await claimBurst(deps, lease);
      // Null means a message landed after our read and moved process_after: re-read and wait.
      if (!turn) continue;
      const result = await runTurn(deps, ctx, turn);
      turns += 1;
      log.info("turn.finished", { userId: lease.userId, turnId: turn.id, mode: result.mode, status: result.status });
    }
  } catch (err) {
    if (err instanceof LeaseLostError || ctrl.signal.aborted) return { end: "lease_lost", turns };
    throw err;
  } finally {
    heartbeat.stop();
  }
}

async function prefetchOwnMedia(deps: Deps, userId: string, mediaIds: string[], deadlineMs: number): Promise<void> {
  if (mediaIds.length === 0) return;
  try {
    const [user] = await deps.db
      .select({ consentedAt: users.consentedAt, pausedAt: users.messagingPausedAt })
      .from(users)
      .where(eq(users.id, userId));
    // A paused user's photos are ignored by the router unless a START resumes them, and then the
    // turn's ensureMedia fetches them; don't collect health photos we may never use.
    if (!user?.consentedAt || user.pausedAt) return;
    const budget = Math.max(0, deadlineMs - deps.clock.now().getTime());
    await deps.pipeline.prefetchMedia(deps, mediaIds, AbortSignal.timeout(budget));
  } catch (err) {
    // The turn's ensureMedia retries anything that didn't land.
    logError("kick.prefetch_failed", err, { userId });
  }
}

/**
 * getDeadline() is wall-clock; turn logic runs on deps.clock (which the dev simulator can shift),
 * so the remaining budget is carried over rather than the absolute instant.
 */
function invocationDeadlineMs(deps: Deps): number | null {
  let deadline: Date | undefined;
  try {
    deadline = getDeadline();
  } catch {
    return null;
  }
  if (!deadline) return null;
  const remaining = deadline.getTime() - systemClock.now().getTime();
  return deps.clock.now().getTime() + remaining;
}
