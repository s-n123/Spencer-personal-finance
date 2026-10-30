import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

// HEIC/HEIF decoding (libheif compiled to WASM via heic-decode, LGPL-3.0; DECISIONS D-052).
// The decode is synchronous and CPU-heavy, so heic.ts runs this file in a worker thread to keep
// it off the shared event loop. This file is also loaded directly by Node in tests and scripts,
// so it must stay plain Node: only node: imports, erasable TypeScript, no "@/" aliases.

export type HeicErrorCode = "heic_unsupported" | "heic_too_many_pixels" | "heic_decode_failed";

export interface HeicRequest {
  id: number;
  /** Transferred to the worker; the caller keeps its own copy. */
  bytes: ArrayBuffer;
  maxPixels: number;
}

export type HeicResponse =
  | { id: number; ok: true; width: number; height: number; rgba: ArrayBuffer }
  | { id: number; ok: false; code: HeicErrorCode };

export type HeicResult =
  | { ok: true; width: number; height: number; rgba: Uint8ClampedArray }
  | { ok: false; code: HeicErrorCode };

/** workerData marker, so importing this module elsewhere never attaches a listener. */
export const HEIC_WORKER_MARKER = "nutritionCoachHeicWorker";

// heic-decode ships no type declarations; this is the subset we use.
interface HeicImage {
  width: number;
  height: number;
  decode(): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}
type HeicImageList = HeicImage[] & { dispose(): void };
interface HeicDecodeModule {
  all(input: { buffer: Uint8Array }): Promise<HeicImageList>;
}

let heic: HeicDecodeModule | undefined;

function loadHeicDecode(): HeicDecodeModule {
  // Loaded on first use: the WASM bundle is ~2 MB and only HEIC uploads need it.
  heic ??= createRequire(import.meta.url)("heic-decode") as HeicDecodeModule;
  return heic;
}

/** Decodes the primary image to RGBA. Never throws; failures come back as codes. */
export async function decodeHeicBytes(bytes: Uint8Array, maxPixels: number): Promise<HeicResult> {
  let images: HeicImageList;
  try {
    images = await loadHeicDecode().all({ buffer: bytes });
  } catch (err) {
    // heic-decode throws TypeError when the ftyp brand isn't one it handles.
    return { ok: false, code: err instanceof TypeError ? "heic_unsupported" : "heic_decode_failed" };
  }
  try {
    const first = images[0];
    if (!first) return { ok: false, code: "heic_decode_failed" };
    // Checked before decoding: the RGBA buffer alone is 4 bytes per pixel.
    if (first.width * first.height > maxPixels) return { ok: false, code: "heic_too_many_pixels" };
    const { width, height, data } = await first.decode();
    if (data.length !== width * height * 4) return { ok: false, code: "heic_decode_failed" };
    return { ok: true, width, height, rgba: data };
  } catch {
    return { ok: false, code: "heic_decode_failed" };
  } finally {
    images.dispose();
  }
}

async function handle(req: HeicRequest): Promise<{ res: HeicResponse; transfer: ArrayBuffer[] }> {
  const result = await decodeHeicBytes(new Uint8Array(req.bytes), req.maxPixels);
  if (!result.ok) return { res: { id: req.id, ok: false, code: result.code }, transfer: [] };
  const rgba = result.rgba.buffer as ArrayBuffer;
  return {
    res: { id: req.id, ok: true, width: result.width, height: result.height, rgba },
    transfer: [rgba],
  };
}

const port = parentPort;
const isHeicWorker =
  !isMainThread &&
  port !== null &&
  typeof workerData === "object" &&
  workerData !== null &&
  (workerData as Record<string, unknown>)[HEIC_WORKER_MARKER] === true;

if (isHeicWorker && port) {
  // libheif prints parse errors straight to the console; failures already come back as codes, and
  // only log.ts may write logs.
  const silent = () => undefined;
  console.log = silent;
  console.info = silent;
  console.warn = silent;
  console.error = silent;
  port.on("message", (req: HeicRequest) => {
    handle(req).then(
      ({ res, transfer }) => port.postMessage(res, transfer),
      () => port.postMessage({ id: req.id, ok: false, code: "heic_decode_failed" } satisfies HeicResponse),
    );
  });
}
