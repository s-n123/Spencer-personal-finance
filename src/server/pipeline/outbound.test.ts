import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SendOptions, SendResult } from "@/server/channels/types";
import { outboundMessages, users, userTurnState } from "@/server/db/schema";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, type TestDeps } from "@/test/deps";
import { addMs, resolveTiming, tryAcquireLease, type LeaseHandle } from "./lease";
import { mapSendStatus, sendPending, writeReplyIntents, type OutboundKind } from "./outbound";

const PHONE = "+12015550102";
const timing = resolveTiming();

let t: TestDb;
let deps: TestDeps;
let userId: string;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
  deps = makeTestDeps(t.db);
  const [u] = await deps.db
    .insert(users)
    .values({ phoneE164: PHONE, provider: "simulator", line: "+12015550199", status: "active" })
    .returning({ id: users.id });
  userId = u.id;
  await deps.db.insert(userTurnState).values({ userId, processAfter: deps.clock.now() });
});

let n = 0;
async function intent(kind: OutboundKind, text: string, key = `test:${++n}`) {
  const [row] = await deps.db
    .insert(outboundMessages)
    .values({ userId, kind, text, idempotencyKey: key })
    .returning({ id: outboundMessages.id });
  return row.id;
}

async function statuses() {
  const rows = await deps.db
    .select()
    .from(outboundMessages)
    .orderBy(asc(outboundMessages.createdAt), asc(outboundMessages.idempotencyKey));
  return rows;
}

async function acquire(): Promise<LeaseHandle> {
  const lease = { userId, owner: randomUUID() };
  expect((await tryAcquireLease(deps, lease, timing.leaseTtlMs)).acquired).toBe(true);
  return lease;
}

describe("mapSendStatus", () => {
  it.each([
    ["sent", "sent"],
    ["opted_out", "undeliverable"],
    ["failed", "failed"],
    ["rate_limited", "failed"],
    ["unknown", "unknown"],
  ] as const)("%s -> %s", (from, to) => {
    expect(mapSendStatus(from)).toBe(to);
  });
});

