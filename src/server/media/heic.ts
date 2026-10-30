import { Worker } from "node:worker_threads";
import { policy } from "@/server/config/policy";
import { AppError, logError } from "@/server/errors";
import { fireAndForget } from "@/server/safe";
// Type-only: a runtime import would pull the 2 MB WASM bundle into the main-thread chunk too.
import type { HeicErrorCode, HeicRequest, HeicResponse } from "./heic-worker";

// Runs HEIC decodes in one lazily created worker thread, reused across calls (D-052). Decodes
// wait in a FIFO here and go to the worker one at a time, so the timeout measures the decode
// itself, never time spent queued behind other users' photos on a busy instance. A decode that
// exceeds its timeout terminates the worker (a synchronous WASM decode can't be cancelled any
// other way); only that decode fails, and the queue carries on in a fresh worker. The worker is
// unref'd while it has no live work so it never keeps a script or test process alive.
//
// The worker is spawned from `new URL("./heic-worker.ts", import.meta.url)`: Node runs it with
// built-in type stripping (Vitest, tsx scripts) and Next.js bundles it as a separate worker entry.
// There is no in-process fallback: a failed spawn is reported as a retryable media error.

export interface RawImage {
  width: number;
  height: number;
  /** 8-bit RGBA, width * height * 4 bytes. */
  rgba: Uint8Array;
}

interface Job {
  id: number;
  /** A private copy of the input, transferred to the worker on dispatch. */
  bytes: ArrayBuffer;
  maxPixels: number;
  timeoutMs: number;
  /** Set once the caller has its answer (result, error or its own abort); later outcomes are dropped. */
  settled: boolean;
  resolve(img: RawImage): void;
  reject(err: unknown): void;
}

interface HeicWorker {
  worker: Worker;
  /** The decode the worker is running; its timer starts at dispatch. */
  active: { job: Job; timeout: AbortSignal; onTimeout: () => void } | null;
}

interface Holder {
  current?: HeicWorker;
  queue: Job[];
  nextId: number;
}

// Process-wide (like the DB pool), kept on globalThis so dev HMR doesn't leak workers.
const holder: Holder = ((globalThis as { __nutritionCoachHeicDecoder?: Holder }).__nutritionCoachHeicDecoder ??= {
  queue: [],
  nextId: 1,
});

const ERROR_CODES: Record<HeicErrorCode, string> = {
  heic_unsupported: "image_unsupported",
  heic_too_many_pixels: "image_too_many_pixels",
  heic_decode_failed: "image_corrupt",
};

function succeed(job: Job, img: RawImage): void {
  if (job.settled) return;
  job.settled = true;
  job.resolve(img);
}

function fail(job: Job, err: unknown): void {
  if (job.settled) return;
  job.settled = true;
  job.reject(err);
}

function spawn(): HeicWorker {
  const worker = new Worker(new URL("./heic-worker.ts", import.meta.url), {
    name: "heic-decode",
    // Must match HEIC_WORKER_MARKER in heic-worker.ts.
    workerData: { nutritionCoachHeicWorker: true },
  });
  const state: HeicWorker = { worker, active: null };

  worker.on("message", (res: HeicResponse) => {
    // Anything else is a decode that already timed out on a worker we replaced.
    const job = state.active?.job.id === res.id ? finishActive(state) : null;
    if (!job) return;
    if (res.ok) succeed(job, { width: res.width, height: res.height, rgba: new Uint8Array(res.rgba) });
    else fail(job, new AppError(ERROR_CODES[res.code]));
    pump();
  });
  worker.on("error", (err) => {
    logError("media.heic.worker_error", err);
    retire(state);
  });
  worker.on("exit", () => retire(state));
  return state;
}

function finishActive(state: HeicWorker): Job | null {
  const active = state.active;
  if (!active) return null;
  active.timeout.removeEventListener("abort", active.onTimeout);
  state.active = null;
  return active.job;
}

/** Forgets a crashed or exited worker, fails the decode it was running, and resumes the queue. */
function retire(state: HeicWorker): void {
  if (holder.current === state) holder.current = undefined;
  const job = finishActive(state);
  if (job) fail(job, new AppError("image_decoder_unavailable"));
  pump();
}

/** Sends the next queued decode to the worker if it is idle, spawning one if needed. */
function pump(): void {
  while (!holder.current?.active) {
    const job = holder.queue.shift();
    if (!job) break;
    if (job.settled) continue;
    let state: HeicWorker;
    try {
      state = holder.current ??= spawn();
    } catch (err) {
      logError("media.heic.spawn_failed", err);
      fail(job, new AppError("image_decoder_unavailable"));
      continue;
    }
    dispatch(state, job);
  }
  refreshRef();
}

function dispatch(state: HeicWorker, job: Job): void {
  const timeout = AbortSignal.timeout(job.timeoutMs);
  const onTimeout = () => {
    if (state.active?.job !== job) return;
    finishActive(state);
    fail(job, new AppError("image_decode_timeout"));
    // The worker is stuck in a synchronous decode; replace it.
    if (holder.current === state) holder.current = undefined;
    fireAndForget("media.heic.terminate", state.worker.terminate());
    pump();
  };
  timeout.addEventListener("abort", onTimeout, { once: true });
  state.active = { job, timeout, onTimeout };
  const req: HeicRequest = { id: job.id, bytes: job.bytes, maxPixels: job.maxPixels };
  try {
    state.worker.postMessage(req, [job.bytes]);
  } catch (err) {
    finishActive(state);
    logError("media.heic.post_failed", err);
    fail(job, new AppError("image_decoder_unavailable"));
  }
}

/** Keeps the worker ref'd only while a caller is still waiting on it. */
function refreshRef(): void {
  const state = holder.current;
  if (!state) return;
  const live = (state.active !== null && !state.active.job.settled) || holder.queue.some((j) => !j.settled);
  if (live) state.worker.ref();
  else state.worker.unref();
}

/** Decodes a HEIC/HEIF image to RGBA off the main thread. Rejects with AppError codes. */
export function decodeHeic(
  bytes: Uint8Array,
  opts: { maxPixels: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<RawImage> {
  return new Promise<RawImage>((resolve, reject) => {
    const signal = opts.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      const i = holder.queue.indexOf(job);
      if (i >= 0) holder.queue.splice(i, 1);
      // A decode already running is left to finish (or time out); its result is dropped.
      fail(job, signal?.reason);
      refreshRef();
    };
    const job: Job = {
      id: holder.nextId++,
      // Copy, then transfer the copy: the caller's buffer may be a view into a shared pool slab.
      bytes: new Uint8Array(bytes).buffer,
      maxPixels: opts.maxPixels,
      timeoutMs: opts.timeoutMs ?? policy.media.heicDecodeTimeoutMs,
      settled: false,
      resolve: (img) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(img);
      },
      reject: (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    holder.queue.push(job);
    pump();
  });
}

/** Terminates the worker and fails every queued or running decode (tests and scripts). */
export async function closeHeicWorker(): Promise<void> {
  for (const job of holder.queue.splice(0)) fail(job, new AppError("image_decoder_unavailable"));
  const state = holder.current;
  if (!state) return;
  holder.current = undefined;
  const job = finishActive(state);
  if (job) fail(job, new AppError("image_decoder_unavailable"));
  await state.worker.terminate();
}
