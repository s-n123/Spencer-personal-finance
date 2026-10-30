import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMedia, NormalizedEvent } from "@/server/channels/types";
import { resetEnvForTests } from "@/server/config/env";
import { inboundMessages, media, outboundMessages, turns, users, userTurnState } from "@/server/db/schema";
import { countAll } from "@/server/db/sql";
import type { Runner } from "@/server/pipeline/runner";
import { crisisCopy, START_CONFIRMATION, STOP_CONFIRMATION, TURN_FAILED_REPLY } from "@/server/safety/copy";
import type { Sleeper } from "@/server/time";
import type { FakeClock } from "@/test/clock";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, stubHandlers, type TestDeps } from "@/test/deps";
import { claimBurst } from "./claim";
import type { AgentTurnInput, AgentTurnOutput, PipelineHandlers } from "./contracts";
import { handleInboundEvents } from "./inbound";
import { ingestMessage } from "./ingest";
import { kick } from "./kick";
import { resolveTiming, tryAcquireLease } from "./lease";
import { writeReplyIntents } from "./outbound";

// Ingest -> kick -> router on PGlite with a fake clock. PGlite serializes everything, so true races
// live in kick.pg.test.ts; here kicks still interleave at every await.

const PHONE = "+12015550100";
const OTHER = "+12015550101";
const timing = resolveTiming();

/** Holds scheduled kicks until the test flushes them, so a test controls what lands first. */
class DeferredRunner implements Runner {
  tasks: (() => Promise<void>)[] = [];
  readonly errors: unknown[] = [];
  run(_name: string, task: () => Promise<void>): void {
    this.tasks.push(task);
  }
  drop(): void {
    this.tasks = [];
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
  deps = makeTestDeps(t.db, { runner, pipeline: recordingHandlers() });
});
afterEach(() => {
  expect(runner.errors).toEqual([]);
});

function recordingHandlers(overrides: Partial<PipelineHandlers> = {}): PipelineHandlers {
  const base = stubHandlers();
  return stubHandlers({
    runAgent: async (d, input) => {
      agentCalls.push(input);
      return base.runAgent(d, input);
    },
    ...overrides,
  });
}

function agentReply(bubbles: string[]): AgentTurnOutput {
  return { bubbles, mode: "agent", stopReason: "end_turn", refusalCategory: null, usage: [], mediaSummaries: [] };
}

function message(
  text: string | null,
  opts: { phone?: string; id?: string; media?: InboundMedia[]; tz?: string } = {},
): NormalizedEvent {
  seq += 1;
  return {
    kind: "message",
    message: {
      provider: "simulator",
      providerMessageId: opts.id ?? `sim-${seq}`,
      fromE164: opts.phone ?? PHONE,
      toLine: "+12015550199",
      text,
      media: opts.media ?? [],
      sentAt: deps.clock.now(),
      timezoneHint: opts.tz,
    },
  };
}

async function send(...events: NormalizedEvent[]) {
  return handleInboundEvents(deps, events);
}

async function userByPhone(phone = PHONE) {
  const [u] = await deps.db.select().from(users).where(eq(users.phoneE164, phone));
  return u;
}

async function count(table: typeof turns | typeof inboundMessages | typeof outboundMessages | typeof users) {
  const [{ n }] = await deps.db.select({ n: countAll() }).from(table);
  return n;
}

async function outbound(userId: string) {
  return deps.db
    .select()
    .from(outboundMessages)
    .where(eq(outboundMessages.userId, userId))
    .orderBy(asc(outboundMessages.createdAt), asc(outboundMessages.seq));
}

