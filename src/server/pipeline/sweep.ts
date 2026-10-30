import { sql } from "drizzle-orm";
import { selectRows } from "@/server/db/sql";
import type { Deps } from "@/server/deps";
import { logError } from "@/server/errors";
import { log } from "@/server/log";
import { addMs, sqlTs, type PipelineTiming } from "./lease";

// Opportunistic global sweep (PLAN §2.1 kick step 6). Every kick ends by looking for other users
// whose messages are stuck (pending or processing for a while, with no live lease) and hands each
// one off. It never processes them inline, so one user's kick can't be held up by another's turn.
// This is what recovers stranded turns within seconds on Hobby, where cron is daily.

export async function findStrandedUsers(
  deps: Deps,
  opts: { timing: PipelineTiming; excludeUserId?: string },
): Promise<string[]> {
  const now = deps.clock.now();
  const staleBefore = addMs(now, -opts.timing.sweepStaleAfterMs);
  const exclude = opts.excludeUserId ? sql`and m.user_id <> ${opts.excludeUserId}` : sql``;
  const rows = await selectRows<{ user_id: string }>(
    deps.db,
    sql`select distinct m.user_id
        from inbound_messages m
        left join user_turn_state s on s.user_id = m.user_id
        where m.status in ('pending', 'processing')
          and m.received_at < ${sqlTs(staleBefore)}
          and (s.lease_owner is null or s.lease_expires_at is null or s.lease_expires_at < ${sqlTs(now)})
          ${exclude}
        limit ${opts.timing.sweepBatch}`,
  );
  return rows.map((r) => r.user_id);
}

/** Hands off each stranded user; returns how many were handed off. Never throws. */
export async function opportunisticSweep(
  deps: Deps,
  opts: { timing: PipelineTiming; excludeUserId?: string; handoff: (userId: string) => Promise<void> },
): Promise<number> {
  let userIds: string[];
  try {
    userIds = await findStrandedUsers(deps, opts);
  } catch (err) {
    logError("sweep.query_failed", err);
    return 0;
  }
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        await opts.handoff(userId);
        log.info("sweep.handoff", { userId });
      } catch (err) {
        logError("sweep.handoff_failed", err, { userId });
      }
    }),
  );
  return userIds.length;
}
