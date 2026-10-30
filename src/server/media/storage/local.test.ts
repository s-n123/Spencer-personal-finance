import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { LocalFsStorage } from "./local";
import { mediaKey, userPrefix } from "./types";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let base: string;
let root: string;
let storage: LocalFsStorage;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nc-media-"));
  root = join(base, "root");
  storage = new LocalFsStorage(root);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const bytes = (...b: number[]) => new Uint8Array(b);

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.errorCode : "not AppError"),
  );
}

describe("LocalFsStorage", () => {
  it("round-trips objects and returns null for missing keys", async () => {
    const key = mediaKey(U1, M1);
    await storage.put(key, bytes(1, 2, 3), "image/jpeg");
    const got = await storage.get(key);
    expect(got?.contentType).toBe("image/jpeg");
    expect([...(got?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(await storage.get(mediaKey(U1, M2))).toBeNull();

    await storage.put(key, bytes(9), "image/jpeg");
    expect([...((await storage.get(key))?.bytes ?? [])]).toEqual([9]);

    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    await storage.delete(key); // idempotent
  });

  it("writes atomically: no temp files are left behind and files are private", async () => {
    const key = mediaKey(U1, M1);
    await storage.put(key, bytes(1), "image/jpeg");
    const dir = join(root, "users", U1);
    expect(readdirSync(dir)).toEqual([`${M1}.jpg`]);
    expect(statSync(join(dir, `${M1}.jpg`)).mode & 0o777).toBe(0o600);
  });

  it("rejects keys that could escape the root or aren't in the key charset", async () => {
    // A file outside the root that a traversal would hit.
    writeFileSync(join(base, "secret.jpg"), "secret");
    const bad = [
      "../secret.jpg",
      "users/../../secret.jpg",
      "users/./x.jpg",
      "/etc/passwd",
      "users//x.jpg",
      "users/x.jpg/",
      "",
      "Users/X.jpg",
      "users\\..\\secret.jpg",
      "users/x%2e%2e/y.jpg",
      "users/~x.jpg",
      "users/x.jpg\u0000",
    ];
    for (const key of bad) {
      expect(await codeOf(storage.get(key)), JSON.stringify(key)).toBe("storage_invalid_key");
      expect(await codeOf(storage.put(key, bytes(1), "image/jpeg")), JSON.stringify(key)).toBe("storage_invalid_key");
      expect(await codeOf(storage.delete(key)), JSON.stringify(key)).toBe("storage_invalid_key");
    }
    for (const prefix of ["../", "..", "users/../", "", "/"]) {
      expect(await codeOf(storage.deletePrefix(prefix)), JSON.stringify(prefix)).toBe("storage_invalid_key");
    }
    expect(existsSync(join(base, "secret.jpg"))).toBe(true);
  });

  it("requires the content type to match the key's extension", async () => {
    expect(await codeOf(storage.put(mediaKey(U1, M1), bytes(1), "image/png"))).toBe("storage_content_type_mismatch");
  });

  it("deletePrefix removes exactly the prefix's objects and counts them", async () => {
    await storage.put(mediaKey(U1, M1), bytes(1), "image/jpeg");
    await storage.put(mediaKey(U1, M2), bytes(2), "image/jpeg");
    await storage.put(mediaKey(U2, M1), bytes(3), "image/jpeg");

    expect(await storage.deletePrefix(userPrefix(U1))).toBe(2);
    expect(await storage.get(mediaKey(U1, M1))).toBeNull();
    expect(await storage.get(mediaKey(U1, M2))).toBeNull();
    expect(await storage.get(mediaKey(U2, M1))).not.toBeNull();
    // The user's now-empty directory is removed too.
    expect(existsSync(join(root, "users", U1))).toBe(false);

    expect(await storage.deletePrefix(userPrefix(U1))).toBe(0);
    expect(await storage.deletePrefix("users/nobody/")).toBe(0);
  });

  it("deletePrefix also matches partial names and removes in-flight temp files", async () => {
    await storage.put(mediaKey(U1, M1), bytes(1), "image/jpeg");
    await storage.put(mediaKey(U1, M2), bytes(2), "image/jpeg");
    // Simulate a put caught between write and rename.
    const tmp = join(root, "users", U1, `~${M2}.jpg.${"c".repeat(8)}-cccc-4ccc-8ccc-${"c".repeat(12)}.tmp`);
    writeFileSync(tmp, "partial");

    expect(await storage.deletePrefix(`users/${U1}/aaaa`)).toBe(1);
    expect(await storage.get(mediaKey(U1, M2))).not.toBeNull();
    expect(existsSync(tmp)).toBe(true);

    expect(await storage.deletePrefix(`users/${U1}/`)).toBe(1);
    expect(existsSync(tmp)).toBe(false);
  });

  it("deletePrefix on a root that doesn't exist yet is a no-op", async () => {
    expect(await new LocalFsStorage(join(base, "never-created")).deletePrefix("users/")).toBe(0);
  });
});
