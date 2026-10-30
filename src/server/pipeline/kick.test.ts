import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "@/server/channels/types";
import { inboundMessages, turns } from "@/server/db/schema";
import { InlineRunner } from "@/server/pipeline/runner";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, type TestDeps } from "@/test/deps";
import { handleInboundEvents } from "./inbound";
import { resolveTiming } from "./lease";

// The invocation deadline on the platform (getDeadline) versus the handoff path.

const platform = vi.hoisted(() => ({ deadline: undefined as Date | undefined }));
vi.mock("@vercel/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/functions")>()),
  getDeadline: () => platform.deadline,
}));

const PHONE = "+12015550105";
const timing = resolveTiming();

/** Runs tasks inline, but stops scheduling after a bound so a handoff loop fails instead of hanging. */
class BoundedRunner extends InlineRunner {
  scheduled = 0;
  override run(name: string, task: () => Promise<void>): void {
    this.scheduled += 1;
    if (this.scheduled > 20) return;
    super.run(name, task);
  }
}

let t: TestDb;
let deps: TestDeps;
let runner: BoundedRunner;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
  runner = new BoundedRunner();
  deps = makeTestDeps(t.db, { runner });
  platform.deadline = undefined;
});

function hi(): NormalizedEvent {
  return {
    kind: "message",
    message: {
      provider: "simulator",
      providerMessageId: `kick-${Math.random()}`,
      fromE164: PHONE,
      toLine: "+12015550199",
      text: "hi",
      media: [],
      sentAt: deps.clock.now(),
    },
  };
}

describe("kick deadline and handoff", () => {
  it("without an HTTP handoff, a platform deadline that is near runs the turn instead of looping", async () => {
    // Re-scheduling on the runner would land in this same invocation (after() nests) with the
    // same deadline, so every continuation would hand off again at once.
    platform.deadline = new Date(Date.now() + timing.minTurnBudgetMs / 2);
    deps.handoff = null;
    await handleInboundEvents(deps, [hi()]);
    await runner.drain();
    expect(runner.errors).toEqual([]);
    expect(runner.scheduled).toBe(1);
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 1 message(s)"]);
    const [row] = await deps.db.select().from(inboundMessages);
    expect(row.status).toBe("done");
  });

  it("with an HTTP handoff, a near platform deadline hands off without claiming", async () => {
    platform.deadline = new Date(Date.now() + timing.minTurnBudgetMs / 2);
    const handoff = vi.fn(async () => undefined);
    deps.handoff = handoff;
    await handleInboundEvents(deps, [hi()]);
    await runner.drain();
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(await deps.db.select().from(turns)).toEqual([]);
    expect(deps.adapter.sent).toEqual([]);
  });

  it("a failed handoff runs the turn here instead of leaving it to the sweep", async () => {
    platform.deadline = new Date(Date.now() + timing.minTurnBudgetMs / 2);
    const handoff = vi.fn(async () => {
      throw new Error("401 from /api/internal/kick");
    });
    deps.handoff = handoff;
    await handleInboundEvents(deps, [hi()]);
    await runner.drain();
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 1 message(s)"]);
  });

  it("a platform deadline with time to spare runs the turn", async () => {
    platform.deadline = new Date(Date.now() + timing.maxDurationMs);
    const handoff = vi.fn(async () => undefined);
    deps.handoff = handoff;
    await handleInboundEvents(deps, [hi()]);
    await runner.drain();
    expect(handoff).not.toHaveBeenCalled();
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 1 message(s)"]);
  });
});
