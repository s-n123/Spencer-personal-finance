// Port of Anthropic's reference implementation from "Coordinates and bounding boxes → Resize your
// image before uploading" (platform.claude.com/docs/en/build-with-claude/vision-coordinates,
// read 2026-10-30). Behaviour must match it exactly: if we send precisely the size the API would
// resize to, the API never resamples our image again. Only input validation is added.

/** Patch size: one visual token per 28×28 pixel patch. */
const PATCH_PX = 28;

/** Visual tokens consumed by an image: one token for each 28x28 pixel patch. */
export function countImageTokens(width: number, height: number): number {
  return Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX);
}

/**
 * Round half to even (banker's rounding), matching Python's round(). The live API resolves exact
 * .5 ties toward the even neighbour; Math.round (halves up) would compute a different size for
 * some images.
 */
export function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) {
    return Math.round(value);
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The size Claude resizes an image to before padding, as [width, height]. Images that already fit
 * both limits are returned unchanged. The reference defaults to the standard tier (1568/1568);
 * here the limits are required so a caller can't silently get the wrong tier (policy.media holds
 * the high-resolution tier, 2576/4784).
 */
export function resizedSize(width: number, height: number, maxEdge: number, maxTokens: number): [number, number] {
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    throw new RangeError("image dimensions must be positive integers");
  }
  if (!isPositiveInteger(maxEdge) || !isPositiveInteger(maxTokens)) {
    throw new RangeError("image limits must be positive integers");
  }

  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / PATCH_PX) * PATCH_PX <= maxEdge &&
    Math.ceil(h / PATCH_PX) * PATCH_PX <= maxEdge &&
    countImageTokens(w, h) <= maxTokens;

  if (fits(width, height)) {
    return [width, height];
  }
  if (height > width) {
    const [resizedH, resizedW] = resizedSize(height, width, maxEdge, maxTokens);
    return [resizedW, resizedH];
  }

  // Binary search along the long edge for the largest aspect-preserving size that fits.
  const aspectRatio = width / height;
  let lo = 1; // lo always fits
  let hi = width; // hi never fits
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(roundTiesToEven(mid / aspectRatio), 1))) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return [lo, Math.max(roundTiesToEven(lo / aspectRatio), 1)];
}

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}
