import { createHash, randomBytes } from "node:crypto";
import exifr from "exifr";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { policy } from "@/server/config/policy";
import { AppError } from "@/server/errors";
import {
  exampleHeic,
  ftyp,
  heicWithRotation,
  jpegWithExif,
  pixelAt,
  pngHeaderClaiming,
  solidAvif,
  solidJpeg,
  solidWebp,
  transparentPng,
  twoFrameGif,
} from "@/test/fixtures/images";
import { closeHeicWorker } from "./heic";
import { processImage, sniffImageType } from "./image";
import { countImageTokens, resizedSize } from "./resize";

afterAll(async () => {
  await closeHeicWorker();
});

async function expectAppError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).errorCode).toBe(code);
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Every metadata block sharp can report, plus a full exifr parse (EXIF, GPS, XMP, IPTC, ICC). */
async function expectNoMetadata(jpeg: Uint8Array): Promise<void> {
  const meta = await sharp(jpeg).metadata();
  expect(meta.format).toBe("jpeg");
  expect(meta.exif).toBeUndefined();
  expect(meta.xmp).toBeUndefined();
  expect(meta.iptc).toBeUndefined();
  expect(meta.icc).toBeUndefined();
  expect(meta.orientation).toBeUndefined();
  expect(await exifr.parse(Buffer.from(jpeg), true)).toBeUndefined();
  expect(await exifr.gps(Buffer.from(jpeg))).toBeUndefined();
}

describe("sniffImageType", () => {
  it("identifies formats by magic bytes", async () => {
    expect(sniffImageType(await solidJpeg(8, 8))).toBe("jpeg");
    expect(sniffImageType(await transparentPng(8, 8))).toBe("png");
    expect(sniffImageType(await twoFrameGif(8, 8))).toBe("gif");
    expect(sniffImageType(await solidWebp(8, 8))).toBe("webp");
    expect(sniffImageType(await solidAvif(16, 16))).toBe("avif");
    expect(sniffImageType(exampleHeic())).toBe("heic");
  });

  it("reads HEIF brands from the ftyp box", () => {
    for (const brand of ["heic", "heix", "hevc", "hevx", "heim", "heis"]) {
      expect(sniffImageType(ftyp(brand, ["mif1"])), brand).toBe("heic");
    }
    expect(sniffImageType(ftyp("mif1", ["mif1", "heic"]))).toBe("heic");
    expect(sniffImageType(ftyp("msf1", ["msf1"]))).toBe("heic");
    expect(sniffImageType(ftyp("mif1", ["mif1", "avif", "miaf"]))).toBe("avif");
    expect(sniffImageType(ftyp("avis", ["msf1"]))).toBe("avif");
    // Video and other ISO-BMFF files are not images we accept.
    expect(sniffImageType(ftyp("isom", ["isom", "mp41"]))).toBeNull();
    expect(sniffImageType(ftyp("qt  ", []))).toBeNull();
  });

  it("rejects unknown, empty and truncated input", () => {
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(Buffer.from("%PDF-1.7\n"))).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(ftyp("heic", []).subarray(0, 12))).toBeNull();
  });
});

