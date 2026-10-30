import { logError } from "@/server/errors";

// Fire-and-forget promises must never reject unhandled: on Fluid compute an unhandled rejection
// can take down every concurrent invocation on the instance.

export function fireAndForget(event: string, work: Promise<unknown> | (() => Promise<unknown>)): void {
  const promise = typeof work === "function" ? safeInvoke(work) : work;
  promise.catch((err: unknown) => logError(event, err));
}

function safeInvoke(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err);
  }
}
