import { describe, expect, it } from "vitest";
import { SIM_UPLOAD_LIMITS } from "@/server/channels/simulator/limits";
import { isHeic, splitIntoPosts } from "./upload";

const file = (bytes: number, name = "p.jpg") => new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
const MB = 1024 * 1024;

describe("splitIntoPosts", () => {
  it("keeps a text-only send as one empty group", () => {
    expect(splitIntoPosts([])).toEqual([[]]);
  });

  it("keeps small selections in one request", () => {
    const groups = splitIntoPosts([file(MB), file(MB), file(MB)]);
    expect(groups.map((g) => g.length)).toEqual([3]);
  });

  it("splits selections that would pass the proxy's body buffer", () => {
    const groups = splitIntoPosts([file(4 * MB), file(4 * MB), file(4 * MB), file(1 * MB)]);
    expect(groups.map((g) => g.length)).toEqual([2, 2]);
    for (const g of groups) {
      expect(g.reduce((n, f) => n + f.size, 0)).toBeLessThan(SIM_UPLOAD_LIMITS.maxRequestBytes);
    }
  });

  it("respects the per-post file count and keeps order", () => {
    const files = Array.from({ length: SIM_UPLOAD_LIMITS.maxFilesPerPost + 3 }, (_, i) => file(10, `${i}.jpg`));
    const groups = splitIntoPosts(files);
    expect(groups.map((g) => g.length)).toEqual([SIM_UPLOAD_LIMITS.maxFilesPerPost, 3]);
    expect(groups.flat().map((f) => f.name)).toEqual(files.map((f) => f.name));
  });
});

describe("isHeic", () => {
  it("recognizes HEIC by type or extension", () => {
    expect(isHeic(new File([], "IMG_1.HEIC", { type: "" }))).toBe(true);
    expect(isHeic(new File([], "x", { type: "image/heif" }))).toBe(true);
    expect(isHeic(file(1))).toBe(false);
  });
});
