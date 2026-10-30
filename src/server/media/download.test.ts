import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import exifr from "exifr";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "@/server/channels/types";
import { policy } from "@/server/config/policy";
import { inboundMessages, media, users } from "@/server/db/schema";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, type TestDeps } from "@/test/deps";
import { FakeAdapter, registryOf } from "@/test/fake-adapter";
import { jpegWithExif, solidJpeg } from "@/test/fixtures/images";
import { ensureMedia, prefetchMedia } from "./download";
import { closeHeicWorker } from "./heic";
import { mediaKey } from "./storage/types";

const PHONE = "+12015550101";
const DAY_MS = 86_400_000;

let t: TestDb;
let deps: TestDeps;
let userId: string;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await closeHeicWorker();
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
  deps = makeTestDeps(t.db);
  const [u] = await t.db
    .insert(users)
    .values({ phoneE164: PHONE, provider: "simulator", status: "active", consentedAt: deps.clock.now() })
    .returning({ id: users.id });
  userId = u.id;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const signal = () => new AbortController().signal;
let urlSeq = 0;
const fakeUrl = () => `https://media.simulator.invalid/${++urlSeq}`;

async function seedMessage(opts: { provider?: string; sentAt?: Date } = {}): Promise<string> {
  const [m] = await t.db
    .insert(inboundMessages)
    .values({
      userId,
      provider: opts.provider ?? "simulator",
      providerMessageId: randomUUID(),
      sentAt: opts.sentAt ?? deps.clock.now(),
      receivedAt: deps.clock.now(),
    })
    .returning({ id: inboundMessages.id });
  return m.id;
}

/** A media row whose URL serves `bytes` from the fake adapter (or nothing, if bytes is null). */
async function seedMedia(
  inboundMessageId: string,
  bytes: Uint8Array | null,
  overrides: Partial<typeof media.$inferInsert> = {},
  adapter: FakeAdapter = deps.adapter,
): Promise<{ id: string; url: string }> {
  const url = fakeUrl();
  if (bytes) adapter.media.set(url, { bytes, contentType: "image/jpeg" });
  const [row] = await t.db
    .insert(media)
    .values({ userId, inboundMessageId, providerUrl: url, ...overrides })
    .returning({ id: media.id });
  return { id: row.id, url };
}

