import { AppError } from "@/server/errors";

// Self-handoff (PLAN §2.1 kick step 5): when an invocation is low on time, it asks a fresh
// invocation to continue the user's processing via POST /api/internal/kick (route built
// elsewhere). The body carries only the user's UUID.

export interface HttpHandoffOptions {
  /** Vercel Protection Bypass for Automation secret, needed on protected preview deployments. */
  bypassSecret?: string;
  timeoutMs?: number;
  /** Injectable for tests (which never touch the network). */
  fetchFn?: typeof fetch;
}

export class HandoffError extends AppError {
  constructor(public readonly status: number) {
    super("handoff_failed");
    this.name = "HandoffError";
  }
}

export function createHttpHandoff(
  baseUrl: string,
  secret: string,
  opts: HttpHandoffOptions = {},
): (userId: string) => Promise<void> {
  const url = new URL("/api/internal/kick", baseUrl).toString();
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return async (userId) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    };
    if (opts.bypassSecret) headers["x-vercel-protection-bypass"] = opts.bypassSecret;
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is never read; cancelling it releases the connection instead of waiting for GC.
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new HandoffError(res.status);
  };
}
