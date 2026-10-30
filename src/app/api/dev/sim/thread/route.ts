import { notFound, simulatorAvailable } from "@/server/channels/simulator/guard";
import { getSimThread } from "@/server/channels/simulator/handlers";
import { withDeps } from "@/server/wiring";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!simulatorAvailable()) return notFound();
  return withDeps("dev.sim.thread", (deps) => getSimThread(deps, req));
}
