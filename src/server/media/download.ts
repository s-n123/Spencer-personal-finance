import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Provider } from "@/server/channels/types";
import { policy } from "@/server/config/policy";
import { media } from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Deps } from "@/server/deps";
import { AppError, logError } from "@/server/errors";
import { log } from "@/server/log";
import type { EnsureMediaFn, PrefetchMediaFn } from "@/server/pipeline/contracts";
import { IMAGE_ERROR_RETRYABLE, processImage } from "./image";
import { buildReadiness, selectTurnMedia, type TurnMediaRow } from "./ready";
import { mediaKey } from "./storage/types";

// Single-flight media download (PLAN §2.1 kick step 3; D-053). A row is claimed with a
// conditional UPDATE (pending → downloading, attempts+1, claimed_until=$now+claim), so concurrent
// kicks download it at most once per claim; an expired claim can be taken over. The processed
// JPEG goes to a deterministic key, so a retry overwrites instead of orphaning. Media writes are
// not lease-fenced: prefetch runs outside the lease and the claim is what serializes the work.
// Provider URLs are never logged.

const POLL_MS = 500;
const DAY_MS = 86_400_000;
const PROVIDERS: readonly Provider[] = ["simulator", "sendblue", "linq", "blooio"];

/** Errors where a retry of the same row can't help; everything else goes back to pending. */
const PERMANENT_MEDIA_ERRORS = new Set(["media_no_url", "media_no_adapter", "media_empty", "media_too_large"]);

interface Claim {
  id: string;
  userId: string;
  providerUrl: string | null;
  /** attempts after our increment; identifies our claim for fencing the failure release. */
  attempts: number;
  provider: string | null;
}

