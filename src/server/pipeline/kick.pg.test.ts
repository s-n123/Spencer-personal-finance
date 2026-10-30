import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InboundMessage, NormalizedEvent } from "@/server/channels/types";
import { inboundMessages, media, outboundMessages, turns, users, userTurnState } from "@/server/db/schema";
import { countAll } from "@/server/db/sql";
import type { Db } from "@/server/db/types";
import type { Deps } from "@/server/deps";
import { InlineRunner } from "@/server/pipeline/runner";
import { STOP_CONFIRMATION } from "@/server/safety/copy";
import { realSleeper, systemClock, type Sleeper } from "@/server/time";
import { resetTestDb } from "@/test/db";
import { stubHandlers } from "@/test/deps";
import { FakeAdapter, registryOf } from "@/test/fake-adapter";
import { ScriptedLlm } from "@/test/fake-llm";
import { MemoryStorage } from "@/test/memory-storage";
import { createPgTestDb, type PgTestDb } from "@/test/pg";
import { claimBurst } from "./claim";
import type { AgentTurnOutput, PipelineHandlers } from "./contracts";
import { handleInboundEvents } from "./inbound";
import { ingestMessage } from "./ingest";
import { kick, type KickResult } from "./kick";
import { resolveTiming, tryAcquireLease, type PipelineTiming } from "./lease";
import { writeReplyIntents } from "./outbound";

// Race tests on real Postgres 16 with real time and many connections (PGlite can't show races).
// Timings are scaled down from policy via injection.

const fast: Partial<PipelineTiming> = {
  debounceMs: 60,
  maxDebounceMs: 400,
  leaseTtlMs: 600,
  heartbeatMs: 150,
  freshLeaseThresholdMs: 300,
  acquireAttempts: 3,
  sweepStaleAfterMs: 5_000,
  maxDurationMs: 60_000,
  minTurnBudgetMs: 1_000,
  perSendTimeoutMs: 2_000,
};
const timing = resolveTiming(fast);
const PHONE = "+12015550103";

/** Never fires until aborted: simulates a stalled process whose heartbeat timer doesn't run. */
const stalledSleeper: Sleeper = {
  sleep: (_ms, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
};

interface PgDeps extends Deps {
  adapter: FakeAdapter;
  runner: InlineRunner;
}

let t: PgTestDb;

beforeAll(async () => {
  t = await createPgTestDb({ poolSize: 20 });
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
});

function makeDeps(overrides: Partial<Deps> = {}): PgDeps {
  const adapter = new FakeAdapter("simulator");
  return {
    db: t.db,
    clock: systemClock,
    sleeper: realSleeper,
    storage: new MemoryStorage(),
    llm: new ScriptedLlm(),
    runner: new InlineRunner(),
    adapters: registryOf(adapter),
    models: { main: "claude-sonnet-5-5", fast: "claude-haiku-5-5", mainEffort: "medium" },
    handoff: null,
    pipeline: stubHandlers(),
    ...overrides,
    adapter,
  } as PgDeps;
}

let seq = 0;
function inbound(text: string | null, id = `pg-${++seq}`): InboundMessage {
  return {
    provider: "simulator",
    providerMessageId: id,
    fromE164: PHONE,
    toLine: "+12015550199",
    text,
    media: [],
    sentAt: systemClock.now(),
  };
}

function message(text: string | null, id?: string): NormalizedEvent {
  return { kind: "message", message: inbound(text, id) };
}

function reply(bubbles: string[], extra: Partial<AgentTurnOutput> = {}): AgentTurnOutput {
  return { bubbles, mode: "agent", stopReason: "end_turn", refusalCategory: null, usage: [], mediaSummaries: [], ...extra };
}

async function userId(db: Db = t.db): Promise<string> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.phoneE164, PHONE));
  return u.id;
}

async function allRows() {
  return t.db.select().from(inboundMessages).orderBy(asc(inboundMessages.sentAt));
}

/** Resolves once some statement in this test database is waiting on a row lock. */
async function waitForLockWait(timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await t.pool.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(res.rows[0].n) > 0) return;
    await realSleeper.sleep(10);
  }
  throw new Error("no statement started waiting on a lock");
}

