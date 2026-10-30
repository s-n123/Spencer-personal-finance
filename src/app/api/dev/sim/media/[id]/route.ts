import { notFound, simulatorAvailable } from "@/server/channels/simulator/guard";
import { getSimMedia } from "@/server/channels/simulator/handlers";
import { withDeps } from "@/server/wiring";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!simulatorAvailable()) return notFound();
  const { id } = await ctx.params;
  return withDeps("dev.sim.media", (deps) => getSimMedia(deps, id));
}
