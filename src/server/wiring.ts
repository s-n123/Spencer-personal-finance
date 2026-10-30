import "server-only";
import { createLlmClient } from "@/server/agent/llm";
import { runAgent } from "@/server/agent/turn";
import type { LlmClient } from "@/server/agent/types";
import { createRegistry } from "@/server/channels/registry";
import { getEnv, type Env } from "@/server/config/env";
import { getDb } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { AppError, logError } from "@/server/errors";
import { ensureMedia, prefetchMedia } from "@/server/media/download";
import { LocalFsStorage } from "@/server/media/storage/local";
import type { MediaStorage } from "@/server/media/storage/types";
import { createHttpHandoff } from "@/server/pipeline/handoff";
import { afterRunner } from "@/server/pipeline/runner";
import { realSleeper, systemClock } from "@/server/time";

// Production wiring: the one place that binds Deps to real implementations. Built lazily once per
// process (never at import, so `next build` works without secrets). Every field is either
// stateless or a pool/handle that is safe to share across concurrent invocations; nothing
// per-request is kept here.

let cached: Deps | undefined;

export function getDeps(): Deps {
  cached ??= buildDeps(getEnv());
  return cached;
}

function buildDeps(env: Env): Deps {
  const db = getDb();
  const clock = systemClock;
  const storage = createStorage(env);
  return {
    db,
    clock,
    sleeper: realSleeper,
    storage,
    llm: lazyLlm(env),
    runner: afterRunner,
    adapters: createRegistry({ db, storage, clock }),
    models: { main: env.MODEL_MAIN, fast: env.MODEL_FAST, mainEffort: env.MODEL_MAIN_EFFORT },
    handoff:
      env.APP_BASE_URL && env.INTERNAL_KICK_SECRET
        ? createHttpHandoff(env.APP_BASE_URL, env.INTERNAL_KICK_SECRET, {
            bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
          })
        : null,
    pipeline: { prefetchMedia, ensureMedia, runAgent },
  };
}

function createStorage(env: Env): MediaStorage {
  if (env.MEDIA_STORAGE === "local") return new LocalFsStorage(env.MEDIA_LOCAL_DIR);
  // Private Vercel Blob storage arrives with the deploy milestone (M6).
  throw new AppError("media_storage_unavailable", "MEDIA_STORAGE=vercel-blob is not available until M6; use local");
}

/**
 * The client is created on first use, so routes that never call the model (thread polling, reset,
 * media) keep working when the LLM configuration is incomplete.
 */
function lazyLlm(env: Env): LlmClient {
  let client: LlmClient | undefined;
  return {
    create(params, opts) {
      client ??= createLlmClient(env);
      return client.create(params, opts);
    },
  };
}

/**
 * Runs a route body; failures (including bad wiring) are logged sanitized (D-103) and answered
 * 503, never with error details.
 */
export async function safeRoute(route: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    logError("route.failed", err, { route });
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store, private" } });
  }
}

/** safeRoute with production deps. */
export function withDeps(route: string, fn: (deps: Deps) => Promise<Response>): Promise<Response> {
  return safeRoute(route, () => fn(getDeps()));
}
