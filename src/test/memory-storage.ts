import type { MediaStorage, StoredObject } from "@/server/media/storage/types";

export class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        n += 1;
      }
    }
    return n;
  }
}
