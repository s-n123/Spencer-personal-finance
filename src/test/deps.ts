import type { Deps } from "@/server/deps";
import type { AgentTurnOutput, PipelineHandlers } from "@/server/pipeline/contracts";
import { InlineRunner } from "@/server/pipeline/runner";
import { FakeClock, FakeSleeper } from "./clock";
import { FakeAdapter, registryOf } from "./fake-adapter";
import { ScriptedLlm } from "./fake-llm";
import { MemoryStorage } from "./memory-storage";
import type { Db } from "@/server/db/types";

export interface TestDeps extends Deps {
  clock: FakeClock;
  sleeper: FakeSleeper;
  storage: MemoryStorage;
  llm: ScriptedLlm;
  runner: InlineRunner;
  adapter: FakeAdapter;
}

/** Stub handlers: no media, and an agent that echoes how many messages it saw. */
export function stubHandlers(overrides: Partial<PipelineHandlers> = {}): PipelineHandlers {
  return {
    prefetchMedia: async () => undefined,
    ensureMedia: async () => ({ ready: [], failed: [] }),
    runAgent: async (_deps, input): Promise<AgentTurnOutput> => ({
      bubbles: [`got ${input.messages.length} message(s)`],
      mode: "agent",
      stopReason: "end_turn",
      refusalCategory: null,
      usage: [],
      mediaSummaries: [],
    }),
    ...overrides,
  };
}

export function makeTestDeps(db: Db, overrides: Partial<Deps> = {}): TestDeps {
  const clock = new FakeClock();
  const adapter = new FakeAdapter("simulator");
  const deps: TestDeps = {
    db,
    clock,
    sleeper: new FakeSleeper(clock),
    storage: new MemoryStorage(),
    llm: new ScriptedLlm(),
    runner: new InlineRunner(),
    adapters: registryOf(adapter),
    adapter,
    models: { main: "claude-sonnet-5-5", fast: "claude-haiku-5-5", mainEffort: "medium" },
    handoff: null,
    pipeline: stubHandlers(),
    ...overrides,
  } as TestDeps;
  return deps;
}
