import { getEnv } from "@/server/config/env";
import { getDeps, safeRoute } from "@/server/wiring";
import { handleInternalKick } from "./handler";

// Kept out of the proxy matcher: authentication is the bearer secret, checked in the handler
// before any deps are built.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  return safeRoute("internal.kick", () => handleInternalKick(req, getEnv().INTERNAL_KICK_SECRET, getDeps));
}