async function claimMedia(deps: Deps, mediaId: string): Promise<Claim | null> {
  const now = deps.clock.now();
  const { mediaClaimMs, mediaMaxAttempts } = policy.pipeline;
  const [row] = await deps.db
    .update(media)
    .set({
      status: "downloading",
      claimedUntil: new Date(now.getTime() + mediaClaimMs),
      attempts: sql`${media.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(media.id, mediaId),
        or(eq(media.status, "pending"), and(eq(media.status, "downloading"), lt(media.claimedUntil, now))),
        lt(media.attempts, mediaMaxAttempts),
      ),
    )
    .returning({
      id: media.id,
      userId: media.userId,
      providerUrl: media.providerUrl,
      attempts: media.attempts,
      inboundMessageId: media.inboundMessageId,
    });
  if (!row) return null;
  // The adapter that received the message fetches its media; fall back to the user's provider.
  const [src] = await selectRows<{ provider: string | null }>(
    deps.db,
    sql`select coalesce(
      (select provider from inbound_messages where id = ${row.inboundMessageId}),
      (select provider from users where id = ${row.userId})
    ) as provider`,
  );
  return {
    id: row.id,
    userId: row.userId,
    providerUrl: row.providerUrl,
    attempts: row.attempts,
    provider: src?.provider ?? null,
  };
}

function adapterFor(deps: Deps, provider: string | null) {
  const known = PROVIDERS.find((p) => p === provider);
  if (!known) throw new AppError("media_no_adapter");
  try {
    return deps.adapters.get(known);
  } catch {
    throw new AppError("media_no_adapter");
  }
}

async function download(deps: Deps, claim: Claim, signal: AbortSignal) {
  if (!claim.providerUrl) throw new AppError("media_no_url");
  const adapter = adapterFor(deps, claim.provider);
  const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(policy.pipeline.mediaDownloadTimeoutMs)]);
  let fetched: { bytes: Uint8Array; contentType: string | null };
  try {
    fetched = await adapter.fetchMedia(claim.providerUrl, fetchSignal);
  } catch (err) {
    signal.throwIfAborted();
    if (fetchSignal.aborted) throw new AppError("media_download_timeout");
    logError("media.download.fetch_failed", err, { mediaId: claim.id, userId: claim.userId });
    throw new AppError("media_download_failed");
  }
  // The adapter contract returns the whole body, so the cap is enforced after the fact.
  if (fetched.bytes.byteLength === 0) throw new AppError("media_empty");
  if (fetched.bytes.byteLength > policy.pipeline.mediaMaxBytes) throw new AppError("media_too_large");
  return fetched;
}

/** Downloads, converts and stores a claimed row; failures are recorded on the row, never thrown. */
async function processClaim(deps: Deps, claim: Claim, signal: AbortSignal): Promise<void> {
  const started = performance.now();
  try {
    const fetched = await download(deps, claim, signal);
    const image = await processImage(fetched.bytes, { signal });
    signal.throwIfAborted();

    const key = mediaKey(claim.userId, claim.id);
    try {
      await deps.storage.put(key, image.jpeg, "image/jpeg");
    } catch (err) {
      logError("media.store.put_failed", err, { mediaId: claim.id, userId: claim.userId });
      throw new AppError("media_storage_failed");
    }

    const now = deps.clock.now();
    const sourceContentType = fetched.contentType?.slice(0, 100) ?? null;
    const stored = await deps.db
      .update(media)
      .set({
        status: "stored",
        storageKey: key,
        contentType: "image/jpeg",
        sourceContentType: sql`coalesce(${media.sourceContentType}, ${sourceContentType})`,
        width: image.width,
        height: image.height,
        bytes: image.jpeg.byteLength,
        sha256: image.sha256,
        providerUrl: null,
        purgeAfter: new Date(now.getTime() + policy.media.retentionDays * DAY_MS),
        claimedUntil: null,
        errorCode: null,
        updatedAt: now,
      })
      .where(and(eq(media.id, claim.id), eq(media.status, "downloading")))
      .returning({ id: media.id });
    if (stored.length === 0) {
      await discardUnclaimedBlob(deps, claim);
      return;
    }
    log.info("media.stored", {
      mediaId: claim.id,
      userId: claim.userId,
      attempt: claim.attempts,
      kind: image.sourceType,
      bytes: image.jpeg.byteLength,
      width: image.width,
      height: image.height,
      durationMs: Math.round(performance.now() - started),
    });
  } catch (err) {
    await releaseFailed(deps, claim, err, signal.aborted);
  }
}

/**
 * The store UPDATE matched nothing. Delete the blob unless the row may still legitimately use
 * this key: the key is deterministic, so a row another claimer stored (or is still downloading)
 * points at the very same object.
 */
async function discardUnclaimedBlob(deps: Deps, claim: Claim): Promise<void> {
  const [row] = await deps.db.select({ status: media.status }).from(media).where(eq(media.id, claim.id));
  if (row && (row.status === "stored" || row.status === "downloading" || row.status === "pending")) return;
  await deleteBlob(deps, claim.userId, claim.id);
  log.info("media.store.discarded", { mediaId: claim.id, userId: claim.userId, status: row?.status ?? "gone" });
}

async function deleteBlob(deps: Deps, userId: string, mediaId: string): Promise<void> {
  try {
    await deps.storage.delete(mediaKey(userId, mediaId));
  } catch (err) {
    logError("media.store.delete_failed", err, { mediaId, userId });
  }
}

function errorCodeOf(err: unknown): string {
  if (err instanceof AppError) return err.errorCode;
  logError("media.process.unexpected", err);
  return "media_failed";
}

function isRetryable(code: string): boolean {
  if (PERMANENT_MEDIA_ERRORS.has(code)) return false;
  return IMAGE_ERROR_RETRYABLE[code] ?? true;
}

/**
 * Ends our claim after a failure: back to pending if a retry could help and attempts remain,
 * otherwise failed. Fenced on our attempts value, so a claimer whose claim expired and was taken
 * over can't reset the new claimer's row. An abort by the caller (lease loss, deadline) is not
 * the media's fault and gives the attempt back.
 */
async function releaseFailed(deps: Deps, claim: Claim, err: unknown, aborted: boolean): Promise<void> {
  const code = aborted ? "media_aborted" : errorCodeOf(err);
  const fail = !aborted && (!isRetryable(code) || claim.attempts >= policy.pipeline.mediaMaxAttempts);
  const now = deps.clock.now();
  const [row] = await deps.db
    .update(media)
    .set({
      status: fail ? "failed" : "pending",
      attempts: aborted ? claim.attempts - 1 : claim.attempts,
      claimedUntil: null,
      errorCode: code,
      // Nothing retries a failed row (a resend is a new row), so its photo URL is just exposure.
      ...(fail ? { providerUrl: null } : {}),
      updatedAt: now,
    })
    .where(and(eq(media.id, claim.id), eq(media.status, "downloading"), eq(media.attempts, claim.attempts)))
    .returning({ status: media.status });
  // A claimer that lost its claim may already have written the deterministic key.
  if (row?.status === "failed") await deleteBlob(deps, claim.userId, claim.id);
  log.warn("media.download.failed", {
    mediaId: claim.id,
    userId: claim.userId,
    attempt: claim.attempts,
    errorCode: code,
    status: row?.status ?? "claim_lost",
  });
}

/** Rows nobody can claim any more (attempts used up) would otherwise wait forever. */
async function failExhausted(deps: Deps, rows: TurnMediaRow[]): Promise<void> {
  const now = deps.clock.now();
  const ids = rows.filter((r) => isOpen(r) && r.attempts >= policy.pipeline.mediaMaxAttempts).map((r) => r.id);
  if (ids.length === 0) return;
  const failed = await deps.db
    .update(media)
    .set({
      status: "failed",
      claimedUntil: null,
      providerUrl: null,
      errorCode: sql`coalesce(${media.errorCode}, 'media_attempts_exhausted')`,
      updatedAt: now,
    })
    .where(
      and(
        inArray(media.id, ids),
        sql`${media.attempts} >= ${policy.pipeline.mediaMaxAttempts}`,
        or(eq(media.status, "pending"), and(eq(media.status, "downloading"), lt(media.claimedUntil, now))),
      ),
    )
    .returning({ id: media.id, userId: media.userId });
  for (const row of failed) {
    await deleteBlob(deps, row.userId, row.id);
    log.warn("media.download.exhausted", { mediaId: row.id, userId: row.userId });
  }
}

function isOpen(row: TurnMediaRow): boolean {
  return row.status === "pending" || row.status === "downloading";
}

function isClaimable(row: TurnMediaRow, now: Date): boolean {
  if (row.attempts >= policy.pipeline.mediaMaxAttempts) return false;
  if (row.status === "pending") return true;
  return row.status === "downloading" && row.claimedUntil !== null && row.claimedUntil < now;
}

async function claimAndProcess(deps: Deps, mediaId: string, signal: AbortSignal): Promise<boolean> {
  const claim = await claimMedia(deps, mediaId);
  if (!claim) return false;
  await processClaim(deps, claim, signal);
  return true;
}

/** Downloads, converts and stores the given media rows. Safe to call repeatedly and concurrently. */
export const prefetchMedia: PrefetchMediaFn = async (deps, mediaIds, signal) => {
  const results = await Promise.allSettled(mediaIds.map((id) => claimAndProcess(deps, id, signal)));
  for (const r of results) {
    if (r.status === "rejected") logError("media.prefetch.failed", r.reason);
  }
};

/**
 * For a claimed burst: processes any media row it can claim itself, waits up to
 * ensureMediaWaitMs (polling) for rows another invocation is downloading, then returns the stored
 * JPEGs plus everything that isn't ready. A row still in flight at the deadline counts as failed
 * for this turn only; its state is left for the downloader to finish.
 */
export const ensureMedia: EnsureMediaFn = async (deps, inboundMessageIds, signal) => {
  let rows = await selectTurnMedia(deps.db, inboundMessageIds);
  if (rows.length === 0) return { ready: [], failed: [] };
  const deadline = deps.clock.now().getTime() + policy.pipeline.ensureMediaWaitMs;

  for (;;) {
    signal.throwIfAborted();
    await failExhausted(deps, rows);
    const now = deps.clock.now();
    const claimable = now.getTime() < deadline ? rows.filter((r) => isClaimable(r, now)) : [];
    const processed = await Promise.all(claimable.map((r) => claimAndProcess(deps, r.id, signal)));
    rows = await selectTurnMedia(deps.db, inboundMessageIds);
    if (processed.some(Boolean)) continue; // a retryable failure may be claimable again

    const remaining = deadline - deps.clock.now().getTime();
    if (!rows.some(isOpen) || remaining <= 0) break;
    await deps.sleeper.sleep(Math.min(POLL_MS, remaining), signal);
    rows = await selectTurnMedia(deps.db, inboundMessageIds);
  }
  return buildReadiness(deps, rows);
};
