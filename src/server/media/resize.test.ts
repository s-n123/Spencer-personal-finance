import { describe, expect, it } from "vitest";
import { policy } from "@/server/config/policy";
import { countImageTokens, resizedSize, roundTiesToEven } from "./resize";

const STANDARD = [1568, 1568] as const;
const HIGH_RES = [2576, 4784] as const;

// [width, height, maxEdge, maxTokens, expectedWidth, expectedHeight], computed by running the
// Python reference from the same docs page (Python's round() is ties-to-even), 2026-10-30.
const REFERENCE: [number, number, number, number, number, number][] = [
  [8935, 3601, 2576, 4784, 2576, 1038],
  [6748, 613, 2576, 4784, 2576, 234],
  [10398, 4425, 1568, 1568, 1568, 667],
  [5560, 4736, 2576, 4784, 2072, 1765],
  [2324, 10785, 1568, 1568, 338, 1568],
  [2628, 1360, 1568, 1568, 1515, 784],
  [4657, 2314, 2576, 4784, 2576, 1280],
  [7229, 8843, 2576, 4784, 1736, 2124],
  [7933, 5527, 2576, 4784, 2296, 1600],
  [4976, 11233, 2576, 4784, 1141, 2576],
  [9100, 9943, 1568, 1568, 1051, 1148],
  [9352, 11526, 1568, 1568, 980, 1208],
  [1193, 8137, 2576, 4784, 378, 2576],
  [2498, 3849, 1568, 1568, 890, 1372],
  [3644, 5152, 1568, 1568, 924, 1307],
  [8546, 4441, 1568, 1568, 1512, 786],
  [10582, 10299, 1568, 1568, 1120, 1090],
  [651, 11938, 2576, 4784, 140, 2576],
  [7716, 7501, 1568, 1568, 1120, 1089],
  [5379, 225, 1568, 1568, 1568, 66],
  [6159, 4776, 2576, 4784, 2184, 1694],
  [11729, 6956, 1568, 1568, 1417, 840],
  [5915, 5233, 1568, 1568, 1171, 1036],
  [3247, 1372, 2576, 4784, 2576, 1088],
  // iPhone 12/24/48 MP photos, both orientations.
  [4032, 3024, 2576, 4784, 2212, 1659],
  [3024, 4032, 2576, 4784, 1659, 2212],
  [5712, 4284, 2576, 4784, 2212, 1659],
  [8064, 6048, 2576, 4784, 2212, 1659],
  [8064, 6048, 1568, 1568, 1270, 952],
  // Phone screenshot, panorama, degenerate strips, squares.
  [1170, 2532, 1568, 1568, 725, 1568],
  [1170, 2532, 2576, 4784, 1170, 2532],
  [16000, 4000, 2576, 4784, 2576, 644],
  [1, 30000, 2576, 4784, 1, 2576],
  [30000, 1, 1568, 1568, 1568, 1],
  [2576, 2576, 1568, 1568, 1092, 1092],
  [2576, 2576, 2576, 4784, 1932, 1932],
  [2577, 10, 1568, 1568, 1568, 6],
  [2577, 10, 2576, 4784, 2576, 10],
];

function fits(w: number, h: number, maxEdge: number, maxTokens: number): boolean {
  return (
    Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && countImageTokens(w, h) <= maxTokens
  );
}