describe("processImage", () => {
  it("applies EXIF orientation and strips all metadata including GPS", async () => {
    const input = await jpegWithExif({ width: 400, height: 200, orientation: 6 });
    // The fixture really carries GPS and the orientation tag.
    expect(await exifr.gps(input)).toMatchObject({ latitude: expect.any(Number) });
    expect((await sharp(input).metadata()).orientation).toBe(6);

    const out = await processImage(input);
    expect([out.width, out.height]).toEqual([200, 400]);
    await expectNoMetadata(out.jpeg);
    const meta = await sharp(out.jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([200, 400]);
    // Rotated 90° clockwise: the blue left band is now the top band.
    const [r, , b] = await pixelAt(out.jpeg, 100, 20);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
    const [r2, , b2] = await pixelAt(out.jpeg, 100, 380);
    expect(r2).toBeGreaterThan(150);
    expect(b2).toBeLessThan(80);
  });

  it("resizes an oriented image using its upright dimensions", async () => {
    const input = await jpegWithExif({ width: 4000, height: 3000, orientation: 6 });
    const out = await processImage(input);
    expect([out.width, out.height]).toEqual(resizedSize(3000, 4000, policy.media.maxEdge, policy.media.maxVisualTokens));
    expect(out.height).toBeGreaterThan(out.width);
    await expectNoMetadata(out.jpeg);
  });

  it("downscales oversize images to fit both API limits exactly", async () => {
    const out = await processImage(await solidJpeg(6000, 4000));
    const [ew, eh] = resizedSize(6000, 4000, policy.media.maxEdge, policy.media.maxVisualTokens);
    expect([out.width, out.height]).toEqual([ew, eh]);
    expect(countImageTokens(out.width, out.height)).toBeLessThanOrEqual(policy.media.maxVisualTokens);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(policy.media.maxEdge);
    const meta = await sharp(out.jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([ew, eh]);
  });

  it("never upscales small images", async () => {
    const out = await processImage(await solidJpeg(10, 7));
    expect([out.width, out.height]).toEqual([10, 7]);
  });

  it("converts PNG (flattening transparency onto white) and WebP and AVIF to JPEG", async () => {
    const png = await processImage(await transparentPng(64, 48));
    expect(png.sourceType).toBe("png");
    expect((await sharp(png.jpeg).metadata()).format).toBe("jpeg");
    const [r, g, b] = await pixelAt(png.jpeg, 10, 10);
    expect(Math.min(r, g, b)).toBeGreaterThan(245);

    const webp = await processImage(await solidWebp(64, 48));
    expect(webp.sourceType).toBe("webp");
    expect([webp.width, webp.height]).toEqual([64, 48]);
    await expectNoMetadata(webp.jpeg);

    const avif = await processImage(await solidAvif(32, 32));
    expect(avif.sourceType).toBe("avif");
    await expectNoMetadata(avif.jpeg);
  });

  it("keeps only the first frame of an animated GIF", async () => {
    const out = await processImage(await twoFrameGif(20, 10));
    expect([out.width, out.height]).toEqual([20, 10]);
    const [r, , b] = await pixelAt(out.jpeg, 10, 5);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
  });

  it("decodes HEVC HEIC (libheif's sample) to a valid JPEG", async () => {
    // Prebuilt sharp has no HEVC decoder, which is why the worker path exists (D-052).
    await expect(sharp(exampleHeic()).jpeg().toBuffer()).rejects.toThrow();

    const out = await processImage(exampleHeic());
    expect(out.sourceType).toBe("heic");
    expect([out.width, out.height]).toEqual([1280, 854]);
    await expectNoMetadata(out.jpeg);
    const stats = await sharp(out.jpeg).stats();
    // A real photo, not a blank frame.
    expect(stats.channels.some((c) => c.stdev > 10)).toBe(true);
  });

  it("applies the HEIF rotation (irot), the way iPhones store portrait photos", async () => {
    const upright = await processImage(exampleHeic());
    const portrait = await processImage(heicWithRotation(1));
    expect([portrait.width, portrait.height]).toEqual([854, 1280]);
    await expectNoMetadata(portrait.jpeg);
    // irot 1 is 90° anticlockwise; sharp's rotate() turns clockwise.
    const actual = await sharp(portrait.jpeg).raw().toBuffer();
    const expected = await sharp(upright.jpeg).rotate(270).raw().toBuffer();
    const wrongWay = await sharp(upright.jpeg).rotate(90).raw().toBuffer();
    expect(meanAbsDiff(actual, expected)).toBeLessThan(8);
    expect(meanAbsDiff(actual, wrongWay)).toBeGreaterThan(40);
  });

  it("returns the sha256 of the output and is deterministic", async () => {
    const input = await solidJpeg(300, 200);
    const a = await processImage(input);
    const b = await processImage(input);
    expect(a.sha256).toBe(createHash("sha256").update(a.jpeg).digest("hex"));
    expect(b.sha256).toBe(a.sha256);
  });

  it("rejects unsupported and corrupt input with AppError codes", async () => {
    await expectAppError(processImage(randomBytes(2048)), "image_unsupported");
    await expectAppError(processImage(Buffer.from("GIF89a")), "image_corrupt");
    const jpeg = await solidJpeg(200, 200);
    await expectAppError(processImage(Buffer.concat([jpeg.subarray(0, 300), randomBytes(500)])), "image_corrupt");
    await expectAppError(processImage(jpeg.subarray(0, jpeg.length - 100)), "image_corrupt");
    const png = await transparentPng(50, 50);
    await expectAppError(processImage(png.subarray(0, 60)), "image_corrupt");
    // A HEIF container with nothing decodable inside.
    await expectAppError(processImage(ftyp("heic", ["mif1", "heic"], 512)), "image_corrupt");
  });

  it("rejects decompression bombs from header dimensions before decoding", async () => {
    await expectAppError(processImage(pngHeaderClaiming(20_000, 20_000)), "image_too_many_pixels");
    // 81 MP: over our 80 MP cap but under sharp's own default limit (~268 MP), so the cap is what
    // rejects it.
    await expectAppError(processImage(pngHeaderClaiming(9_000, 9_000)), "image_too_many_pixels");
  });

  it("honours an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort(new Error("lease lost"));
    await expect(processImage(exampleHeic(), { signal: ac.signal })).rejects.toThrow("lease lost");
  });
});
