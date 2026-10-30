// Private media storage. Keys are deterministic: users/<userId>/<mediaId>.jpg, so retries
// overwrite instead of orphaning, and DELETE can remove everything by the users/<userId>/ prefix.

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface MediaStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object under the prefix; returns how many were deleted. */
  deletePrefix(prefix: string): Promise<number>;
}

export function mediaKey(userId: string, mediaId: string): string {
  return `users/${userId}/${mediaId}.jpg`;
}

export function userPrefix(userId: string): string {
  return `users/${userId}/`;
}