async function row(id: string) {
  const [r] = await t.db.select().from(media).where(eq(media.id, id));
  return r;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Makes the adapter's next fetches wait on gates (in call order), honouring the abort signal.
 * Fetches beyond the provided gates pass straight through. Returns the call counter.
 */
function gateFetches(adapter: FakeAdapter, gates: ReturnType<typeof deferred>[]): { calls: number } {
  const counter = { calls: 0 };
  const original = adapter.fetchMedia.bind(adapter);
  // Assigned through the interface: FakeAdapter's own signature omits the signal.
  (adapter as ChannelAdapter).fetchMedia = async (url: string, sig: AbortSignal) => {
    const gate = gates[counter.calls++];
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
        gate.promise.then(resolve, reject);
      });
    }
    return original(url);
  };
  return counter;
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("prefetchMedia", () => {
  it("stores an EXIF-stripped JPEG under the deterministic key and clears the provider URL", async () => {
    const msg = await seedMessage();
    const input = await jpegWithExif({ width: 400, height: 200, orientation: 6 });
    const m = await seedMedia(msg, input);

    await prefetchMedia(deps, [m.id], signal());

    const r = await row(m.id);
    const key = mediaKey(userId, m.id);
    expect(key).toBe(`users/${userId}/${m.id}.jpg`);
    expect(r).toMatchObject({
      status: "stored",
      storageKey: key,
      contentType: "image/jpeg",
      sourceContentType: "image/jpeg",
      width: 200,
      height: 400,
      providerUrl: null,
      claimedUntil: null,
      attempts: 1,
      errorCode: null,
    });
    expect(r.purgeAfter?.getTime()).toBe(deps.clock.now().getTime() + policy.media.retentionDays * DAY_MS);

    expect([...deps.storage.objects.keys()]).toEqual([key]);
    const blob = deps.storage.objects.get(key);
    expect(blob?.contentType).toBe("image/jpeg");
    expect(r.bytes).toBe(blob?.bytes.byteLength);
    expect(r.sha256).toBe(createHash("sha256").update(blob!.bytes).digest("hex"));
    expect(await exifr.gps(Buffer.from(blob!.bytes))).toBeUndefined();
    // The adapter may now drop its staged original (the simulator's still has EXIF).
    expect(deps.adapter.released).toEqual([m.url]);
  });

  it("downloads once when two prefetches race for the same row", async () => {
    const msg = await seedMessage();
    const m = await seedMedia(msg, await solidJpeg(64, 48));
    const gate = deferred();
    const counter = gateFetches(deps.adapter, [gate]);

    let settled = 0;
    const a = prefetchMedia(deps, [m.id], signal()).finally(() => settled++);
    const b = prefetchMedia(deps, [m.id], signal()).finally(() => settled++);
    // The loser finds the row claimed and returns while the winner is still downloading.
    for (let i = 0; i < 100 && (counter.calls < 1 || settled < 1); i++) await flush(1);
    expect(settled).toBe(1);
    expect(counter.calls).toBe(1);
    expect((await row(m.id)).status).toBe("downloading");

    gate.resolve();
    await Promise.all([a, b]);
    expect(counter.calls).toBe(1);
    expect(await row(m.id)).toMatchObject({ status: "stored", attempts: 1 });

    // A later prefetch of a stored row does nothing.
    await prefetchMedia(deps, [m.id], signal());
    expect(counter.calls).toBe(1);
  });

  it("returns a retryable failure to pending and fails the row on the last attempt", async () => {
    const msg = await seedMessage();
    const m = await seedMedia(msg, null); // the fake adapter has nothing at this URL
    const spy = vi.spyOn(deps.adapter, "fetchMedia");

    await prefetchMedia(deps, [m.id], signal());
    expect(await row(m.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      errorCode: "media_download_failed",
      claimedUntil: null,
    });
    await prefetchMedia(deps, [m.id], signal());
    expect(await row(m.id)).toMatchObject({ status: "pending", attempts: 2 });
    // A pending row keeps its URL (and the adapter its source) for the retry; a failed one never
    // needs either again.
    expect((await row(m.id)).providerUrl).toBe(m.url);
    expect(deps.adapter.released).toEqual([]);
    await prefetchMedia(deps, [m.id], signal());
    expect(await row(m.id)).toMatchObject({
      status: "failed",
      attempts: policy.pipeline.mediaMaxAttempts,
      providerUrl: null,
    });

    await prefetchMedia(deps, [m.id], signal());
    expect(spy).toHaveBeenCalledTimes(3);
    expect(deps.storage.objects.size).toBe(0);
    expect(deps.adapter.released).toEqual([m.url]);
  });

  it("fails permanently on input no retry can fix", async () => {
    const msg = await seedMessage();
    const corrupt = await seedMedia(msg, randomBytes(4096));
    const empty = await seedMedia(msg, new Uint8Array());
    const huge = await seedMedia(msg, new Uint8Array(policy.pipeline.mediaMaxBytes + 1));
    const noUrl = await seedMedia(msg, null, { providerUrl: null });

    await prefetchMedia(deps, [corrupt.id, empty.id, huge.id, noUrl.id], signal());

    expect(await row(corrupt.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "image_unsupported",
      providerUrl: null,
    });
    expect(await row(empty.id)).toMatchObject({ status: "failed", attempts: 1, errorCode: "media_empty" });
    expect(await row(huge.id)).toMatchObject({ status: "failed", attempts: 1, errorCode: "media_too_large" });
    expect(await row(noUrl.id)).toMatchObject({ status: "failed", attempts: 1, errorCode: "media_no_url" });
    expect(deps.storage.objects.size).toBe(0);
  });

  it("takes over an expired claim but never a live one", async () => {
    const msg = await seedMessage();
    const m = await seedMedia(msg, await solidJpeg(32, 32), {
      status: "downloading",
      attempts: 1,
      claimedUntil: new Date(deps.clock.now().getTime() + 10_000),
    });
    const spy = vi.spyOn(deps.adapter, "fetchMedia");

    await prefetchMedia(deps, [m.id], signal());
    expect(spy).not.toHaveBeenCalled();
    expect((await row(m.id)).status).toBe("downloading");

    deps.clock.advance(10_001);
    await prefetchMedia(deps, [m.id], signal());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await row(m.id)).toMatchObject({ status: "stored", attempts: 2 });
  });

  it("a superseded claimer neither resets the new claim nor deletes the stored blob", async () => {
    const msg = await seedMessage();
    const m = await seedMedia(msg, await solidJpeg(32, 32));
    const gateA = deferred();
    const gateB = deferred();
    gateFetches(deps.adapter, [gateA, gateB]);

    const a = prefetchMedia(deps, [m.id], signal());
    await flush();
    expect(await row(m.id)).toMatchObject({ status: "downloading", attempts: 1 });

    // A stalls past its claim; B takes over.
    deps.clock.advance(policy.pipeline.mediaClaimMs + 1);
    const b = prefetchMedia(deps, [m.id], signal());
    await flush();
    expect(await row(m.id)).toMatchObject({ status: "downloading", attempts: 2 });

    // A's late failure is fenced off: B's claim stands.
    gateA.reject(new Error("socket hang up"));
    await a;
    expect(await row(m.id)).toMatchObject({ status: "downloading", attempts: 2, errorCode: null });

    gateB.resolve();
    await b;
    const stored = await row(m.id);
    expect(stored).toMatchObject({ status: "stored", attempts: 2 });

    // A stale claimer that finishes after B stored writes the same key and must not delete it.
    const gateC = deferred();
    await t.db
      .update(media)
      .set({ status: "pending", attempts: 0, providerUrl: fakeUrl() })
      .where(eq(media.id, m.id));
    const [{ providerUrl }] = await t.db.select({ providerUrl: media.providerUrl }).from(media).where(eq(media.id, m.id));
    deps.adapter.media.set(providerUrl!, { bytes: await solidJpeg(32, 32), contentType: "image/jpeg" });
    gateFetches(deps.adapter, [gateC]);
    const c = prefetchMedia(deps, [m.id], signal());
    await flush();
    // Meanwhile another invocation stores the row (same deterministic key).
    await t.db.update(media).set({ status: "stored" }).where(eq(media.id, m.id));
    gateC.resolve();
    await c;
    expect(deps.storage.objects.has(mediaKey(userId, m.id))).toBe(true);
  });

  it("deletes the blob it just wrote when the row vanished or failed mid-download", async () => {
    const msg = await seedMessage();
    const gone = await seedMedia(msg, await solidJpeg(32, 32));
    const gate = deferred();
    gateFetches(deps.adapter, [gate]);
    const p = prefetchMedia(deps, [gone.id], signal());
    await flush();
    await t.db.delete(media).where(eq(media.id, gone.id)); // e.g. the user texted DELETE
    gate.resolve();
    await p;
    expect(deps.storage.objects.size).toBe(0);

    const failed = await seedMedia(msg, await solidJpeg(32, 32));
    const gate2 = deferred();
    gateFetches(deps.adapter, [gate2]);
    const p2 = prefetchMedia(deps, [failed.id], signal());
    await flush();
    await t.db.update(media).set({ status: "failed" }).where(eq(media.id, failed.id));
    gate2.resolve();
    await p2;
    expect(deps.storage.objects.size).toBe(0);
  });

  it("gives the attempt back when the caller aborts", async () => {
    const msg = await seedMessage();
    const m = await seedMedia(msg, await solidJpeg(32, 32));
    gateFetches(deps.adapter, [deferred()]);
    const ac = new AbortController();
    const p = prefetchMedia(deps, [m.id], ac.signal);
    await flush();
    ac.abort(new Error("lease lost"));
    await p;
    expect(await row(m.id)).toMatchObject({ status: "pending", attempts: 0, errorCode: "media_aborted" });
  });

  it("fetches through the adapter of the provider that received the message", async () => {
    const sendblue = new FakeAdapter("sendblue");
    deps.adapters = registryOf(deps.adapter, sendblue);
    const msg = await seedMessage({ provider: "sendblue" });
    const m = await seedMedia(msg, await solidJpeg(16, 16), {}, sendblue);
    const sim = vi.spyOn(deps.adapter, "fetchMedia");
    const sb = vi.spyOn(sendblue, "fetchMedia");

    await prefetchMedia(deps, [m.id], signal());
    expect(sb).toHaveBeenCalledTimes(1);
    expect(sim).not.toHaveBeenCalled();
    expect((await row(m.id)).status).toBe("stored");

    const unknown = await seedMedia(await seedMessage({ provider: "linq" }), await solidJpeg(16, 16));
    await prefetchMedia(deps, [unknown.id], signal());
    expect(await row(unknown.id)).toMatchObject({ status: "failed", errorCode: "media_no_adapter" });
  });

  it("never logs provider URLs, phone numbers or storage keys", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const msg = await seedMessage();
    const ok = await seedMedia(msg, await solidJpeg(16, 16));
    const missing = await seedMedia(msg, null);
    const corrupt = await seedMedia(msg, randomBytes(100));
    await prefetchMedia(deps, [ok.id, missing.id, corrupt.id], signal());

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    for (const secret of [ok.url, missing.url, corrupt.url, "media.simulator.invalid", PHONE, "users/"]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("ensureMedia", () => {
  it("returns stored JPEGs as img1..N in the caller's message order", async () => {
    const base = deps.clock.now().getTime();
    const m1 = await seedMessage({ sentAt: new Date(base - 3000) });
    const m2 = await seedMessage({ sentAt: new Date(base - 2000) });
    const m3 = await seedMessage({ sentAt: new Date(base - 1000) });
    // Inserted in reverse so insertion order can't be what orders the result.
    const c = await seedMedia(m3, await solidJpeg(50, 20));
    const b = await seedMedia(m2, await solidJpeg(40, 20));
    const a = await seedMedia(m1, await solidJpeg(30, 20));
    // Another message's media is not part of this turn.
    await seedMedia(await seedMessage(), await solidJpeg(10, 10));

    const res = await ensureMedia(deps, [m1, m2, m3], signal());

    expect(res.failed).toEqual([]);
    expect(res.ready.map((r) => [r.ref, r.mediaId, r.inboundMessageId, r.width, r.height])).toEqual([
      ["img1", a.id, m1, 30, 20],
      ["img2", b.id, m2, 40, 20],
      ["img3", c.id, m3, 50, 20],
    ]);
    for (const img of res.ready) {
      expect(img.mediaType).toBe("image/jpeg");
      const meta = await sharp(Buffer.from(img.base64, "base64")).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", img.width, img.height]);
    }
    expect(deps.sleeper.calls).toEqual([]);
  });

  it("reports rows that can't be loaded as failed and still returns the rest", async () => {
    const m1 = await seedMessage();
    const m2 = await seedMessage();
    const ok = await seedMedia(m1, await solidJpeg(20, 20));
    const bad = await seedMedia(m2, null);

    const res = await ensureMedia(deps, [m1, m2], signal());

    expect(res.ready.map((r) => [r.ref, r.mediaId])).toEqual([["img1", ok.id]]);
    expect(res.failed).toEqual([{ mediaId: bad.id, inboundMessageId: m2 }]);
    // Retried inline up to the attempt limit, then failed for good.
    expect(await row(bad.id)).toMatchObject({ status: "failed", attempts: policy.pipeline.mediaMaxAttempts });
  });

  it("waits for a row another invocation is downloading", async () => {
    const msg = await seedMessage();
    const m = await seedMedia(msg, null, {
      status: "downloading",
      attempts: 1,
      claimedUntil: new Date(deps.clock.now().getTime() + policy.pipeline.mediaClaimMs),
    });

    const p = ensureMedia(deps, [msg], signal());
    while (deps.sleeper.calls.length < 3) await flush(1);
    // The other invocation finishes.
    const key = mediaKey(userId, m.id);
    await deps.storage.put(key, await solidJpeg(24, 12), "image/jpeg");
    await t.db
      .update(media)
      .set({ status: "stored", storageKey: key, width: 24, height: 12, claimedUntil: null })
      .where(eq(media.id, m.id));

    const res = await p;
    expect(res.ready.map((r) => [r.ref, r.mediaId, r.width])).toEqual([["img1", m.id, 24]]);
    expect(res.failed).toEqual([]);
    expect(deps.sleeper.calls.every((ms) => ms === 500)).toBe(true);
  });

  it("gives up after ensureMediaWaitMs and leaves the in-flight row to its downloader", async () => {
    const msg = await seedMessage();
    const m = await seedMedia(msg, null, {
      status: "downloading",
      attempts: 1,
      claimedUntil: new Date(deps.clock.now().getTime() + policy.pipeline.mediaClaimMs),
    });

    const res = await ensureMedia(deps, [msg], signal());

    expect(res).toEqual({ ready: [], failed: [{ mediaId: m.id, inboundMessageId: msg }] });
    expect(deps.sleeper.calls.reduce((s, ms) => s + ms, 0)).toBe(policy.pipeline.ensureMediaWaitMs);
    expect(await row(m.id)).toMatchObject({ status: "downloading", attempts: 1 });
  });

  it("fails rows nobody can claim any more", async () => {
    const msg = await seedMessage();
    const stale = await seedMedia(msg, await solidJpeg(8, 8), {
      status: "downloading",
      attempts: policy.pipeline.mediaMaxAttempts,
      claimedUntil: new Date(deps.clock.now().getTime() - 1),
    });
    const pending = await seedMedia(msg, await solidJpeg(8, 8), { attempts: policy.pipeline.mediaMaxAttempts });

    const res = await ensureMedia(deps, [msg], signal());

    expect(res.ready).toEqual([]);
    expect(res.failed.map((f) => f.mediaId).sort()).toEqual([stale.id, pending.id].sort());
    expect(await row(stale.id)).toMatchObject({
      status: "failed",
      errorCode: "media_attempts_exhausted",
      providerUrl: null,
    });
    expect(await row(pending.id)).toMatchObject({ status: "failed", providerUrl: null });
    expect(deps.sleeper.calls).toEqual([]);
  });

  it(`caps the turn at ${policy.pipeline.maxImagesPerTurn} images`, async () => {
    const msg = await seedMessage();
    for (let i = 0; i < policy.pipeline.maxImagesPerTurn + 2; i++) await seedMedia(msg, await solidJpeg(8 + i, 8));

    const res = await ensureMedia(deps, [msg], signal());

    expect(res.ready.map((r) => r.ref)).toEqual(
      Array.from({ length: policy.pipeline.maxImagesPerTurn }, (_, i) => `img${i + 1}`),
    );
    expect(res.failed).toEqual([]);
  });

  it("reports a stored row whose blob is missing as failed", async () => {
    const msg = await seedMessage();
    const m = await seedMedia(msg, null, {
      status: "stored",
      storageKey: "users/x/y.jpg",
      width: 10,
      height: 10,
      providerUrl: null,
    });
    const res = await ensureMedia(deps, [msg], signal());
    expect(res).toEqual({ ready: [], failed: [{ mediaId: m.id, inboundMessageId: msg }] });
  });

  it("reports an image whose blob can't be read as failed instead of failing the turn", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const m1 = await seedMessage();
    const m2 = await seedMessage();
    const ok = await seedMedia(m1, await solidJpeg(20, 20));
    const unreadable = await seedMedia(m2, await solidJpeg(20, 20));
    await prefetchMedia(deps, [ok.id, unreadable.id], signal());
    const badKey = mediaKey(userId, unreadable.id);
    const get = deps.storage.get.bind(deps.storage);
    vi.spyOn(deps.storage, "get").mockImplementation(async (key) => {
      if (key === badKey) throw Object.assign(new Error(`EACCES: permission denied, open '/srv/${key}'`), { code: "EACCES" });
      return get(key);
    });

    const res = await ensureMedia(deps, [m1, m2], signal());

    expect(res.ready.map((r) => [r.ref, r.mediaId])).toEqual([["img1", ok.id]]);
    expect(res.failed).toEqual([{ mediaId: unreadable.id, inboundMessageId: m2 }]);
    expect(lines.join("\n")).toContain("media.ready.read_failed");
    expect(lines.join("\n")).not.toContain("users/");
  });

  it("returns nothing for messages without media and rejects when already aborted", async () => {
    const msg = await seedMessage();
    expect(await ensureMedia(deps, [msg], signal())).toEqual({ ready: [], failed: [] });
    expect(await ensureMedia(deps, [], signal())).toEqual({ ready: [], failed: [] });

    await seedMedia(msg, await solidJpeg(8, 8));
    const ac = new AbortController();
    ac.abort(new Error("deadline"));
    await expect(ensureMedia(deps, [msg], ac.signal)).rejects.toThrow("deadline");
  });
});
