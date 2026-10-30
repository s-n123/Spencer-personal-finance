import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Deps } from "@/server/deps";
import { kick } from "@/server/pipeline/kick";

// POST /api/internal/kick: self-handoff target (PLAN §2.1 kick step 5). Authenticated by a shared
// bearer secret; the body carries only the user's UUID. The kick runs on deps.runner (after()).

const bodySchema = z.object({ userId: z.uuid() });
const NO_STORE = { "cache-control": "no-store, private" } as const;

/** Constant-time check; hashing first makes the comparison independent of the token's length. */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(secret));
}

export async function handleInternalKick(
  req: Request,
  secret: string | undefined,
  getDeps: () => Deps,
): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400, headers: NO_STORE });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "bad_body" }, { status: 400, headers: NO_STORE });

  const deps = getDeps();
  const { userId } = parsed.data;
  deps.runner.run("internal_kick", async () => {
    await kick(deps, userId);
  });
  return Response.json({ accepted: true }, { status: 202, headers: NO_STORE });
}
