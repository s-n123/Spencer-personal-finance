import { getEnv, simulatorEnabled, type Env } from "@/server/config/env";

// Checked by proxy.ts and again by every /dev and /api/dev handler (D-012: the proxy is never the
// only layer). Fails closed: an env that doesn't validate means the simulator is off.

export function simulatorAvailable(env?: Env): boolean {
  let resolved: Env;
  try {
    resolved = env ?? getEnv();
  } catch {
    return false;
  }
  // PLAN §3: previews also need admin Basic auth, which arrives with ADMIN_USER/ADMIN_PASSWORD in
  // M5. Until then the simulator stays off on previews.
  if (resolved.VERCEL_ENV === "preview") return false;
  return simulatorEnabled(resolved);
}

/**
 * True for a request a browser made from another site's page. Route handlers get no CSRF
 * protection from Next, so without this any page open while `npm run dev` runs could post a form
 * to the simulator: that spends the owner's API credit, and a post to reset wipes the dev data.
 * Non-browser clients (curl, tests) send neither header and pass.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host !== host;
  } catch {
    // Origin "null" (sandboxed frames, file:// pages) or garbage.
    return true;
  }
}

export const NO_STORE = { "cache-control": "no-store, private" } as const;

export function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { ...NO_STORE, "content-type": "text/plain" } });
}
