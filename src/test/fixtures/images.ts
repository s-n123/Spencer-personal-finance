import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import sharp from "sharp";

// Synthetic test images built in memory with sharp (provenance: synthetic). Nothing here is a
// real photo, and the GPS coordinates are arbitrary.

export const FIXTURE_DIR = new URL("./", import.meta.url);

/** libheif's sample HEIC (see README.md in this folder). 1280×854, HEVC. */
export function exampleHeic(): Buffer {
  return readFileSync(new URL("example.heic", FIXTURE_DIR));
}

/**
 * libheif's sample with an `irot` property (angle × 90° anticlockwise) added to its primary item,
 * which is how iPhones store portrait photos: pixels in sensor orientation plus a rotation. Built
 * in memory by patching the box tree: the new property, its ipma association, the enclosing box
 * sizes, and the iloc offsets (absolute, and every mdat follows meta, so they shift too).
 */
export function heicWithRotation(angle: 1 | 2 | 3): Buffer {
  const d = Buffer.from(exampleHeic());
  const find = (start: number, end: number, type: string): { at: number; size: number } => {
    for (let i = start; i < end; i += d.readUInt32BE(i)) {
      if (d.toString("latin1", i + 4, i + 8) === type) return { at: i, size: d.readUInt32BE(i) };
    }
    throw new Error(`fixture has no ${type} box`);
  };
  const meta = find(0, d.length, "meta");
  const [metaStart, metaEnd] = [meta.at + 12, meta.at + meta.size];
  const pitm = find(metaStart, metaEnd, "pitm");
  const primary = d[pitm.at + 8] === 0 ? d.readUInt16BE(pitm.at + 12) : d.readUInt32BE(pitm.at + 12);
  const iloc = find(metaStart, metaEnd, "iloc");
  const iprp = find(metaStart, metaEnd, "iprp");
  const ipco = find(iprp.at + 8, iprp.at + iprp.size, "ipco");
  const ipma = find(iprp.at + 8, iprp.at + iprp.size, "ipma");

  let properties = 0;
  for (let i = ipco.at + 8; i < ipco.at + ipco.size; i += d.readUInt32BE(i)) properties++;
  const wide = (d.readUIntBE(ipma.at + 9, 3) & 1) === 1;
  const assoc = Buffer.alloc(wide ? 2 : 1);
  // Essential bit set: a reader that can't apply the rotation must not show the image.
  if (wide) assoc.writeUInt16BE(0x8000 | (properties + 1));
  else assoc[0] = 0x80 | (properties + 1);
  const irot = Buffer.concat([Buffer.from([0, 0, 0, 9]), Buffer.from("irot", "latin1"), Buffer.from([angle])]);
  const delta = irot.length + assoc.length;

  const ipmaVersion = d[ipma.at + 8];
  let p = ipma.at + 12;
  const entries = d.readUInt32BE(p);
  p += 4;
  let countAt = -1;
  let assocEnd = -1;
  for (let e = 0; e < entries; e++) {
    const item = ipmaVersion < 1 ? d.readUInt16BE(p) : d.readUInt32BE(p);
    p += ipmaVersion < 1 ? 2 : 4;
    const n = d[p];
    if (item === primary) [countAt, assocEnd] = [p, p + 1 + n * assoc.length];
    p += 1 + n * assoc.length;
  }
  if (countAt < 0 || assocEnd < ipco.at + ipco.size) throw new Error("unexpected fixture layout");

  const readN = (at: number, size: number) => (size === 8 ? Number(d.readBigUInt64BE(at)) : d.readUIntBE(at, size));
  const shift = (at: number, size: number) => {
    if (size === 0) return;
    if (size === 8) d.writeBigUInt64BE(BigInt(readN(at, size) + delta), at);
    else d.writeUIntBE(readN(at, size) + delta, at, size);
  };
  const v = d[iloc.at + 8];
  p = iloc.at + 12;
  const [offsetSize, lengthSize, baseSize] = [d[p] >> 4, d[p] & 15, d[p + 1] >> 4];
  const indexSize = v === 1 || v === 2 ? d[p + 1] & 15 : 0;
  p += 2;
  const items = v < 2 ? d.readUInt16BE(p) : d.readUInt32BE(p);
  p += v < 2 ? 2 : 4;
  for (let it = 0; it < items; it++) {
    p += v < 2 ? 2 : 4;
    const method = v === 1 || v === 2 ? d[p + 1] & 15 : 0;
    if (v === 1 || v === 2) p += 2;
    p += 2; // data_reference_index
    if (method === 0) shift(p, baseSize);
    p += baseSize;
    const extents = d.readUInt16BE(p);
    p += 2;
    for (let x = 0; x < extents; x++) {
      p += indexSize;
      if (method === 0 && baseSize === 0) shift(p, offsetSize);
      p += offsetSize + lengthSize;
    }
  }

  d[countAt] += 1;
  const ipcoEnd = ipco.at + ipco.size;
  const out = Buffer.concat([d.subarray(0, ipcoEnd), irot, d.subarray(ipcoEnd, assocEnd), assoc, d.subarray(assocEnd)]);
  out.writeUInt32BE(meta.size + delta, meta.at);
  out.writeUInt32BE(iprp.size + delta, iprp.at);
  out.writeUInt32BE(ipco.size + irot.length, ipco.at);
  out.writeUInt32BE(ipma.size + assoc.length, ipma.at + irot.length);
  return out;
}

