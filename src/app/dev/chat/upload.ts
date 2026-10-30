import { SIM_UPLOAD_LIMITS } from "@/server/channels/simulator/limits";

// Client-side preparation of photo uploads. Images the browser can decode are downscaled to the
// model's high-res long edge (D-051) and re-encoded as JPEG. HEIC goes up raw: most browsers can't
// decode it, and the server converts it (D-052). A selection too big for one request is split
// into several posts (see SIM_UPLOAD_LIMITS.maxRequestBytes).

export const MAX_UPLOAD_BYTES = SIM_UPLOAD_LIMITS.maxFileBytes;
const MAX_EDGE = 2_576;
/** Multipart headers per file, plus room for the other fields and the text. */
const PART_OVERHEAD = 1_024;
const REQUEST_MARGIN = 64 * 1024;
const PASSTHROUGH_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const HEIC_NAME = /\.(heic|heif)$/i;

export function isHeic(file: File): boolean {
  return /^image\/hei[cf]/i.test(file.type) || HEIC_NAME.test(file.name);
}

export async function prepareUpload(file: File): Promise<File> {
  if (isHeic(file)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= MAX_EDGE && file.size <= MAX_UPLOAD_BYTES && PASSTHROUGH_TYPES.has(file.type)) return file;
    const scale = Math.min(1, MAX_EDGE / longEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // JPEG has no alpha: flatten transparent PNGs onto white rather than black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) return file;
    const base = file.name.replace(/\.[^.]*$/, "") || "photo";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

/** Groups files into posts that each fit one request; always returns at least one (maybe empty) group. */
export function splitIntoPosts(files: File[]): File[][] {
  const budget = SIM_UPLOAD_LIMITS.maxRequestBytes - REQUEST_MARGIN;
  const groups: File[][] = [];
  let current: File[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = file.size + PART_OVERHEAD;
    if (current.length > 0 && (bytes + size > budget || current.length >= SIM_UPLOAD_LIMITS.maxFilesPerPost)) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  groups.push(current);
  return groups;
}

/** A message id for dedupe; crypto.randomUUID needs a secure context, which a LAN IP isn't. */
export function newMessageId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
