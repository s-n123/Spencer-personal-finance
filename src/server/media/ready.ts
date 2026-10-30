import { inArray } from "drizzle-orm";
import { policy } from "@/server/config/policy";
import { media } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import type { Deps } from "@/server/deps";
import { logError } from "@/server/errors";
import { log } from "@/server/log";
import type { MediaReadiness, ReadyImage } from "@/server/pipeline/contracts";

// The read side of ensureMedia: which media belong to a claimed burst, in message order, and
// turning stored rows into base64 JPEGs for the model.

export interface TurnMediaRow {
  id: string;
  userId: string;
  inboundMessageId: string;
  status: string;
  attempts: number;
  claimedUntil: Date | null;
  storageKey: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Media rows of the given inbound messages, in the caller's message order. Within one message,
 * rows keep insertion order as far as created_at can tell (ties fall back to id).
 */
export async function selectTurnMedia(db: Db, inboundMessageIds: string[]): Promise<TurnMediaRow[]> {
  if (inboundMessageIds.length === 0) return [];
  const rows = await db
    .select({
      id: media.id,
      userId: media.userId,
      inboundMessageId: media.inboundMessageId,
      status: media.status,
      attempts: media.attempts,
      claimedUntil: media.claimedUntil,
      storageKey: media.storageKey,
      width: media.width,
      height: media.height,
      createdAt: media.createdAt,
    })
    .from(media)
    .where(inArray(media.inboundMessageId, inboundMessageIds));

  const position = new Map(inboundMessageIds.map((id, i) => [id, i]));
  return rows
    .filter((r): r is typeof r & { inboundMessageId: string } => r.inboundMessageId !== null)
    .sort(
      (a, b) =>
        (position.get(a.inboundMessageId) ?? 0) - (position.get(b.inboundMessageId) ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      inboundMessageId: r.inboundMessageId,
      status: r.status,
      attempts: r.attempts,
      claimedUntil: r.claimedUntil,
      storageKey: r.storageKey,
      width: r.width,
      height: r.height,
    }));
}

/**
 * Reads the stored JPEGs (at most maxImagesPerTurn) and labels them img1..N in order. Rows that
 * aren't stored, or whose blob is missing, are reported as failed so the model can ask for a
 * resend. Stored images beyond the cap are left out and only counted in the log.
 */
export async function buildReadiness(deps: Deps, rows: TurnMediaRow[]): Promise<MediaReadiness> {
  const failed: MediaReadiness["failed"] = [];
  const selected: (TurnMediaRow & { storageKey: string; width: number; height: number })[] = [];
  let overCap = 0;
  for (const row of rows) {
    if (row.status !== "stored" || !row.storageKey || !row.width || !row.height) {
      failed.push({ mediaId: row.id, inboundMessageId: row.inboundMessageId });
    } else if (selected.length >= policy.pipeline.maxImagesPerTurn) {
      overCap += 1;
    } else {
      selected.push({ ...row, storageKey: row.storageKey, width: row.width, height: row.height });
    }
  }
  if (overCap > 0) log.warn("media.ready.over_cap", { count: overCap });

  const blobs = await Promise.all(selected.map((row) => readJpeg(deps, row.storageKey, row)));
  const ready: ReadyImage[] = [];
  selected.forEach((row, i) => {
    const bytes = blobs[i];
    if (!bytes) {
      failed.push({ mediaId: row.id, inboundMessageId: row.inboundMessageId });
      return;
    }
    ready.push({
      mediaId: row.id,
      inboundMessageId: row.inboundMessageId,
      ref: `img${ready.length + 1}`,
      base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
      mediaType: "image/jpeg",
      width: row.width,
      height: row.height,
    });
  });
  return { ready, failed };
}

/**
 * The stored JPEG, or null if it is missing or unreadable. A storage error costs this one image,
 * not the whole turn: the model is told the photo couldn't be loaded and asks for a resend.
 */
async function readJpeg(deps: Deps, key: string, row: TurnMediaRow): Promise<Uint8Array | null> {
  try {
    const obj = await deps.storage.get(key);
    if (obj && obj.contentType === "image/jpeg") return obj.bytes;
    log.warn("media.ready.blob_missing", { mediaId: row.id, userId: row.userId });
  } catch (err) {
    logError("media.ready.read_failed", err, { mediaId: row.id, userId: row.userId });
  }
  return null;
}
