import { notFound, simulatorAvailable } from "@/server/channels/simulator/guard";

// Next 16 proxy (Node runtime). It only covers the dev simulator: /dev and /api/dev answer 404
// unless the simulator is available (never on production, D-102). Every handler re-checks
// (D-012). Webhook, cron and internal routes are deliberately outside the matcher: they read raw
// bodies for their own authentication. /admin Basic auth joins in M5.

export function proxy(): Response | undefined {
  if (!simulatorAvailable()) return notFound();
  return undefined;
}

export const config = {
  matcher: ["/dev/:path*", "/api/dev/:path*"],
};
