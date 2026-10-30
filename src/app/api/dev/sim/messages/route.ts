import { notFound, simulatorAvailable } from "@/server/channels/simulator/guard";
import { postSimMessages } from "@/server/channels/simulator/handlers";
import { withDeps } from "@/server/wiring";

// Dev-only simulator inbound (PLAN §3). The kick runs in after(), so this route needs the full budget.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  if (!simulatorAvailable()) return notFound();
  return withDeps("dev.sim.messages", (deps) => postSimMessages(deps, req));
}
