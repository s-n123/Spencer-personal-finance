import { sql } from "drizzle-orm";
import { outboundMessages } from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Db } from "@/server/db/types";
import type { Deps } from "@/server/deps";
import { crisisCopy, STOP_CONFIRMATION } from "@/server/safety/copy";
import { sqlTs, type PipelineTiming } from "./lease";
import { sendPending, type SendSummary } from "./outbound";
import type { CrisisKind } from "./screen";

// Priority intents (PLAN §2.1 ingest step 7, kick step 1; D-082). Written inside the ingest
// transaction so a kick that dies early can't lose them, and sent by every kick before it touches
// the lease or the debounce. They are exempt from lease fencing and from the pause check.

export function priorityKey(inboundId: string, what: "crisis" | "stop"): string {
  return `priority:${inboundId}:${what}`;
}

export interface PriorityIntentInput {
  userId: string;
  inboundId: string;
  crisisKind: CrisisKind | null;
  stop: boolean;
  now: Date;
}

/** Must run in the ingest transaction, after STOP has set messaging_paused_at. */
export async function writePriorityIntents(
  tx: Db,
  input: PriorityIntentInput,
): Promise<{ crisis: boolean; stop: boolean }> {
  let crisis = false;
  if (input.crisisKind) {
    const rows = await tx
      .insert(outboundMessages)
      .values({
        userId: input.userId,
        kind: "priority",
        text: crisisCopy[input.crisisKind],
        idempotencyKey: priorityKey(input.inboundId, "crisis"),
      })
      .onConflictDoNothing({ target: outboundMessages.idempotencyKey })
      .returning({ id: outboundMessages.id });
    crisis = rows.length > 0;
  }

  let stop = false;
  if (input.stop) {
    // One confirmation per pause episode: only the first STOP since the pause began wins the guard.
    const won = await selectRows<{ id: string }>(
      tx,
      sql`update users set stop_confirmed_at = ${sqlTs(input.now)}
          where id = ${input.userId}
            and (stop_confirmed_at is null or stop_confirmed_at < messaging_paused_at)
          returning id`,
    );
    if (won.length > 0) {
      const rows = await tx
        .insert(outboundMessages)
        .values({
          userId: input.userId,
          kind: "priority",
          text: STOP_CONFIRMATION,
          idempotencyKey: priorityKey(input.inboundId, "stop"),
        })
        .onConflictDoNothing({ target: outboundMessages.idempotencyKey })
        .returning({ id: outboundMessages.id });
      stop = rows.length > 0;
    }
  }
  return { crisis, stop };
}

/** Kick step 1. Never re-screens: it only sends what ingest already wrote. */
export function sendPriorityIntents(deps: Deps, userId: string, timing: PipelineTiming): Promise<SendSummary> {
  return sendPending(deps, userId, { kinds: ["priority"], timing });
}
