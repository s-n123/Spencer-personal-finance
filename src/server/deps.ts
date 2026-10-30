import type { LlmClient } from "@/server/agent/types";
import type { AdapterRegistry } from "@/server/channels/types";
import type { Db } from "@/server/db/types";
import type { MediaStorage } from "@/server/media/storage/types";
import type { PipelineHandlers } from "@/server/pipeline/contracts";
import type { Runner } from "@/server/pipeline/runner";
import type { Clock, Sleeper } from "@/server/time";

/**
 * Everything side-effecting that pipeline code needs, passed explicitly so tests can swap in
 * PGlite, fake clocks, a fake LLM, in-memory storage and InlineRunner. Production wiring lives in
 * src/server/wiring.ts.
 */
export interface Deps {
  db: Db;
  clock: Clock;
  sleeper: Sleeper;
  storage: MediaStorage;
  llm: LlmClient;
  runner: Runner;
  adapters: AdapterRegistry;
  /** Model IDs from env (MODEL_MAIN / MODEL_FAST). */
  models: { main: string; fast: string; mainEffort: "low" | "medium" | "high" };
  /**
   * Continues a user's processing in a fresh invocation (POST /api/internal/kick). Null in tests
   * and scripts, where the pipeline re-schedules the kick on `runner` instead.
   */
  handoff: ((userId: string) => Promise<void>) | null;
  /** Media and agent entry points the pipeline calls (wired in wiring.ts, stubbed in tests). */
  pipeline: PipelineHandlers;
}
