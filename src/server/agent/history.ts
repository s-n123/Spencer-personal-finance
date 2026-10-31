import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { policy } from "@/server/config/policy";
import { inboundMessages, media, outboundMessages, turns } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

// Conversation history as text only (DECISIONS D-032). Earlier turns' assistant content, thinking
// and tool blocks are never replayed: only the bubbles actually sent, so the prefix stays stable and
// preserved-thinking checks have nothing to reject. Past photos become their code-written summary.
// An exchange is one earlier turn: the user's messages in it, then the reply bubbles sent for it.

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface HistoryQuery {
  userId: string;
  /** The turn being built; its messages are never part of the history. */
  turnId: string;
  /** This turn's claimed inbound rows, excluded as well (defensive). */
  excludeInboundIds: string[];
  exchanges?: number;
}

/** Shown for a past photo whose turn didn't write a summary. */
export const PHOTO_PLACEHOLDER = "[photo]";

const HISTORY_OUTBOUND_KINDS = ["reply", "command"];
const HISTORY_OUTBOUND_STATUSES = ["sent", "unknown"];

export async function loadHistory(db: Db, q: HistoryQuery): Promise<HistoryMessage[]> {
  const exchanges = q.exchanges ?? policy.agent.historyExchanges;
  if (exchanges <= 0) return [];

  const prior = await db
    .select({ id: turns.id })
    .from(turns)
    .where(
      and(
        eq(turns.userId, q.userId),
        ne(turns.id, q.turnId),
        exists(
          db
            .select({ one: sql`1` })
            .from(inboundMessages)
            .where(and(eq(inboundMessages.turnId, turns.id), eq(inboundMessages.status, "done"))),
        ),
        // A refused turn is left out whole (D-126): replaying the refused text, or the refusal copy
        // after it, would invite the same refusal. It is marked 'safety' at commit; the stop reason
        // also covers one closed under another mode.
        ne(turns.mode, "safety"),
        sql`${turns.stopReason} is distinct from 'refusal'`,
      ),
    )
    .orderBy(desc(turns.startedAt), desc(turns.createdAt))
    .limit(exchanges);
  if (prior.length === 0) return [];
  const turnIds = prior.map((t) => t.id).reverse();

  const inbound = await db
    .select({ id: inboundMessages.id, turnId: inboundMessages.turnId, text: inboundMessages.text })
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.userId, q.userId),
        inArray(inboundMessages.turnId, turnIds),
        eq(inboundMessages.status, "done"),
        // Crisis-tagged rows are handled by fixed copy and never fed back to the model.
        isNull(inboundMessages.crisisKind),
        q.excludeInboundIds.length > 0 ? notInArray(inboundMessages.id, q.excludeInboundIds) : undefined,
      ),
    )
    // created_at (one ingest transaction per message) breaks ties between equal provider timestamps.
    .orderBy(
      asc(inboundMessages.sentAt),
      asc(inboundMessages.receivedAt),
      asc(inboundMessages.createdAt),
      asc(inboundMessages.id),
    );

  const photoNotes = new Map<string, string[]>();
  if (inbound.length > 0) {
    const rows = await db
      .select({ inboundMessageId: media.inboundMessageId, summary: media.summary })
      .from(media)
      .where(
        and(
          eq(media.userId, q.userId),
          inArray(
            media.inboundMessageId,
            inbound.map((m) => m.id),
          ),
        ),
      )
      .orderBy(asc(media.createdAt), asc(media.id));
    for (const row of rows) {
      if (!row.inboundMessageId) continue;
      const notes = photoNotes.get(row.inboundMessageId) ?? [];
      notes.push(row.summary?.trim() || PHOTO_PLACEHOLDER);
      photoNotes.set(row.inboundMessageId, notes);
    }
  }

  const outbound = await db
    .select({ turnId: outboundMessages.turnId, text: outboundMessages.text })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.userId, q.userId),
        inArray(outboundMessages.turnId, turnIds),
        inArray(outboundMessages.kind, HISTORY_OUTBOUND_KINDS),
        inArray(outboundMessages.status, HISTORY_OUTBOUND_STATUSES),
        isNotNull(outboundMessages.text),
      ),
    )
    .orderBy(asc(outboundMessages.seq), asc(outboundMessages.createdAt), asc(outboundMessages.id));

  const messages: HistoryMessage[] = [];
  for (const turnId of turnIds) {
    const userParts: string[] = [];
    for (const m of inbound) {
      if (m.turnId !== turnId) continue;
      userParts.push(...(photoNotes.get(m.id) ?? []));
      const text = m.text?.trim();
      if (text) userParts.push(text);
    }
    if (userParts.length > 0) messages.push({ role: "user", content: userParts.join("\n") });
    const bubbles = outbound
      .filter((o) => o.turnId === turnId)
      .map((o) => o.text?.trim() ?? "")
      .filter((t) => t.length > 0);
    if (bubbles.length > 0) messages.push({ role: "assistant", content: bubbles.join("\n\n") });
  }
  return mergeConsecutive(messages);
}

/** Merges same-role neighbours and drops leading assistant messages (the first must be user). */
export function mergeConsecutive(messages: HistoryMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (out.length === 0 && m.role === "assistant") continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      const separator = m.role === "assistant" ? "\n\n" : "\n";
      out[out.length - 1] = { role: m.role, content: `${last.content}${separator}${m.content}` };
    } else {
      out.push({ ...m });
    }
  }
  return out;
}