/** Small deterministic PRNG (mulberry32) so the property test is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("resizedSize (port of Anthropic's reference implementation)", () => {
  it("matches the documented examples", () => {
    // A4 scan at 130 DPI: under the edge limit but over the standard token budget.
    expect(countImageTokens(1075, 1520)).toBe(2145);
    expect(resizedSize(1075, 1520, ...STANDARD)).toEqual([924, 1307]);
    // A 1920×1080 screenshot resizes to 1456×819, not 1568×882.
    expect(resizedSize(1920, 1080, ...STANDARD)).toEqual([1456, 819]);
    // The high-resolution tier keeps the same scan unchanged.
    expect(resizedSize(1075, 1520, ...HIGH_RES)).toEqual([1075, 1520]);
  });

  it("policy uses the high-resolution tier (D-051)", () => {
    expect([policy.media.maxEdge, policy.media.maxVisualTokens]).toEqual([...HIGH_RES]);
  });

  it.each(REFERENCE)("%i×%i at %i/%i → %i×%i (Python reference)", (w, h, edge, tokens, ew, eh) => {
    expect(resizedSize(w, h, edge, tokens)).toEqual([ew, eh]);
  });

  it("resolves .5 ties toward even like the live API (a 4:3 photo on the standard tier)", () => {
    // Half-up rounding would give 1269×952 for these; the reference gives 1270×952.
    expect(resizedSize(4032, 3024, ...STANDARD)).toEqual([1270, 952]);
    expect(resizedSize(1280, 960, ...STANDARD)).toEqual([1270, 952]);
    expect(resizedSize(960, 1280, ...STANDARD)).toEqual([952, 1270]);
  });

  it("handles tall and rotated images symmetrically", () => {
    expect(resizedSize(1080, 1920, ...STANDARD)).toEqual([819, 1456]);
    expect(resizedSize(1520, 1075, ...STANDARD)).toEqual([1307, 924]);
    for (const [w, h] of [
      [4032, 3024],
      [1170, 2532],
      [16000, 4000],
    ]) {
      const [a, b] = resizedSize(w, h, ...HIGH_RES);
      expect(resizedSize(h, w, ...HIGH_RES)).toEqual([b, a]);
    }
  });

  it("returns images that already fit unchanged", () => {
    for (const [w, h] of [
      [1, 1],
      [10, 10],
      [28, 28],
      [640, 480],
      [1568, 1],
    ]) {
      expect(resizedSize(w, h, ...STANDARD)).toEqual([w, h]);
      expect(resizedSize(w, h, ...HIGH_RES)).toEqual([w, h]);
    }
  });

  it("rejects non-positive or fractional sizes", () => {
    expect(() => resizedSize(0, 10, ...STANDARD)).toThrow(RangeError);
    expect(() => resizedSize(10, -1, ...STANDARD)).toThrow(RangeError);
    expect(() => resizedSize(10.5, 10, ...STANDARD)).toThrow(RangeError);
    expect(() => resizedSize(Number.NaN, 10, ...STANDARD)).toThrow(RangeError);
    expect(() => resizedSize(10, 10, 0, 1568)).toThrow(RangeError);
  });

  it("property: always fits both limits, never upscales, keeps the aspect ratio, and is maximal", () => {
    const rand = prng(20261030);
    for (let i = 0; i < 3000; i++) {
      const w = 1 + Math.floor(rand() * 16000);
      const h = 1 + Math.floor(rand() * 16000);
      const [edge, tokens] = rand() < 0.5 ? STANDARD : HIGH_RES;
      const [rw, rh] = resizedSize(w, h, edge, tokens);
      const label = `${w}×${h} @ ${edge}/${tokens} → ${rw}×${rh}`;

      expect(fits(rw, rh, edge, tokens), label).toBe(true);
      expect(rw <= w && rh <= h, label).toBe(true);
      if (rw === w && rh === h) continue;

      // The short side is the rounded long side divided by the aspect ratio.
      if (w >= h) {
        if (rh > 1) expect(Math.abs(rh - (rw * h) / w), label).toBeLessThanOrEqual(0.5);
        expect(fits(rw + 1, Math.max(roundTiesToEven(((rw + 1) * h) / w), 1), edge, tokens), label).toBe(false);
      } else {
        if (rw > 1) expect(Math.abs(rw - (rh * w) / h), label).toBeLessThanOrEqual(0.5);
        expect(fits(Math.max(roundTiesToEven(((rh + 1) * w) / h), 1), rh + 1, edge, tokens), label).toBe(false);
      }
    }
  });
});

describe("roundTiesToEven", () => {
  it("matches Python's round()", () => {
    expect([0.5, 1.5, 2.5, 3.5, -0.5, -1.5].map(roundTiesToEven)).toEqual([0, 2, 2, 4, 0, -2]);
    expect([2.4, 2.6, 7, 0.49999].map(roundTiesToEven)).toEqual([2, 3, 7, 0]);
  });
});

describe("countImageTokens", () => {
  it("counts one token per started 28×28 patch", () => {
    expect(countImageTokens(28, 28)).toBe(1);
    expect(countImageTokens(29, 28)).toBe(2);
    expect(countImageTokens(1456, 819)).toBe(52 * 30);
  });
});
