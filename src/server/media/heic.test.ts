import { afterAll, describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { exampleHeic, solidJpeg } from "@/test/fixtures/images";
import { closeHeicWorker, decodeHeic } from "./heic";
import { decodeHeicBytes } from "./heic-worker";

const MAX_PIXELS = 80_000_000;

afterAll(async () => {
  await closeHeicWorker();
});

/** The live worker's thread id (internal state, read only to prove reuse and replacement). */
function workerThreadId(): number | undefined {
  const holder = (globalThis as { __nutritionCoachHeicDecoder?: { current?: { worker: { threadId: number } } } })
    .__nutritionCoachHeicDecoder;
  return holder?.current?.worker.threadId;
}

function errorCodeOf(e: unknown): string {
  return e instanceof AppError ? e.errorCode : `not AppError: ${String(e)}`;
}

async function errorCode(p: Promise<unknown>): Promise<string | null> {
  return p.then(() => null, errorCodeOf);
}

describe("decodeHeic (worker thread)", () => {
  it("decodes libheif's sample to RGBA in a reused worker", async () => {
    const input = exampleHeic();
    const a = await decodeHeic(input, { maxPixels: MAX_PIXELS });
    expect([a.width, a.height]).toEqual([1280, 854]);
    expect(a.rgba.length).toBe(1280 * 854 * 4);
    // The caller's buffer is copied, not transferred away.
    expect(input.length).toBe(718_114);

    const first = workerThreadId();
    expect(first).toBeGreaterThan(0);
    const b = await decodeHeic(input, { maxPixels: MAX_PIXELS });
    expect(b.width).toBe(1280);
    expect(workerThreadId()).toBe(first);
  });

  it("handles concurrent decodes", async () => {
    const input = exampleHeic();
    const results = await Promise.all([1, 2, 3].map(() => decodeHeic(input, { maxPixels: MAX_PIXELS })));
    expect(results.map((r) => r.width)).toEqual([1280, 1280, 1280]);
  });

  it("times out, replaces the stuck worker, and recovers", async () => {
    await decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS });
    const before = workerThreadId();
    expect(await errorCode(decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS, timeoutMs: 1 }))).toBe(
      "image_decode_timeout",
    );
    const again = await decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS });
    expect(again.width).toBe(1280);
    expect(workerThreadId()).not.toBe(before);
  });

  it("rejects with the caller's abort reason without killing the worker", async () => {
    const pre = new AbortController();
    pre.abort(new Error("already aborted"));
    await expect(decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS, signal: pre.signal })).rejects.toThrow(
      "already aborted",
    );

    await decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS });
    const before = workerThreadId();
    const ac = new AbortController();
    const p = decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS, signal: ac.signal });
    ac.abort(new Error("lease lost"));
    await expect(p).rejects.toThrow("lease lost");
    expect((await decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS })).width).toBe(1280);
    expect(workerThreadId()).toBe(before);
  });

  it("times only the running decode: a queue of decodes on a busy worker never times out", async () => {
    const input = exampleHeic();
    await decodeHeic(input, { maxPixels: MAX_PIXELS });
    const started = performance.now();
    await decodeHeic(input, { maxPixels: MAX_PIXELS });
    const single = performance.now() - started;
    const before = workerThreadId();

    // Each decode gets several times what one takes, but the whole queue needs far longer.
    const timeoutMs = Math.ceil(single * 5 + 200);
    const queuedAt = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => decodeHeic(input, { maxPixels: MAX_PIXELS, timeoutMs })),
    );
    expect(performance.now() - queuedAt).toBeGreaterThan(timeoutMs);
    expect(results.map((r) => r.status)).toEqual(Array(16).fill("fulfilled"));
    expect(workerThreadId()).toBe(before);
  });

  it("a timeout fails only the stuck decode; the queue continues in a fresh worker", async () => {
    const input = exampleHeic();
    await decodeHeic(input, { maxPixels: MAX_PIXELS });
    const before = workerThreadId();
    const [stuck, ...queued] = await Promise.allSettled([
      decodeHeic(input, { maxPixels: MAX_PIXELS, timeoutMs: 1 }),
      decodeHeic(input, { maxPixels: MAX_PIXELS }),
      decodeHeic(input, { maxPixels: MAX_PIXELS }),
    ]);
    expect(stuck.status === "rejected" && (stuck.reason as AppError).errorCode).toBe("image_decode_timeout");
    expect(queued.map((r) => r.status === "fulfilled" && r.value.width)).toEqual([1280, 1280]);
    expect(workerThreadId()).not.toBe(before);
  });

  it("a decode aborted while queued is dropped and the others still complete", async () => {
    const input = exampleHeic();
    const ac = new AbortController();
    const first = decodeHeic(input, { maxPixels: MAX_PIXELS });
    const dropped = decodeHeic(input, { maxPixels: MAX_PIXELS, signal: ac.signal });
    const last = decodeHeic(input, { maxPixels: MAX_PIXELS });
    ac.abort(new Error("turn deadline"));
    await expect(dropped).rejects.toThrow("turn deadline");
    expect([(await first).width, (await last).width]).toEqual([1280, 1280]);
  });

  it("closeHeicWorker fails queued and running decodes instead of leaving them hanging", async () => {
    const input = exampleHeic();
    const pending = [1, 2, 3].map(() => decodeHeic(input, { maxPixels: MAX_PIXELS }).then(() => "ok", errorCodeOf));
    await closeHeicWorker();
    expect(await Promise.all(pending)).toEqual(Array(3).fill("image_decoder_unavailable"));
    expect((await decodeHeic(input, { maxPixels: MAX_PIXELS })).width).toBe(1280);
  });

  it("maps decoder failures to image error codes", async () => {
    expect(await errorCode(decodeHeic(exampleHeic(), { maxPixels: 1000 }))).toBe("image_too_many_pixels");
    expect(await errorCode(decodeHeic(await solidJpeg(8, 8), { maxPixels: MAX_PIXELS }))).toBe("image_unsupported");
    const truncated = exampleHeic().subarray(0, 4096);
    expect(await errorCode(decodeHeic(truncated, { maxPixels: MAX_PIXELS }))).toBe("image_corrupt");
  });

  it("starts a fresh worker after closeHeicWorker", async () => {
    await decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS });
    const before = workerThreadId();
    await closeHeicWorker();
    expect(workerThreadId()).toBeUndefined();
    await decodeHeic(exampleHeic(), { maxPixels: MAX_PIXELS });
    expect(workerThreadId()).not.toBe(before);
  });
});

describe("decodeHeicBytes (the worker's decode, run in-process)", () => {
  it("decodes and reports failures as codes instead of throwing", async () => {
    const ok = await decodeHeicBytes(exampleHeic(), MAX_PIXELS);
    expect(ok.ok && [ok.width, ok.height]).toEqual([1280, 854]);
    expect(await decodeHeicBytes(exampleHeic(), 10)).toEqual({ ok: false, code: "heic_too_many_pixels" });
    expect(await decodeHeicBytes(new Uint8Array(64), MAX_PIXELS)).toEqual({ ok: false, code: "heic_unsupported" });
  });
});
