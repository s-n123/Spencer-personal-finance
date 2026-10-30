import { notFound, simulatorAvailable } from "@/server/channels/simulator/guard";
import { postSimReset } from "@/server/channels/simulator/handlers";
import { withDeps } from "@/server/wiring";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!simulatorAvailable()) return notFound();
  return withDeps("dev.sim.reset", (deps) => postSimReset(deps, req));
}
