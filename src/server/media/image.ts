import { createHash } from "node:crypto";
import sharp, { type Metadata, type OutputInfo, type Sharp } from "sharp";
import { policy } from "@/server/config/policy";
import { AppError } from "@/server/errors";
import { decodeHeic } from "./heic";
import { resizedSize } from "./resize";

// Inbound photo processing (D-050, D-051). Decode (HEIC/HEIF in the worker, everything else with
// sharp), apply the EXIF orientation, downscale to exactly the size the API would resize to, and
// re-encode as JPEG. sharp drops every metadata block on output unless asked to keep it (EXIF
// including GPS, XMP, IPTC, ICC) and converts to sRGB, so nothing identifying survives.

// libvips' operation cache would keep decoded health photos in memory between requests.
sharp.cache(false);

// Decompression-bomb guard (policy.media.maxInputPixels): checked against header dimensions
// before any pixels are decoded.

export type ImageType = "jpeg" | "png" | "gif" | "webp" | "heic" | "avif";

export interface ProcessedImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
  /** Hex sha256 of the output JPEG. */
  sha256: string;
  sourceType: ImageType;
}

/** Error codes (AppError.errorCode) and whether retrying the same bytes could ever help. */
export const IMAGE_ERROR_RETRYABLE: Record<string, boolean> = {
  image_unsupported: false,
  image_corrupt: false,
  image_too_many_pixels: false,
  image_decode_timeout: true,
  image_decoder_unavailable: true,
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
/** Generic HEIF brands: the codec is named by a compatible brand, if at all. */
const HEIF_STRUCTURAL_BRANDS = new Set(["mif1", "msf1"]);

/** Identifies an image from its magic bytes; null if it isn't a format we accept. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  return sniffIsoBmff(bytes);
}

function sniffIsoBmff(bytes: Uint8Array): ImageType | null {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return null;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  // ftyp is always a small box; 0 ("to end of file") and 1 (64-bit size) never occur here.
  if (boxSize < 16) return null;
  const major = ascii(bytes, 8, 12);
  const compatible: string[] = [];
  for (let i = 16; i + 4 <= Math.min(boxSize, bytes.length); i += 4) compatible.push(ascii(bytes, i, i + 4));

  if (AVIF_BRANDS.has(major)) return "avif";
  if (HEIC_BRANDS.has(major)) return "heic";
  if (compatible.some((b) => AVIF_BRANDS.has(b))) return "avif";
  if (compatible.some((b) => HEIC_BRANDS.has(b))) return "heic";
  // A bare mif1/msf1 file: iPhone-style HEVC is by far the most common content.
  if (HEIF_STRUCTURAL_BRANDS.has(major)) return "heic";
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (bytes.length < end) return "";
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * Decodes, auto-orients, resizes (downscale only) and re-encodes an image as a metadata-free JPEG.
 * Animated images contribute their first frame. Rejects with AppError (see IMAGE_ERROR_RETRYABLE).
 */
export async function processImage(bytes: Uint8Array, opts: { signal?: AbortSignal } = {}): Promise<ProcessedImage> {
  const sourceType = sniffImageType(bytes);
  if (!sourceType) throw new AppError("image_unsupported");

  const { pipeline, width, height } =
    sourceType === "heic" ? await fromHeic(bytes, opts.signal) : await fromEncoded(bytes);
  opts.signal?.throwIfAborted();

  const [w, h] = resizedSize(width, height, policy.media.maxEdge, policy.media.maxVisualTokens);
  const sized = w === width && h === height ? pipeline : pipeline.resize(w, h, { fit: "fill" });

  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sized
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: policy.media.jpegQuality })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw sharpError(err);
  }
  if (out.info.width !== w || out.info.height !== h) throw new AppError("image_corrupt");

  return {
    jpeg: out.data,
    width: w,
    height: h,
    sha256: createHash("sha256").update(out.data).digest("hex"),
    sourceType,
  };
}

async function fromEncoded(bytes: Uint8Array): Promise<{ pipeline: Sharp; width: number; height: number }> {
  // pages: 1 reads only the first frame of an animated GIF/WebP. failOn "warning" is sharp's
  // recommendation for untrusted input; "error" let corrupt entropy data decode into noise.
  const pipeline = sharp(bytes, { autoOrient: true, failOn: "warning", limitInputPixels: policy.media.maxInputPixels, pages: 1 });
  let meta: Metadata;
  try {
    meta = await pipeline.metadata();
  } catch (err) {
    throw sharpError(err);
  }
  // Dimensions after the EXIF orientation is applied (Orientation 5-8 swap width and height).
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) throw new AppError("image_corrupt");
  if (width * height > policy.media.maxInputPixels) throw new AppError("image_too_many_pixels");
  return { pipeline, width, height };
}

async function fromHeic(
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<{ pipeline: Sharp; width: number; height: number }> {
  // libheif applies the HEIF irot/imir transforms itself, so the pixels are already upright and
  // the raw buffer carries no metadata at all.
  const raw = await decodeHeic(bytes, { maxPixels: policy.media.maxInputPixels, signal });
  const pipeline = sharp(raw.rgba, {
    raw: { width: raw.width, height: raw.height, channels: 4 },
    limitInputPixels: policy.media.maxInputPixels,
  });
  return { pipeline, width: raw.width, height: raw.height };
}

function sharpError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : "";
  if (/pixel limit/i.test(message)) return new AppError("image_too_many_pixels");
  if (/unsupported image format/i.test(message)) return new AppError("image_unsupported");
  return new AppError("image_corrupt");
}