describe("ingest", () => {
  it("dedupes on provider message id and re-kicks a still-pending duplicate", async () => {
    const event = message("hello", { id: "dup-1" });
    expect(await send(event)).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    expect(await send(event)).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    expect(runner.tasks).toHaveLength(2);
    expect(await count(inboundMessages)).toBe(1);

    await runner.flush();
    expect(await count(turns)).toBe(1);
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 1 message(s)"]);

    // A redelivery after the message is done schedules nothing.
    expect(await send(event)).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    expect(runner.tasks).toHaveLength(0);
  });

  it("creates a simulator user as consented (D-007) with the browser timezone, never overriding it", async () => {
    await send(message("hi", { tz: "America/Chicago" }));
    let u = await userByPhone();
    expect(u.status).toBe("active");
    expect(u.consentedAt?.toISOString()).toBe(deps.clock.now().toISOString());
    expect(u.timezone).toBe("America/Chicago");
    expect(u.timezoneSource).toBe("simulator");
    expect(u.line).toBe("+12015550199");

    await send(message("again", { tz: "Europe/Paris" }));
    u = await userByPhone();
    expect(u.timezone).toBe("America/Chicago");
  });

  it("acknowledges group, status and non-E.164 events without persisting anything", async () => {
    const appleId = message("hi", { phone: "someone@icloud.com" });
    const summary = await send(
      { kind: "ignored", reason: "group" },
      { kind: "status", providerMessageId: "x", status: "delivered" },
      appleId,
    );
    expect(summary).toEqual({ accepted: 0, duplicates: 0, ignored: 3 });
    expect(await count(users)).toBe(0);
    expect(await count(inboundMessages)).toBe(0);
    expect(runner.tasks).toHaveLength(0);
  });

  it("stores one pending media row per attachment and prefetches them for the kick", async () => {
    const prefetched: string[][] = [];
    const ensured: string[][] = [];
    deps.pipeline = recordingHandlers({
      prefetchMedia: async (_d, ids) => void prefetched.push(ids),
      ensureMedia: async (_d, ids) => {
        ensured.push(ids);
        return { ready: [], failed: [] };
      },
    });
    await send(
      message("lunch", {
        media: [
          { url: "https://media.example.test/a", mimeType: "image/heic" },
          { url: "https://media.example.test/b" },
        ],
      }),
    );
    const rows = await deps.db.select().from(media).orderBy(asc(media.providerUrl));
    expect(rows.map((r) => [r.status, r.providerUrl, r.sourceContentType])).toEqual([
      ["pending", "https://media.example.test/a", "image/heic"],
      ["pending", "https://media.example.test/b", null],
    ]);
    await runner.flush();
    expect(prefetched).toEqual([expect.arrayContaining(rows.map((r) => r.id))]);
    const [inbound] = await deps.db.select().from(inboundMessages);
    expect(ensured).toEqual([[inbound.id]]);
  });

  it("does not prefetch a paused user's photos (the router ignores them unless START resumes)", async () => {
    const prefetched: string[][] = [];
    deps.pipeline = recordingHandlers({ prefetchMedia: async (_d, ids) => void prefetched.push(ids) });
    await send(message("STOP"));
    await runner.flush();
    deps.clock.advance(60_000);
    await send(message(null, { media: [{ url: "https://media.example.test/p" }] }));
    await runner.flush();
    expect(prefetched).toEqual([]);
    expect(agentCalls).toHaveLength(0);
  });

  it("never logs message text or the crisis kind", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    // Debug level, so nothing is filtered out and the test can't pass with logging switched off.
    vi.stubEnv("LOG_LEVEL", "debug");
    resetEnvForTests();
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];
    try {
      await send(message("I want to kill myself"), message("I haven't eaten in 3 days"));
      await runner.flush();
    } finally {
      for (const s of spies) s.mockRestore();
      vi.unstubAllEnvs();
      resetEnvForTests();
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/self_harm|"ed"|kill myself|eaten|\+1201555/);
  });

  it("caps the debounce per burst (newest + DEBOUNCE, at most first + MAX_DEBOUNCE)", async () => {
    const start = deps.clock.now().getTime();
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      await send(message(`m${i}`));
      const [s] = await deps.db.select().from(userTurnState);
      seen.push(s.processAfter.getTime() - start);
      expect(s.burstStartedAt?.getTime()).toBe(start);
      deps.clock.advance(3_000);
    }
    expect(seen).toEqual([4_000, 7_000, 10_000, 13_000, 15_000, 15_000, 15_000]);
  });

  it("propagates a DB error so the route can answer 503", async () => {
    const broken = makeTestDeps(t.db, {
      runner,
      db: new Proxy(t.db, {
        get(target, prop, receiver) {
          if (prop === "transaction") return () => Promise.reject(new Error("connection refused"));
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }),
    });
    await expect(handleInboundEvents(broken, [message("hi")])).rejects.toThrow("connection refused");
  });
});