export function solidJpeg(width: number, height: number, background = "#3c8c3c"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
}

/**
 * A landscape JPEG whose left quarter is blue (the rest red), carrying EXIF Make, GPS and the
 * given Orientation tag. With Orientation 6 (rotate 90° clockwise) the blue band ends up on top.
 */
export async function jpegWithExif(opts: { width: number; height: number; orientation: number }): Promise<Buffer> {
  const band = Math.max(1, Math.floor(opts.width / 4));
  return sharp({ create: { width: opts.width, height: opts.height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .composite([
      {
        input: { create: { width: band, height: opts.height, channels: 3, background: { r: 0, g: 0, b: 255 } } },
        left: 0,
        top: 0,
      },
    ])
    .withExif({
      IFD0: { Make: "SyntheticCam", Model: "Fixture 1" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "40/1 26/1 46/1",
        GPSLongitudeRef: "W",
        GPSLongitude: "79/1 58/1 56/1",
      },
    })
    .withMetadata({ orientation: opts.orientation })
    .jpeg()
    .toBuffer();
}

/** A fully transparent RGBA PNG. */
export function transparentPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer();
}

export function solidWebp(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#8040c0" } }).webp().toBuffer();
}

export function solidAvif(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#208020" } }).avif().toBuffer();
}

/** A two-frame animated GIF: frame 1 red, frame 2 blue. */
export function twoFrameGif(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 2 * 3);
  for (let i = 0; i < width * height; i++) raw[i * 3] = 255;
  for (let i = width * height; i < width * height * 2; i++) raw[i * 3 + 2] = 255;
  return sharp(raw, { raw: { width, height: height * 2, channels: 3, pageHeight: height } }).gif().toBuffer();
}

/**
 * A PNG whose header (with a valid CRC) claims the given dimensions but whose pixel data is a few
 * bytes of junk: a decompression-bomb stand-in that is tiny on disk.
 */
export function pngHeaderClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from([1, 2, 3, 4])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An ISO-BMFF ftyp box with the given major and compatible brands, followed by junk. */
export function ftyp(major: string, compatible: string[], trailing = 64): Buffer {
  const size = 16 + compatible.length * 4;
  const head = Buffer.alloc(size);
  head.writeUInt32BE(size, 0);
  head.write("ftyp", 4, "latin1");
  head.write(major, 8, "latin1");
  compatible.forEach((b, i) => head.write(b, 16 + i * 4, "latin1"));
  return Buffer.concat([head, Buffer.alloc(trailing, 0x5a)]);
}

/** RGB of the pixel at (x, y) of a decoded image. */
export async function pixelAt(image: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