describe("sendPending", () => {
  it("records a sent bubble with the provider id, line and send time", async () => {
    await intent("reply", "hello");
    const summary = await sendPending(deps, userId);
    expect(summary.sent).toBe(1);
    const [row] = await statuses();
    expect(row.status).toBe("sent");
    expect(row.providerMessageId).toBeTruthy();
    expect(row.fromLine).toBe("+12015550199");
    expect(row.sentAt?.toISOString()).toBe(deps.clock.now().toISOString());
    expect(deps.adapter.sent).toEqual([expect.objectContaining({ from: "+12015550199", to: PHONE, text: "hello" })]);
  });

  it("maps provider results: opted_out -> undeliverable, failed/rate_limited -> failed", async () => {
    await intent("reply", "a", "k1");
    await intent("reply", "b", "k2");
    await intent("reply", "c", "k3");
    deps.adapter.failNext = { status: "rate_limited", count: 1 };
    await sendPending(deps, userId);
    deps.adapter.optedOut.add(PHONE);
    await intent("reply", "d", "k4");
    await sendPending(deps, userId);
    const rows = await statuses();
    expect(rows.map((r) => [r.idempotencyKey, r.status])).toEqual([
      ["k1", "failed"],
      ["k2", "sent"],
      ["k3", "sent"],
      ["k4", "undeliverable"],
    ]);
    expect(rows[0].errorCode).toBe("FAKE_FAILURE");
    expect(rows[3].errorCode).toBe("OPTED_OUT");
  });

  it("a thrown or timed-out send becomes 'unknown' and is never resent", async () => {
    await intent("reply", "boom", "k1");
    await intent("reply", "slow", "k2");
    const original = deps.adapter.sendText.bind(deps.adapter);
    deps.adapter.sendText = async (from: string | null, to: string, text: string, opts: SendOptions): Promise<SendResult> => {
      if (text === "boom") throw new Error("socket hang up");
      if (text === "slow") {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }
      return original(from, to, text, opts);
    };
    await sendPending(deps, userId);
    await sendPending(deps, userId);
    const rows = await statuses();
    expect(rows.map((r) => [r.status, r.errorCode])).toEqual([
      ["unknown", "send_threw"],
      ["unknown", "timeout"],
    ]);
    expect(deps.adapter.sent).toHaveLength(0);
  });

  it("passes the idempotency key and a per-send timeout signal to the adapter", async () => {
    await intent("reply", "hi", "reply:abc:0");
    let seen: SendOptions | null = null;
    deps.adapter.onSend = () => undefined;
    const original = deps.adapter.sendText.bind(deps.adapter);
    deps.adapter.sendText = async (from, to, text, opts) => {
      seen = opts;
      return original(from, to, text, opts);
    };
    await sendPending(deps, userId);
    expect(seen).toMatchObject({ idempotencyKey: "reply:abc:0" });
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
  });

  it("suppresses non-exempt kinds for a paused user but still sends priority, safety and command", async () => {
    await deps.db.update(users).set({ messagingPausedAt: deps.clock.now() }).where(eq(users.id, userId));
    for (const kind of ["reply", "proactive", "onboarding", "priority", "safety", "command"] as const) {
      await intent(kind, kind, `k-${kind}`);
    }
    await sendPending(deps, userId);
    const byKind = Object.fromEntries((await statuses()).map((r) => [r.kind, r.status]));
    expect(byKind).toEqual({
      reply: "suppressed",
      proactive: "suppressed",
      onboarding: "suppressed",
      priority: "sent",
      safety: "sent",
      command: "sent",
    });
  });

  it("sends priority intents first (crisis before the STOP confirmation), then by age and seq", async () => {
    await intent("reply", "r0", "reply:x:0");
    deps.clock.advance(10);
    await intent("priority", "stop", "priority:in1:stop");
    await intent("priority", "crisis", "priority:in1:crisis");
    await sendPending(deps, userId);
    expect(deps.adapter.sent.map((m) => m.text)).toEqual(["crisis", "stop", "r0"]);
  });

  it("concurrent senders never double-send (conditional claim)", async () => {
    for (let i = 0; i < 5; i++) await intent("reply", `b${i}`);
    await Promise.all([sendPending(deps, userId), sendPending(deps, userId), sendPending(deps, userId)]);
    expect(deps.adapter.sent.map((m) => m.text).sort()).toEqual(["b0", "b1", "b2", "b3", "b4"]);
  });

  it("with an owner, non-priority intents wait while the lease is someone else's", async () => {
    const mine = await acquire();
    await intent("reply", "late reply");
    await intent("priority", "crisis", "priority:z:crisis");
    // Our lease lapses and another holder takes over.
    deps.clock.advance(timing.leaseTtlMs + 1);
    await acquire();
    await sendPending(deps, userId, { owner: mine });
    expect(deps.adapter.sent.map((m) => m.text)).toEqual(["crisis"]);
    const reply = (await statuses()).find((r) => r.kind === "reply");
    expect(reply?.status).toBe("intent");
  });
});

describe("writeReplyIntents", () => {
  it("writes one intent per bubble keyed reply:<anchor>:<i>, idempotently", async () => {
    const lease = await acquire();
    const anchor = randomUUID();
    const input = { userId, turnId: null, anchorInboundId: anchor, bubbles: ["one", "two"], kind: "reply" as const, lease };
    expect(await writeReplyIntents(deps, input)).toEqual({ fenced: true, inserted: 2 });
    expect(await writeReplyIntents(deps, input)).toEqual({ fenced: true, inserted: 0 });
    const rows = await statuses();
    expect(rows.map((r) => [r.idempotencyKey, r.seq, r.text, r.status])).toEqual([
      [`reply:${anchor}:0`, 0, "one", "intent"],
      [`reply:${anchor}:1`, 1, "two", "intent"],
    ]);
  });

  it("is fenced: a holder whose lease was taken over writes nothing", async () => {
    const stale = await acquire();
    deps.clock.advance(timing.leaseTtlMs + 1);
    await acquire();
    const res = await writeReplyIntents(deps, {
      userId,
      turnId: null,
      anchorInboundId: randomUUID(),
      bubbles: ["too late"],
      kind: "reply",
      lease: stale,
    });
    expect(res).toEqual({ fenced: false, inserted: 0 });
    expect(await statuses()).toHaveLength(0);
  });

  it("is fenced on expiry too, even before anyone takes over", async () => {
    const lease = await acquire();
    await deps.db
      .update(userTurnState)
      .set({ leaseExpiresAt: addMs(deps.clock.now(), -1) })
      .where(eq(userTurnState.userId, userId));
    const res = await writeReplyIntents(deps, {
      userId,
      turnId: null,
      anchorInboundId: randomUUID(),
      bubbles: ["x"],
      kind: "reply",
      lease,
    });
    expect(res.fenced).toBe(false);
  });
});