describe("lease races (real Postgres)", () => {
  it("concurrent kicks for one user run exactly one turn at a time and strand nothing", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const handlers: PipelineHandlers = stubHandlers({
      runAgent: async (_d, input) => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await realSleeper.sleep(40);
        active -= 1;
        return reply([`turn of ${input.messages.length}`]);
      },
    });
    const deps = makeDeps({ pipeline: handlers });
    const extraKicks: Promise<KickResult>[] = [];
    for (let i = 0; i < 8; i++) {
      await handleInboundEvents(deps, [message(`m${i}`)], { timing: fast });
      const id = await userId();
      extraKicks.push(kick(deps, id, { timing: fast }), kick(deps, id, { timing: fast }));
      await realSleeper.sleep(i % 3 === 0 ? 120 : 15);
    }
    await Promise.all(extraKicks);
    await deps.runner.drain();
    expect(deps.runner.errors).toEqual([]);

    expect(maxActive).toBe(1);
    const rows = await allRows();
    expect(rows.map((r) => r.status)).toEqual(Array(8).fill("done"));
    const turnRows = await t.db.select().from(turns);
    expect(turnRows.length).toBe(calls);
    expect(new Set(rows.map((r) => r.turnId)).size).toBe(turnRows.length);
    expect(deps.adapter.sent).toHaveLength(turnRows.length);
    const [state] = await t.db.select().from(userTurnState);
    expect(state.leaseOwner).toBeNull();
  });

  it("an early wake (timer firing before process_after) never strands the message", async () => {
    const early: Sleeper = { sleep: (ms, signal) => realSleeper.sleep(Math.max(1, Math.floor(ms / 2)), signal) };
    const deps = makeDeps({ sleeper: early });
    await handleInboundEvents(deps, [message("hi")], { timing: fast });
    const [state] = await t.db.select().from(userTurnState);
    await deps.runner.drain();
    const [turn] = await t.db.select().from(turns);
    expect(turn.status).toBe("done");
    expect(turn.startedAt.getTime()).toBeGreaterThanOrEqual(state.processAfter.getTime());
    expect((await allRows())[0].status).toBe("done");
    expect(deps.adapter.sent).toHaveLength(1);
  });

  it("a dead holder's lease is taken over once it lapses", async () => {
    const deps = makeDeps();
    await ingestMessage(deps, inbound("hi"), timing);
    const id = await userId();
    // A holder that died 200 ms before its lease runs out (inside the fresh threshold).
    await t.db
      .update(userTurnState)
      .set({ leaseOwner: randomUUID(), leaseExpiresAt: new Date(systemClock.now().getTime() + 200) })
      .where(eq(userTurnState.userId, id));
    await realSleeper.sleep(timing.debounceMs + 10);
    const res = await kick(deps, id, { timing: fast });
    expect(res).toEqual({ outcome: "done", turns: 1 });
    expect(deps.adapter.sent).toHaveLength(1);
  });

  it("a dead holder's claimed turn is recovered by the next kick and answered once", async () => {
    const deps = makeDeps();
    // No kick is scheduled: the holder below claims the burst and then "dies".
    await ingestMessage(deps, inbound("hi"), resolveTiming({ ...fast, debounceMs: 0 }));
    const id = await userId();
    const dead = { userId: id, owner: randomUUID() };
    expect((await tryAcquireLease(deps, dead, timing.leaseTtlMs)).acquired).toBe(true);
    expect(await claimBurst(deps, dead)).not.toBeNull();
    await realSleeper.sleep(timing.leaseTtlMs + 50);

    await Promise.all([kick(deps, id, { timing: fast }), kick(deps, id, { timing: fast })]);
    expect(deps.adapter.sent).toHaveLength(1);
    const modes = (await t.db.select().from(turns)).map((x) => [x.mode, x.status]).sort();
    expect(modes).toEqual([
      ["agent", "failed"],
      ["recovery", "done"],
    ]);
  });

  it("a stalled holder whose lease was taken over cannot commit its turn", async () => {
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => (releaseA = r));
    let stallTx = false;
    let stalled!: () => void;
    const aStalled = new Promise<void>((r) => (stalled = r));

    // A's DB handle stalls its next transaction (the commit after the model call) until released.
    const aDb = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "transaction" && stallTx) {
          return async (...args: unknown[]) => {
            stallTx = false;
            stalled();
            await aGate;
            return (target.transaction as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Db;

    let mediaId = "";
    const depsA = makeDeps({
      db: aDb,
      pipeline: stubHandlers({
        runAgent: async () => {
          stallTx = true;
          return reply(["stale A"], { mediaSummaries: [{ mediaId, summary: "from A", kind: "meal" }] });
        },
      }),
    });
    const depsB = makeDeps({
      pipeline: stubHandlers({
        runAgent: async () => reply(["fresh B"], { mediaSummaries: [{ mediaId, summary: "from B", kind: "meal" }] }),
      }),
    });

    const lunch = { ...inbound("lunch"), media: [{ url: "https://media.example.test/m" }] };
    await ingestMessage(depsA, lunch, resolveTiming({ ...fast, debounceMs: 0 }));
    [{ id: mediaId }] = await t.db.select({ id: media.id }).from(media);
    const id = await userId();

    // A's heartbeat never fires (stalled process); its lease lapses while it is stuck.
    const aRun = kick(depsA, id, { timing: fast, heartbeatSleeper: stalledSleeper });
    await aStalled;
    await realSleeper.sleep(timing.leaseTtlMs + 50);
    const bRun = await kick(depsB, id, { timing: fast });
    expect(bRun.outcome).toBe("done");
    releaseA();
    const aRes = await aRun;

    expect(aRes.outcome).toBe("lease_lost");
    expect(depsA.adapter.sent).toHaveLength(0);
    expect(depsB.adapter.sent.map((m) => m.text)).toEqual(["fresh B"]);
    const [m] = await t.db.select().from(media);
    expect(m.summary).toBe("from B");
    const turnRows = await t.db.select().from(turns).orderBy(asc(turns.createdAt));
    expect(turnRows.map((x) => [x.mode, x.status, x.errorCode])).toEqual([
      ["agent", "failed", "orphaned"],
      ["recovery", "done", null],
    ]);
    const out = await t.db.select().from(outboundMessages);
    expect(out.map((o) => [o.text, o.turnId])).toEqual([["fresh B", turnRows[1].id]]);
  });

  it("fenced intent writes fail for a holder whose lease lapsed or was taken over", async () => {
    const deps = makeDeps();
    await ingestMessage(deps, inbound("x"), timing);
    const id = await userId();
    const a = { userId: id, owner: randomUUID() };
    const b = { userId: id, owner: randomUUID() };
    expect((await tryAcquireLease(deps, a, 100)).acquired).toBe(true);
    await realSleeper.sleep(120);
    const input = (lease: typeof a, anchor: string) => ({
      userId: id,
      turnId: null,
      anchorInboundId: anchor,
      bubbles: ["late"],
      kind: "reply" as const,
      lease,
    });
    // Race A's late write against B's takeover, many times over.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? writeReplyIntents(deps, input(a, randomUUID())) : tryAcquireLease(deps, b, 5_000),
      ),
    );
    for (const r of results) {
      if ("fenced" in r) expect(r).toEqual({ fenced: false, inserted: 0 });
    }
    expect(await writeReplyIntents(deps, input(b, randomUUID()))).toEqual({ fenced: true, inserted: 1 });
    const out = await t.db.select().from(outboundMessages);
    expect(out).toHaveLength(1);
  });

  it("an ingest landing between ACQUIRE and CLAIM is not claimed early", async () => {
    const deps = makeDeps();
    const tm = resolveTiming({ ...fast, debounceMs: 150 });
    await ingestMessage(deps, inbound("caption"), tm);
    const id = await userId();
    await realSleeper.sleep(160);
    const lease = { userId: id, owner: randomUUID() };
    expect((await tryAcquireLease(deps, lease, timing.leaseTtlMs)).acquired).toBe(true);
    // A photo lands after ACQUIRE: it pushes process_after forward.
    await ingestMessage(deps, inbound(null), tm);
    expect(await claimBurst(deps, lease)).toBeNull();
    expect((await allRows()).map((r) => r.status)).toEqual(["pending", "pending"]);
    await realSleeper.sleep(160);
    const turn = await claimBurst(deps, lease);
    expect(turn?.messages.map((m) => m.text)).toEqual(["caption", null]);
  });

  it("a holder woken by its debounce timer re-reads when a message landed meanwhile", async () => {
    let landed = false;
    const deps = makeDeps();
    const tm = { ...fast, debounceMs: 150 };
    // The holder's first debounce sleep is where the late photo arrives.
    deps.sleeper = {
      async sleep(ms, signal) {
        if (!landed && signal) {
          landed = true;
          await ingestMessage(deps, inbound(null), resolveTiming(tm));
        }
        await realSleeper.sleep(ms, signal);
      },
    };
    let seen: (string | null)[][] = [];
    deps.pipeline = stubHandlers({
      runAgent: async (_d, input) => {
        seen = [...seen, input.messages.map((m) => m.text)];
        return reply(["ok"]);
      },
    });
    await handleInboundEvents(deps, [message("caption")], { timing: tm });
    await deps.runner.drain();
    expect(seen).toEqual([["caption", null]]);
  });

  it("a stalled holder's commit that lands after the takeover is sent once by the new holder, never re-run", async () => {
    let armed = false;
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => (releaseA = r));
    let writtenA!: () => void;
    const aWritten = new Promise<void>((r) => (writtenA = r));

    // A's commit after the model call does all its (fenced) writes, then stalls before COMMIT.
    const aDb = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (cb: (tx: Db) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              const out = await cb(tx);
              if (armed) {
                armed = false;
                writtenA();
                await aGate;
              }
              return out;
            });
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Db;
    let agentCalls = 0;
    const depsA = makeDeps({
      db: aDb,
      pipeline: stubHandlers({
        runAgent: async () => {
          agentCalls += 1;
          armed = true;
          return reply(["from A"]);
        },
      }),
    });
    const depsB = makeDeps({
      pipeline: stubHandlers({
        runAgent: async () => {
          agentCalls += 1;
          return reply(["re-run by B"]);
        },
      }),
    });
    await ingestMessage(depsA, inbound("hi"), resolveTiming({ ...fast, debounceMs: 0 }));
    const id = await userId();

    const aRun = kick(depsA, id, { timing: fast, heartbeatSleeper: stalledSleeper });
    await aWritten;
    await realSleeper.sleep(timing.leaseTtlMs + 50);
    // B takes over and reads the orphan as uncommitted; its close then waits on A's row lock.
    const bRun = kick(depsB, id, { timing: fast });
    try {
      await waitForLockWait();
    } finally {
      releaseA();
    }
    const [aRes, bRes] = await Promise.all([aRun, bRun]);

    expect(aRes.outcome).toBe("lease_lost");
    expect(bRes.outcome).toBe("done");
    expect(agentCalls).toBe(1);
    expect(depsA.adapter.sent).toHaveLength(0);
    expect(depsB.adapter.sent.map((m) => m.text)).toEqual(["from A"]);
    expect((await t.db.select().from(turns)).map((x) => [x.mode, x.status])).toEqual([["agent", "done"]]);
    expect((await allRows()).map((r) => r.status)).toEqual(["done"]);
    const [state] = await t.db.select().from(userTurnState);
    expect(state.leaseOwner).toBeNull();
  });

  it("START never resumes over a STOP whose ingest commits while START is being applied", async () => {
    const deps = makeDeps();
    await handleInboundEvents(deps, [message("STOP")], { timing: fast });
    await deps.runner.drain();
    expect(deps.adapter.sent.map((m) => m.text)).toEqual([STOP_CONFIRMATION]);
    const id = await userId();

    await ingestMessage(deps, inbound("START"), timing);
    // A STOP ingest in flight: it holds the user row and its STOP row is not committed yet.
    const stopIngest = await t.pool.connect();
    try {
      await stopIngest.query("begin");
      await stopIngest.query("update users set messaging_paused_at = coalesce(messaging_paused_at, $2) where id = $1", [
        id,
        systemClock.now(),
      ]);
      await stopIngest.query(
        `insert into inbound_messages (user_id, provider, provider_message_id, keyword, sent_at, received_at)
         values ($1, 'simulator', 'late-stop', 'STOP', $2, $2)`,
        [id, systemClock.now()],
      );
      const run = kick(deps, id, { timing: fast });
      try {
        await waitForLockWait();
      } finally {
        await stopIngest.query("commit");
      }
      await run;
    } finally {
      stopIngest.release();
    }
    await deps.runner.drain();

    const [u] = await t.db.select().from(users).where(eq(users.id, id));
    expect(u.messagingPausedAt).not.toBeNull();
    expect(deps.adapter.sent.map((m) => m.text)).toEqual([STOP_CONFIRMATION]);
  });

  it("concurrent duplicate STOP deliveries and distinct STOPs give exactly one confirmation", async () => {
    const deps = makeDeps();
    const stop = message("STOP", "stop-dup");
    await Promise.all([
      ...Array.from({ length: 5 }, () => handleInboundEvents(deps, [stop], { timing: fast })),
      ...Array.from({ length: 3 }, () => handleInboundEvents(deps, [message("stop")], { timing: fast })),
    ]);
    await deps.runner.drain();
    expect(deps.adapter.sent.map((m) => m.text)).toEqual([STOP_CONFIRMATION]);
    const [{ n }] = await t.db
      .select({ n: countAll() })
      .from(outboundMessages)
      .where(eq(outboundMessages.kind, "priority"));
    expect(n).toBe(1);
  });
});
