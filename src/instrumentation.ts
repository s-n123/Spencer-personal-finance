import type { Instrumentation } from "next";

// register(): validate env eagerly at server start (D-020) so a misconfigured deployment fails
// fast; getEnv() stays lazy everywhere else so `next build` and tests don't need secrets.
// onRequestError(): log only the route path and method. The request's body, headers, query
// string and the error message can all carry user content or secrets (D-103).

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getEnv } = await import("@/server/config/env");
  getEnv();
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logError } = await import("@/server/errors");
  logError("request.error", err, {
    route: context.routePath,
    kind: context.routeType,
    phase: request.method,
  });
};