describe("turns", () => {
  it("one message from a new number gives exactly one turn and one reply", async () => {
    await send(message("what should I eat?"));
    await runner.flush();
    const u = await userByPhone();
    expect(await count(turns)).toBe(1);
    const [turn] = await deps.db.select().from(turns);
    expect(turn.status).toBe("done");
    expect(turn.mode).toBe("agent");
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 1 message(s)"]);
    expect(deps.adapter.typing).toEqual([PHONE]);
    const out = await outbound(u.id);
    expect(out.map((o) => [o.kind, o.status, o.idempotencyKey])).toEqual([
      ["reply", "sent", `reply:${agentCalls[0].messages[0].id}:0`],
    ]);
    expect(agentCalls[0].timezone).toBe("America/New_York");
    const [row] = await deps.db.select().from(inboundMessages);
    expect(row.status).toBe("done");
    expect(row.turnId).toBe(turn.id);
  });

  it("photo + caption + photo inside the debounce become one turn", async () => {
    await send(message(null, { media: [{ url: "https://media.example.test/1" }] }));
    deps.clock.advance(1_000);
    await send(message("chicken bowl"));
    deps.clock.advance(1_500);
    await send(message(null, { media: [{ url: "https://media.example.test/2" }] }));
    await runner.flush();

    expect(await count(turns)).toBe(1);
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0].messages.map((m) => m.text)).toEqual([null, "chicken bowl", null]);
    expect(agentCalls[0].turnClock.toISOString()).toBe(agentCalls[0].messages[2].sentAt.toISOString());
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 3 message(s)"]);
  });

  it("two bursts more than MAX_DEBOUNCE apart become two turns", async () => {
    await send(message("first"));
    await runner.flush();
    deps.clock.advance(timing.maxDebounceMs + 5_000);
    await send(message("second"));
    await runner.flush();
    expect(await count(turns)).toBe(2);
    expect(agentCalls.map((c) => c.messages.map((m) => m.text))).toEqual([["first"], ["second"]]);
  });

  it("a stream longer than MAX_DEBOUNCE is split at the cap, and the next burst gets its own cap", async () => {
    // A message every 3 s from t=3 s to t=27 s, delivered while the holder sleeps; the model call
    // takes 4 s of (fake) time.
    const clock = deps.clock;
    const start = clock.now().getTime();
    const due = [3, 6, 9, 12, 15, 18, 21, 24, 27].map((s) => start + s * 1_000);
    const deliverDue = async () => {
      while (due.length > 0 && due[0] <= clock.now().getTime()) {
        due.shift();
        const event = message(`m@${(clock.now().getTime() - start) / 1_000}`);
        // Straight to ingest: the holder already sleeping is the one that must pick these up.
        if (event.kind === "message") await ingestMessage(deps, event.message);
      }
    };
    const streaming: Sleeper = {
      async sleep(ms, signal) {
        if (signal?.aborted) throw signal.reason;
        const until = clock.now().getTime() + ms;
        while (clock.now().getTime() < until) {
          clock.set(new Date(Math.min(until, due[0] ?? Infinity)));
          await deliverDue();
        }
      },
    };
    deps.sleeper = streaming as TestDeps["sleeper"];
    deps.pipeline = recordingHandlers({
      runAgent: async (d, input) => {
        agentCalls.push(input);
        await d.sleeper.sleep(4_000);
        return agentReply([`turn of ${input.messages.length}`]);
      },
    });

    await send(message("m@0"));
    await runner.flush();

    // Burst 1 starts at 0 and is capped at 15 s (m@15 lands exactly at the cap and rides along).
    // Burst 2 starts at 18 s, after the claim cleared burst_started_at, so its cap is 33 s, not 15.
    const texts = agentCalls.map((c) => c.messages.map((m) => m.text));
    expect(texts).toEqual([
      ["m@0", "m@3", "m@6", "m@9", "m@12", "m@15"],
      ["m@18", "m@21", "m@24", "m@27"],
    ]);
    const turnRows = await deps.db.select().from(turns).orderBy(asc(turns.startedAt));
    expect(turnRows.map((x) => x.startedAt.getTime() - start)).toEqual([15_000, 31_000]);
  });

  it("an early wake re-reads and sleeps again instead of claiming or exiting", async () => {
    // Wakes after half the requested time, like a timer firing early under clock skew.
    const clock = deps.clock;
    const early: Sleeper = {
      async sleep(ms, signal) {
        if (signal?.aborted) throw signal.reason;
        clock.advance(Math.max(1, Math.floor(ms / 2)));
        await new Promise<void>((r) => setImmediate(r));
      },
    };
    deps.sleeper = early as TestDeps["sleeper"];
    await send(message("hi"));
    const [state] = await deps.db.select().from(userTurnState);
    await runner.flush();
    const [turn] = await deps.db.select().from(turns);
    expect(turn.startedAt.getTime()).toBeGreaterThanOrEqual(state.processAfter.getTime());
    expect(deps.adapter.textsTo(PHONE)).toHaveLength(1);
  });

  it("a failed agent run answers with the fixed apology and marks the rows failed", async () => {
    deps.pipeline = recordingHandlers({
      runAgent: async () => {
        throw new Error("model exploded");
      },
    });
    await send(message("hi"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([TURN_FAILED_REPLY]);
    const [turn] = await deps.db.select().from(turns);
    expect([turn.status, turn.errorCode]).toEqual(["failed", "Error"]);
    const [row] = await deps.db.select().from(inboundMessages);
    expect(row.status).toBe("failed");
  });

  it("an agent reply with no sendable bubbles still answers, with the apology", async () => {
    deps.pipeline = recordingHandlers({ runAgent: async () => agentReply(["   ", ""]) });
    await send(message("hi"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([TURN_FAILED_REPLY]);
    const [turn] = await deps.db.select().from(turns);
    expect([turn.status, turn.errorCode]).toEqual(["failed", "empty_reply"]);
  });

  it("writes the agent's media summaries and turn usage", async () => {
    let mediaId = "";
    deps.pipeline = recordingHandlers({
      runAgent: async () => ({
        ...agentReply(["nice bowl"]),
        usage: [
          {
            latencyMs: 900,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            stopReason: "end_turn",
          },
        ],
        mediaSummaries: [{ mediaId, summary: "[photo: chicken bowl]", kind: "meal" }],
      }),
    });
    await send(message(null, { media: [{ url: "https://media.example.test/x" }] }));
    [{ id: mediaId }] = await deps.db.select({ id: media.id }).from(media);
    await runner.flush();
    const [m] = await deps.db.select().from(media);
    expect([m.summary, m.kind]).toEqual(["[photo: chicken bowl]", "meal"]);
    const [turn] = await deps.db.select().from(turns);
    expect(turn.iterations).toBe(1);
    expect(turn.stopReason).toBe("end_turn");
  });
});

describe("STOP and START", () => {
  it("STOP pauses inside ingest and yields exactly one confirmation despite duplicate deliveries and kicks", async () => {
    const stop = message("STOP", { id: "stop-1" });
    await send(stop);
    // Paused at ingest, before any kick ran.
    expect((await userByPhone()).messagingPausedAt?.toISOString()).toBe(deps.clock.now().toISOString());
    await send(stop);
    await send(stop);
    const userId = (await userByPhone()).id;
    await Promise.all([runner.flush(), kick(deps, userId), kick(deps, userId)]);
    await Promise.all([kick(deps, userId), kick(deps, userId)]);
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION]);

    // Another STOP in the same pause episode gets no second confirmation.
    deps.clock.advance(60_000);
    await send(message("unsubscribe"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION]);
    expect(agentCalls).toHaveLength(0);
  });

  it("a plain-language opt-out stores only the STOP tag, never its text; a bare keyword keeps its text", async () => {
    await send(message("leave me alone, I'm done with this"));
    await runner.flush();
    deps.clock.advance(60_000);
    await send(message("STOP"));
    await runner.flush();
    const rows = await deps.db.select().from(inboundMessages).orderBy(asc(inboundMessages.receivedAt));
    expect(rows.map((r) => [r.keyword, r.text])).toEqual([
      ["STOP", null],
      ["STOP", "STOP"],
    ]);
    expect((await userByPhone()).messagingPausedAt).not.toBeNull();
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION]);
  });

  it("a paused user's ordinary messages are ignored", async () => {
    await send(message("STOP"));
    await runner.flush();
    deps.clock.advance(60_000);
    await send(message("what's for dinner?"));
    await runner.flush();
    expect(agentCalls).toHaveLength(0);
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION]);
    const rows = await deps.db.select().from(inboundMessages).orderBy(asc(inboundMessages.receivedAt));
    expect(rows.map((r) => r.status)).toEqual(["done", "ignored"]);
  });

  it("a [STOP, START] burst processes START", async () => {
    await send(message("STOP"));
    deps.clock.advance(1_000);
    await send(message("START"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION, START_CONFIRMATION]);
    expect((await userByPhone()).messagingPausedAt).toBeNull();
    expect(agentCalls).toHaveLength(0);

    // Replies resume.
    deps.clock.advance(60_000);
    await send(message("hi again"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION, START_CONFIRMATION, "got 1 message(s)"]);
  });

  it("a [START, STOP] burst stays paused", async () => {
    await send(message("START"));
    deps.clock.advance(1_000);
    await send(message("STOP"));
    await runner.flush();
    expect((await userByPhone()).messagingPausedAt).not.toBeNull();
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION]);
  });

  it("STOP after START gets a fresh confirmation (a new pause episode)", async () => {
    await send(message("STOP"));
    await runner.flush();
    deps.clock.advance(60_000);
    await send(message("START"));
    await runner.flush();
    deps.clock.advance(60_000);
    await send(message("STOP"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION, START_CONFIRMATION, STOP_CONFIRMATION]);
  });

  it("STOP arriving while the turn's model call runs suppresses that turn's bubbles", async () => {
    deps.pipeline = recordingHandlers({
      runAgent: async (_d, input) => {
        agentCalls.push(input);
        await handleInboundEvents(deps, [message("STOP")]);
        return agentReply(["one", "two"]);
      },
    });
    await send(message("hi"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION]);
    const u = await userByPhone();
    const replies = (await outbound(u.id)).filter((o) => o.kind === "reply");
    expect(replies.map((o) => o.status)).toEqual(["suppressed", "suppressed"]);
  });

  it("STOP arriving between two bubbles suppresses the unsent one", async () => {
    deps.pipeline = recordingHandlers({ runAgent: async () => agentReply(["one", "two"]) });
    let stopped = false;
    deps.adapter.onSend = async () => {
      if (stopped) return;
      stopped = true;
      await handleInboundEvents(deps, [message("STOP")]);
    };
    await send(message("hi"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual(["one", STOP_CONFIRMATION]);
    const u = await userByPhone();
    const replies = (await outbound(u.id)).filter((o) => o.kind === "reply");
    expect(replies.map((o) => o.status)).toEqual(["sent", "suppressed"]);
  });
});

