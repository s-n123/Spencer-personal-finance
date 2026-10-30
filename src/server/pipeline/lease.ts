import { sql, type SQL } from "drizzle-orm";
import { policy } from "@/server/config/policy";
import { selectRows } from "@/server/db/sql";
import type { Db } from "@/server/db/types";
import type { Deps } from "@/server/deps";
import { AppError, logError } from "@/server/errors";
import { fireAndForget } from "@/server/safe";
import type { Sleeper } from "@/server/time";

// The per-user turn lease (PLAN §2.1 kick step 4; DECISIONS D-040). Lease-first: a kick acquires
// before waiting out the debounce, renews on a heartbeat, and every turn side-effect write is
// fenced on still holding it, so a stalled holder can't commit after a takeover.

/** policy.pipeline with widened types; tests pass small overrides instead of editing policy.ts. */
export type PipelineTiming = { [K in keyof typeof policy.pipeline]: number };

export function resolveTiming(overrides?: Partial<PipelineTiming>): PipelineTiming {
  return { ...policy.pipeline, ...overrides };
}

export interface LeaseHandle {
  userId: string;
  /** Random per kick call; fencing compares against it. */
  owner: string;
}

export class LeaseLostError extends AppError {
  constructor() {
    super("lease_lost");
    this.name = "LeaseLostError";
  }
}

/** A clock instant as a timestamptz parameter (same encoding on pg and PGlite). */
export function sqlTs(d: Date): SQL {
  return sql`${d.toISOString()}::timestamptz`;
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

export function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/** SQL condition: `lease` is still held at `now`. Every turn side-effect write ANDs this in. */
export function leaseFence(lease: LeaseHandle, now: Date): SQL {
  return sql`exists (select 1 from user_turn_state lf where lf.user_id = ${lease.userId} and lf.lease_owner = ${lease.owner} and lf.lease_expires_at > ${sqlTs(now)})`;
}

export type AcquireAttempt =
  | { acquired: true }
  | { acquired: false; exists: boolean; expiresAt: Date | null };

export async function tryAcquireLease(deps: Deps, lease: LeaseHandle, ttlMs: number): Promise<AcquireAttempt> {
  const now = deps.clock.now();
  const won = await selectRows<{ user_id: string }>(
    deps.db,
    sql`update user_turn_state
        set lease_owner = ${lease.owner}, lease_expires_at = ${sqlTs(addMs(now, ttlMs))}, updated_at = ${sqlTs(now)}
        where user_id = ${lease.userId}
          and (lease_owner is null or lease_expires_at is null or lease_expires_at < ${sqlTs(now)})
        returning user_id`,
  );
  if (won.length > 0) return { acquired: true };
  const state = await selectRows<{ lease_expires_at: unknown }>(
    deps.db,
    sql`select lease_expires_at from user_turn_state where user_id = ${lease.userId}`,
  );
  if (state.length === 0) return { acquired: false, exists: false, expiresAt: null };
  const exp = state[0].lease_expires_at;
  return { acquired: false, exists: true, expiresAt: exp == null ? null : toDate(exp) };
}

export type AcquireOutcome = "acquired" | "busy" | "no_state" | "gave_up";

/**
 * ACQUIRE with the v2.2 rules: a fresh lease held by someone else means a live holder will see our
 * rows when it rechecks after release, so we return; a lease close to expiry means the holder
 * missed heartbeats, so we wait for it to lapse and retry (bounded).
 */
export async function acquireLease(
  deps: Deps,
  lease: LeaseHandle,
  timing: PipelineTiming,
  signal?: AbortSignal,
): Promise<AcquireOutcome> {
  for (let retries = 0; ; retries++) {
    const r = await tryAcquireLease(deps, lease, timing.leaseTtlMs);
    if (r.acquired) return "acquired";
    if (!r.exists) return "no_state";
    const remaining = r.expiresAt ? r.expiresAt.getTime() - deps.clock.now().getTime() : 0;
    if (remaining > timing.freshLeaseThresholdMs) return "busy";
    if (retries >= timing.acquireAttempts) return "gave_up";
    // The takeover condition is strict (expires_at < now), hence the extra millisecond.
    await deps.sleeper.sleep(Math.max(0, remaining) + 1, signal);
  }
}

/** RENEW, fenced on owner only: if nobody took over an overdue lease, extending it is safe. */
export async function renewLease(deps: Deps, lease: LeaseHandle, ttlMs: number): Promise<boolean> {
  const now = deps.clock.now();
  const rows = await selectRows<{ user_id: string }>(
    deps.db,
    sql`update user_turn_state
        set lease_expires_at = ${sqlTs(addMs(now, ttlMs))}, updated_at = ${sqlTs(now)}
        where user_id = ${lease.userId} and lease_owner = ${lease.owner}
        returning user_id`,
  );
  return rows.length > 0;
}

export async function releaseLease(deps: Deps, lease: LeaseHandle): Promise<boolean> {
  const now = deps.clock.now();
  const rows = await selectRows<{ user_id: string }>(
    deps.db,
    sql`update user_turn_state
        set lease_owner = null, lease_expires_at = null, updated_at = ${sqlTs(now)}
        where user_id = ${lease.userId} and lease_owner = ${lease.owner}
        returning user_id`,
  );
  return rows.length > 0;
}

/** True while `lease` is held at the clock's now (a read-only fence check). */
export async function holdsLease(db: Db, lease: LeaseHandle, now: Date): Promise<boolean> {
  const rows = await selectRows<{ ok: number }>(db, sql`select 1 as ok where ${leaseFence(lease, now)}`);
  return rows.length > 0;
}

export interface Heartbeat {
  stop(): void;
}

/**
 * Renews every `intervalMs` until stopped. A renew that finds another owner calls `onLost` (which
 * aborts the turn); a renew that errors is a missed beat, which the TTL tolerates.
 *
 * The sleeper is a wall-clock one, not deps.sleeper: the test FakeSleeper advances the shared fake
 * clock on every call, so a concurrent loop on it would run the clock away. In production both are
 * real timers, and the main flow also renews at checkpoints on deps.clock.
 */
export function startHeartbeat(
  deps: Deps,
  lease: LeaseHandle,
  opts: { ttlMs: number; intervalMs: number; sleeper: Sleeper; onLost: () => void },
): Heartbeat {
  const ctrl = new AbortController();
  const loop = async () => {
    while (!ctrl.signal.aborted) {
      try {
        await opts.sleeper.sleep(opts.intervalMs, ctrl.signal);
      } catch {
        return;
      }
      if (ctrl.signal.aborted) return;
      let ok: boolean;
      try {
        ok = await renewLease(deps, lease, opts.ttlMs);
      } catch (err) {
        logError("lease.renew_failed", err, { userId: lease.userId });
        continue;
      }
      if (!ok) {
        if (!ctrl.signal.aborted) opts.onLost();
        return;
      }
    }
  };
  fireAndForget("lease.heartbeat", loop);
  return { stop: () => ctrl.abort() };
}
