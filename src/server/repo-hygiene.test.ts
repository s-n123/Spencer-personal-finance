import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isFictionalNumber } from "@/server/channels/simulator/phone";

// The repo is public (D-003). Any +1 number written in E.164 style (with or without separators)
// must be a fictional +1 NPA 555-01XX number. Helplines are written 1-866-..., which is not E.164
// and so not matched. Binary files are skipped.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_DIRS = ["src", "scripts", "fixtures", "docs", ".github"];
const SCAN_FILES = ["SPEC.md", "CLAUDE.md", "DECISIONS.md", "AGENTS.md", "README.md", ".env.example"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

/**
 * "+1" then 10 digits, allowing the usual separators (+12015550100, +1 (201) 555-0100) and the
 * URL-encoded plus that captured request URLs and pasted dev-server logs carry (%2B12015550100).
 */
const PLUS_ONE = /(?:\+|%2B)1[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)/gi;

function findNonFictionalNumbers(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(PLUS_ONE)) {
    const e164 = `+${match[0].replace(/^%2B/i, "").replace(/\D/g, "")}`;
    if (!isFictionalNumber(e164)) hits.push(match[0]);
  }
  return hits;
}

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (st.isFile()) out.push(path);
  }
}

function textFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);
  for (const name of SCAN_FILES) {
    try {
      if (statSync(join(ROOT, name)).isFile()) files.push(join(ROOT, name));
    } catch {
      // optional file
    }
  }
  return files;
}

describe("repo hygiene", () => {
  it("the detector flags real-looking numbers and allows fictional ones and helplines", () => {
    // Assembled at runtime so this file never contains a real-looking literal.
    const real = ["+1", "415", "867", "5309"];
    expect(findNonFictionalNumbers(`call ${real.join("")} now`)).toHaveLength(1);
    expect(findNonFictionalNumbers(`call ${real[0]} (${real[1]}) ${real[2]}-${real[3]}`)).toHaveLength(1);
    expect(findNonFictionalNumbers(`GET /api/dev/sim/thread?phone=%2b${real.join("").slice(1)}`)).toHaveLength(1);
    expect(findNonFictionalNumbers("+12015550100, +1 201 555 0199, +1 (646) 555-0142")).toEqual([]);
    expect(findNonFictionalNumbers("GET /api/dev/sim/thread?phone=%2B12015550100 200")).toEqual([]);
    expect(findNonFictionalNumbers("Helpline 1-866-662-1235; text 741741; call 988")).toEqual([]);
  });

  it("src, scripts, fixtures and docs contain only fictional +1 numbers", () => {
    const files = textFiles();
    expect(files.length).toBeGreaterThan(10);
    const violations: string[] = [];
    for (const file of files) {
      const buf = readFileSync(file);
      if (buf.includes(0)) continue;
      buf
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const hit of findNonFictionalNumbers(line)) {
            violations.push(`${relative(ROOT, file)}:${i + 1}: ${hit}`);
          }
        });
    }
    expect(violations, "use a fictional +1 NPA 555-01XX number instead").toEqual([]);
  });
});

/** JPEG, PNG, GIF, RIFF/WebP, ISO-BMFF (HEIC, HEIF, AVIF, MOV) and TIFF/DNG signatures. */
function isImage(head: Buffer): boolean {
  const hex = head.toString("hex");
  const ascii = head.toString("latin1");
  return (
    /^(ffd8ff|89504e47|47494638|49492a00|4d4d002a)/.test(hex) ||
    (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") ||
    ascii.slice(4, 8) === "ftyp"
  );
}

describe("owner photo fixtures (D-003)", () => {
  const git = (args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  const inRepo = git(["rev-parse", "--is-inside-work-tree"]).stdout?.trim() === "true";

  it.runIf(inRepo)("are gitignored whatever the extension's case, except under fixtures/synthetic/", () => {
    const owner = ["IMG_0001.JPG", "IMG_0002.jpg", "a.JPEG", "a.PNG", "a.HEIC", "a.heif", "a.HEIF", "a.webp"]
      .concat(["a.GIF", "a.avif", "a.TIF", "a.tiff", "a.DNG", "a.MOV"])
      .map((name) => `fixtures/meals/${name}`);
    const kept = ["fixtures/synthetic/label.png", "fixtures/synthetic/menu.JPG", "fixtures/meals/expected.json"];
    // ignorecase off, as on Linux CI: macOS clones default it on, which would hide a case-sensitive rule.
    const res = git(["-c", "core.ignorecase=false", "check-ignore", "--no-index", "--", ...owner, ...kept]);
    expect(res.stdout.split("\n").filter(Boolean).sort()).toEqual([...owner].sort());
  });

  it.runIf(inRepo)("no tracked file under fixtures/ outside fixtures/synthetic/ is an image", () => {
    const tracked = git(["ls-files", "-z", "--", "fixtures"]).stdout.split("\0").filter(Boolean);
    const images = tracked.filter(
      (f) =>
        !f.startsWith("fixtures/synthetic/") &&
        existsSync(join(ROOT, f)) &&
        isImage(readFileSync(join(ROOT, f)).subarray(0, 16)),
    );
    expect(images, "owner photos must stay out of the public repo").toEqual([]);
  });

  it("the image detector recognises the formats phones export", () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")]);
    const webp = Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1");
    expect([Buffer.from("ffd8ffe1", "hex"), Buffer.from("89504e470d0a1a0a", "hex"), heic, webp].map(isImage)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(isImage(Buffer.from('{"expected": 1}'))).toBe(false);
  });
});