describe("crisis", () => {
  it("sends the crisis copy exactly once, stores only the tag, and never calls the agent", async () => {
    await send(message("I want to kill myself"));
    const userId = (await userByPhone()).id;
    await Promise.all([runner.flush(), kick(deps, userId), kick(deps, userId)]);
    expect(deps.adapter.textsTo(PHONE)).toEqual([crisisCopy.self_harm]);
    expect(agentCalls).toHaveLength(0);
    const [row] = await deps.db.select().from(inboundMessages);
    expect([row.text, row.crisisKind, row.status]).toEqual([null, "self_harm", "done"]);
    const [turn] = await deps.db.select().from(turns);
    expect(turn.mode).toBe("safety");
  });

  it("a crisis reply goes out even while paused, and a crisis burst skips the agent for its other rows", async () => {
    await send(message("STOP"));
    await runner.flush();
    deps.clock.advance(60_000);
    await send(message(null, { media: [{ url: "https://media.example.test/p" }] }));
    deps.clock.advance(1_000);
    await send(message("I haven't eaten in 3 days"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([STOP_CONFIRMATION, crisisCopy.ed]);
    expect(agentCalls).toHaveLength(0);
  });

  it("a message that is both STOP and crisis gets both priority replies, crisis first", async () => {
    await send(message("stop texting me, I want to die"));
    await runner.flush();
    expect(deps.adapter.textsTo(PHONE)).toEqual([crisisCopy.self_harm, STOP_CONFIRMATION]);
    expect((await userByPhone()).messagingPausedAt).not.toBeNull();
    expect(agentCalls).toHaveLength(0);
  });

  it("a re-driven kick after a crash sends unsent priority intents once and never re-screens", async () => {
    await send(message("I think I overdosed"));
    runner.drop(); // the kick died before sending
    const userId = (await userByPhone()).id;
    expect((await outbound(userId)).map((o) => o.status)).toEqual(["intent"]);

    // A row stored without tags (screened clean at ingest) is never re-screened by a kick.
    deps.clock.advance(1_000);
    await deps.db.insert(inboundMessages).values({
      userId,
      provider: "simulator",
      providerMessageId: "legacy-1",
      text: "I want to die",
      sentAt: deps.clock.now(),
      receivedAt: deps.clock.now(),
    });

    await kick(deps, userId);
    await kick(deps, userId);
    await runner.flush();
    const out = await outbound(userId);
    expect(out.filter((o) => o.kind === "priority").map((o) => [o.status, o.text])).toEqual([
      ["sent", crisisCopy.emergency],
    ]);
    expect(deps.adapter.textsTo(PHONE)).toEqual([crisisCopy.emergency]);
    // Only ingest's tag produced a priority intent; the untagged row rode along in the crisis
    // burst, which ends without the agent.
    expect(agentCalls).toHaveLength(0);
    const rows = await deps.db.select().from(inboundMessages).orderBy(asc(inboundMessages.receivedAt));
    expect(rows.map((r) => [r.crisisKind, r.status])).toEqual([
      ["emergency", "done"],
      [null, "ignored"],
    ]);
  });

  it("an intent left in 'sending' by a crashed kick is never resent", async () => {
    await send(message("I want to die"));
    runner.drop();
    const userId = (await userByPhone()).id;
    await deps.db.update(outboundMessages).set({ status: "sending" }).where(eq(outboundMessages.userId, userId));
    await kick(deps, userId);
    expect(deps.adapter.sent).toHaveLength(0);
  });
});

describe("recovery, sweep and handoff", () => {
  async function orphanTurn(text: string) {
    await send(message(text));
    runner.drop();
    const userId = (await userByPhone()).id;
    const lease = { userId, owner: randomUUID() };
    expect((await tryAcquireLease(deps, lease, timing.leaseTtlMs)).acquired).toBe(true);
    deps.clock.advance(timing.debounceMs);
    const turn = await claimBurst(deps, lease);
    expect(turn).not.toBeNull();
    return { userId, lease, turn: turn! };
  }

  it("re-runs an orphaned turn with nothing committed, once, as a recovery turn", async () => {
    const { userId, turn } = await orphanTurn("hi");
    (deps.clock as FakeClock).advance(timing.leaseTtlMs + 1); // the holder died
    await kick(deps, userId);
    expect(agentCalls).toHaveLength(1);
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 1 message(s)"]);
    const all = await deps.db.select().from(turns).orderBy(asc(turns.createdAt));
    const old = all.find((x) => x.id === turn.id)!;
    const rerun = all.find((x) => x.id !== turn.id)!;
    expect([old.status, old.errorCode]).toEqual(["failed", "orphaned"]);
    expect([rerun.status, rerun.mode]).toEqual(["done", "recovery"]);
    const [row] = await deps.db.select().from(inboundMessages);
    expect([row.status, row.turnId]).toEqual(["done", rerun.id]);
  });

  it("sends an orphan's unsent intents without re-running it", async () => {
    const { userId, lease, turn } = await orphanTurn("hi");
    await writeReplyIntents(deps, {
      userId,
      turnId: turn.id,
      anchorInboundId: turn.messages[0].id,
      bubbles: ["already decided"],
      kind: "reply",
      lease,
    });
    await deps.db.update(turns).set({ status: "reply_written" }).where(eq(turns.id, turn.id));
    deps.clock.advance(timing.leaseTtlMs + 1);
    await kick(deps, userId);
    expect(agentCalls).toHaveLength(0);
    expect(deps.adapter.textsTo(PHONE)).toEqual(["already decided"]);
    const [t1] = await deps.db.select().from(turns);
    expect(t1.status).toBe("done");
  });

  it("a takeover between the orphan's closure and its row move rolls the move back, stranding nothing", async () => {
    const { userId, turn } = await orphanTurn("hi");
    deps.clock.advance(timing.leaseTtlMs + 1);
    // Another holder takes the lease right after the recovery turn is inserted, i.e. between the
    // (checked) orphan closure and the (fenced) row move in the same transaction.
    await t.client.exec(`
      create function test_steal_lease() returns trigger language plpgsql as $$
      begin
        update user_turn_state set lease_owner = gen_random_uuid() where user_id = new.user_id;
        return new;
      end $$;
      create trigger test_steal_lease after insert on turns
        for each row when (new.mode = 'recovery') execute function test_steal_lease();`);
    try {
      expect((await kick(deps, userId)).outcome).toBe("lease_lost");
    } finally {
      await t.client.exec(`drop trigger test_steal_lease on turns; drop function test_steal_lease();`);
    }
    // Nothing half-committed: the orphan is still open and still owns its row.
    expect((await deps.db.select().from(turns)).map((x) => [x.id, x.status])).toEqual([[turn.id, "claimed"]]);
    const [row] = await deps.db.select().from(inboundMessages);
    expect([row.status, row.turnId]).toEqual(["processing", turn.id]);

    deps.clock.advance(timing.leaseTtlMs + 1);
    await kick(deps, userId);
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 1 message(s)"]);
    const [done] = await deps.db.select().from(inboundMessages);
    expect(done.status).toBe("done");
  });

  it("gives up on a turn orphaned twice and apologizes", async () => {
    const { userId, turn } = await orphanTurn("hi");
    await deps.db.update(turns).set({ mode: "recovery" }).where(eq(turns.id, turn.id));
    deps.clock.advance(timing.leaseTtlMs + 1);
    await kick(deps, userId);
    expect(agentCalls).toHaveLength(0);
    expect(deps.adapter.textsTo(PHONE)).toEqual([TURN_FAILED_REPLY]);
    const [row] = await deps.db.select().from(inboundMessages);
    expect(row.status).toBe("failed");
  });

  it("a fresh lease held by a live holder makes a kick return without touching the turn", async () => {
    await send(message("hi"));
    runner.drop();
    const userId = (await userByPhone()).id;
    const holder = { userId, owner: randomUUID() };
    await tryAcquireLease(deps, holder, timing.leaseTtlMs);
    const res = await kick(deps, userId);
    expect(res.outcome).toBe("busy");
    expect(await count(turns)).toBe(0);
  });

  it("the opportunistic sweep hands off another user's stranded messages", async () => {
    await send(message("stranded", { phone: OTHER }));
    runner.drop(); // its kick was lost
    deps.clock.advance(timing.sweepStaleAfterMs + 1_000);
    await send(message("hi"));
    await runner.flush();
    expect(deps.adapter.textsTo(OTHER)).toEqual(["got 1 message(s)"]);
    expect(deps.adapter.textsTo(PHONE)).toEqual(["got 1 message(s)"]);
  });

  it("the sweep uses deps.handoff when one is wired, never processing inline", async () => {
    const handoff = vi.fn(async () => undefined);
    deps.handoff = handoff;
    await send(message("stranded", { phone: OTHER }));
    runner.drop();
    deps.clock.advance(timing.sweepStaleAfterMs + 1_000);
    await send(message("hi"));
    await runner.flush();
    const other = await userByPhone(OTHER);
    expect(handoff).toHaveBeenCalledWith(other.id);
    expect(deps.adapter.textsTo(OTHER)).toEqual([]);
  });

  it("hands off (after releasing the lease) when the invocation is low on time", async () => {
    const handoff = vi.fn(async () => undefined);
    deps.handoff = handoff;
    await send(message("hi"));
    runner.drop();
    const userId = (await userByPhone()).id;
    const res = await kick(deps, userId, { deadlineMs: deps.clock.now().getTime() + timing.minTurnBudgetMs - 1 });
    expect(res.outcome).toBe("handed_off");
    expect(handoff).toHaveBeenCalledWith(userId);
    const [state] = await deps.db.select().from(userTurnState);
    expect(state.leaseOwner).toBeNull();
    const [row] = await deps.db.select().from(inboundMessages).where(and(eq(inboundMessages.userId, userId)));
    expect(row.status).toBe("pending");
  });
});
