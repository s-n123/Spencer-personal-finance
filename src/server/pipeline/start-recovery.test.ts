// START across holder deaths (D-139): resuming and confirming are one transaction, a re-run never
// re-applies a confirmed START, and a twice-orphaned burst still gets its apology (D-132).
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@/server/channels/types";
import { inboundMessages, outboundMessages, turns, users } from "@/server/db/schema";
import type { Runner } from "@/server/pipeline/runner";
import { START_CONFIRMATION, STOP_CONFIRMATION, TURN_FAILED_REPLY } from "@/server/safety/copy";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, stubHandlers, type TestDeps } from "@/test/deps";
import type { AgentTurnInput, PipelineHandlers } from "./contracts";
import { handleInboundEvents } from "./inbound";
import { kick } from "./kick";
import { LeaseLostError, resolveTiming } from "./lease";

const PHONE = "+12015550142";
const timing = resolveTiming();

class DeferredRunner implements Runner {
  tasks: (() => Promise<void>)[] = [];
  readonly errors: unknown[] = [];
  run(_name: string, task: () => Promise<void>): void {
    this.tasks.push(task);
  }
  async flush(): Promise<void> {
    while (this.tasks.length > 0) {
      const batch = this.tasks.splice(0);
      await Promise.all(batch.map((t) => t().catch((err: unknown) => void this.errors.push(err))));
    }
  }
}

let t: TestDb;
let deps: TestDeps;
let runner: DeferredRunner;
let agentCalls: AgentTurnInput[];
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
  runner = new DeferredRunner();
  agentCalls = [];
  deps = makeTestDeps(t.db, { runner, pipeline: stubHandlers() });
});
afterEach(() => {
  expect(runner.errors).toEqual([]);
});

function message(text: string | null): NormalizedEvent {
  seq += 1;
  return {
    kind: "message",
    message: {
      provider: "simulator",
      providerMessageId: `start-rec-${seq}`,
      fromE164: PHONE,
      toLine: "+12015550199",
      text,
      media: [],
      sentAt: deps.clock.now(),
    },
  };
}

async function send(...events: NormalizedEvent[]) {
  return handleInboundEvents(deps, events);
}

async function userRow() {
  const [u] = await deps.db.select().from(users).where(eq(users.phoneE164, PHONE));
  return u;
}

const label = (x: string | null) =>
  x === START_CONFIRMATION ? "START_CONF" : x === STOP_CONFIRMATION ? "STOP_CONF" : x === TURN_FAILED_REPLY ? "APOLOGY" : "agent reply";

/** The first `deaths` holders that reach the model call die there (their lease lapses). */
function dyingAgent(deaths: number): PipelineHandlers {
  const base = stubHandlers();
  return stubHandlers({
    runAgent: async (d, input) => {
      agentCalls.push(input);
      if (agentCalls.length <= deaths) throw new LeaseLostError();
      return base.runAgent(d, input);
    },
  });
}

describe("START and recovery", () => {
  it("a [hi, START] burst orphaned twice still gets the apology, and the confirmed START stays done", async () => {
    await send(message("STOP"));
    await runner.flush();
    deps.clock.advance(60_000);
    deps.pipeline = dyingAgent(2);
    // D-131's documented [hi, START] burst: START is the last row in message order.
    await send(message("hi"));
    deps.clock.advance(1_000);
    await send(message("START"));
    await runner.flush(); // holder 1 confirms START, then dies in the model call
    expect(deps.adapter.textsTo(PHONE).map(label)).toEqual(["STOP_CONF", "START_CONF"]);

    deps.clock.advance(timing.leaseTtlMs + 1);
    await kick(deps, (await userRow()).id); // the 'recovery' re-run dies in the model call too
    expect(agentCalls).toHaveLength(2);

    deps.clock.advance(timing.leaseTtlMs + 1);
    await kick(deps, (await userRow()).id); // orphaned twice -> failTurn(all rows) -> apology?

    const out = await deps.db.select().from(outboundMessages).orderBy(asc(outboundMessages.createdAt));
    const rows = await deps.db.select().from(inboundMessages).orderBy(asc(inboundMessages.receivedAt));
    const last = (await deps.db.select().from(turns).orderBy(asc(turns.createdAt))).at(-1);
    // The confirmation is keyed command:<START id>:0, so the apology anchored on START can't
    // collide with it; START took effect, so its row is done, and only "hi" failed.
    expect([last?.status, last?.errorCode]).toEqual(["failed", "orphaned_twice"]);
    expect(rows.map((r) => r.status)).toEqual(["done", "failed", "done"]);
    expect(out.map((o) => label(o.text))).toEqual(["STOP_CONF", "START_CONF", "APOLOGY"]);
    expect(deps.adapter.textsTo(PHONE).map(label)).toEqual(["STOP_CONF", "START_CONF", "APOLOGY"]);
  });

  it("a recovery re-run never re-applies a confirmed START over a pause that came after it", async () => {
    await send(message("STOP"));
    await runner.flush();
    deps.clock.advance(60_000);
    // A STOP the user sent just before START whose webhook arrives late (e.g. redelivered after a 503).
    const lateStop = message("STOP");
    deps.clock.advance(1_000);
    let delivered = false;
    const base = stubHandlers();
    deps.pipeline = stubHandlers({
      runAgent: async (d, input) => {
        agentCalls.push(input);
        if (!delivered) {
          delivered = true;
          await handleInboundEvents(deps, [lateStop]);
          throw new LeaseLostError(); // holder 1 dies in the model call
        }
        return base.runAgent(d, input);
      },
    });
    await send(message("START"));
    deps.clock.advance(1_000);
    await send(message("what should I eat?"));
    await runner.flush();
    // The late STOP paused the user again; its confirmation went out after START's.
    expect((await userRow()).messagingPausedAt).not.toBeNull();
    expect(deps.adapter.textsTo(PHONE).map(label)).toEqual(["STOP_CONF", "START_CONF", "STOP_CONF"]);

    deps.clock.advance(timing.leaseTtlMs + 1);
    await kick(deps, (await userRow()).id);
    // The user was last told "You're unsubscribed": the re-run finds START's confirmation and
    // keeps the pause, as the same inputs without a holder death do (next test).
    expect(deps.adapter.textsTo(PHONE).map(label)).toEqual(["STOP_CONF", "START_CONF", "STOP_CONF"]);
    expect((await userRow()).messagingPausedAt).not.toBeNull();
  });

  it("the same late STOP without a holder death leaves the user paused, reply suppressed", async () => {
    await send(message("STOP"));
    await runner.flush();
    deps.clock.advance(60_000);
    const lateStop = message("STOP");
    deps.clock.advance(1_000);
    let delivered = false;
    const base = stubHandlers();
    deps.pipeline = stubHandlers({
      runAgent: async (d, input) => {
        agentCalls.push(input);
        if (!delivered) {
          delivered = true;
          await handleInboundEvents(deps, [lateStop]);
        }
        return base.runAgent(d, input);
      },
    });
    await send(message("START"));
    deps.clock.advance(1_000);
    await send(message("what should I eat?"));
    await runner.flush();
    expect((await userRow()).messagingPausedAt).not.toBeNull();
    expect(deps.adapter.textsTo(PHONE).map(label)).toEqual(["STOP_CONF", "START_CONF", "STOP_CONF"]);
  });
});
