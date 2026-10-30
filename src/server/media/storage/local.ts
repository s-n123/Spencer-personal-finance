import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { AppError } from "@/server/errors";
import type { MediaStorage, StoredObject } from "./types";

// Local-filesystem media storage for development (D-054; production uses private Vercel Blob).
// Keys are validated against a strict charset and resolved strictly inside the root, so a key can
// never escape it. Writes go to a temp file that is renamed into place, so readers never see a
// partial JPEG. The content type is derived from the key's extension and must match on put.

const KEY_CHARS = /^[a-z0-9/_.-]+$/;
/** "~" is outside the key charset, so a temp file can never collide with a real key. */
const TMP_PREFIX = "~";
const TMP_SUFFIX = /\.[0-9a-f-]{36}\.tmp$/;

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function contentTypeFor(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1);
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** A key is a relative path of non-empty segments; "." and ".." segments are never allowed. */
function isValidKey(key: string, allowTrailingSlash: boolean): boolean {
  if (!KEY_CHARS.test(key)) return false;
  const segments = key.split("/");
  if (allowTrailingSlash && segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

export class LocalFsStorage implements MediaStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private pathFor(key: string, allowTrailingSlash = false): string {
    // Never echo the key: it contains user and media IDs.
    if (!isValidKey(key, allowTrailingSlash)) throw new AppError("storage_invalid_key");
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new AppError("storage_invalid_key");
    return path;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const path = this.pathFor(key);
    if (contentType !== contentTypeFor(key)) throw new AppError("storage_content_type_mismatch");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(path), `${TMP_PREFIX}${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, bytes, { flag: "wx", mode: 0o600 });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      const buf = await readFile(path);
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), contentType: contentTypeFor(key) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    // The prefix must name at least one full segment ("users/<id>/" or "users/<id>/<media>").
    this.pathFor(prefix, true);
    const baseRel = prefix.slice(0, prefix.lastIndexOf("/") + 1).replace(/\/$/, "");
    const baseDir = baseRel ? resolve(this.root, baseRel) : this.root;
    let deleted = 0;
    for (const rel of await listFiles(baseDir, baseRel)) {
      const { key, temp } = logicalKey(rel);
      if (!key.startsWith(prefix)) continue;
      // Deleting an in-flight temp file makes that put fail, which is right for a DELETE.
      await rm(resolve(this.root, rel), { force: true });
      if (!temp) deleted += 1;
    }
    if (baseDir !== this.root) await pruneEmptyDirs(baseDir);
    return deleted;
  }
}

/** Maps a stored relative path back to its key; temp files map to the key they will become. */
function logicalKey(rel: string): { key: string; temp: boolean } {
  const name = basename(rel);
  if (!name.startsWith(TMP_PREFIX) || !TMP_SUFFIX.test(name)) return { key: rel, temp: false };
  const dir = rel.slice(0, rel.length - name.length);
  return { key: dir + name.slice(TMP_PREFIX.length).replace(TMP_SUFFIX, ""), temp: true };
}

/** Relative paths ("/"-separated, as keys) of every file under dir; [] if dir doesn't exist. */
async function listFiles(dir: string, rel: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err) || isNotDir(err)) return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), childRel)));
    else out.push(childRel);
  }
  return out;
}

/** Removes dir and its subdirectories if they are empty; anything non-empty is left alone. */
async function pruneEmptyDirs(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyDirs(join(dir, entry.name));
  }
  await rmdir(dir).catch(() => undefined);
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

function isNotDir(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOTDIR";
}
