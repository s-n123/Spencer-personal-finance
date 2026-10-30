import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users, userTurnState } from "@/server/db/schema";
import type { Sleeper } from "@/server/time";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, type TestDeps } from "@/test/deps";
import {
  acquireLease,
  addMs,
  holdsLease,
  releaseLease,
  renewLease,
  resolveTiming,
  startHeartbeat,
  tryAcquireLease,
} from "./lease";

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
    .values({ phoneE164: "+12015550104", provider: "simulator" })
    .returning({ id: users.id });
  userId = u.id;
  await deps.db.insert(userTurnState).values({ userId, processAfter: deps.clock.now() });
});

const handle = () => ({ userId, owner: randomUUID() });

async function setExpiry(ms: number) {
  await deps.db
    .update(userTurnState)
    .set({ leaseExpiresAt: addMs(deps.clock.now(), ms) })
    .where(eq(userTurnState.userId, userId));
}

describe("acquireLease", () => {
  it("acquires a free lease", async () => {
    const me = handle();
    expect(await acquireLease(deps, me, timing)).toBe("acquired");
    expect(await holdsLease(deps.db, me, deps.clock.now())).toBe(true);
  });

  it("returns no_state when the user has no turn state", async () => {
    expect(await acquireLease(deps, { userId: randomUUID(), owner: randomUUID() }, timing)).toBe("no_state");
  });

  it("returns busy while a live holder's lease is fresh", async () => {
    await acquireLease(deps, handle(), timing);
    expect(await acquireLease(deps, handle(), timing)).toBe("busy");
    expect(deps.sleeper.calls).toEqual([]);
  });

  it("waits out a lease close to expiry, then takes it over", async () => {
    const holder = handle();
    await acquireLease(deps, holder, timing);
    await setExpiry(10_000);
    const me = handle();
    expect(await acquireLease(deps, me, timing)).toBe("acquired");
    expect(deps.sleeper.calls).toEqual([10_001]);
    expect(await holdsLease(deps.db, holder, deps.clock.now())).toBe(false);
  });

  it("gives up after acquireAttempts retries against a holder that keeps limping on", async () => {
    await acquireLease(deps, handle(), timing);
    await setExpiry(5_000);
    // Each time we wake, the holder has renewed just enough to stay near expiry.
    const limping: Sleeper = {
      sleep: async (ms) => {
        deps.clock.advance(ms - 2);
        await setExpiry(5_000);
      },
    };
    deps.sleeper = limping as TestDeps["sleeper"];
    expect(await acquireLease(deps, handle(), timing)).toBe("gave_up");
  });
});

describe("renew and release", () => {
  it("are fenced on the owner", async () => {
    const me = handle();
    const other = handle();
    await tryAcquireLease(deps, me, timing.leaseTtlMs);
    expect(await renewLease(deps, other, timing.leaseTtlMs)).toBe(false);
    expect(await releaseLease(deps, other)).toBe(false);
    deps.clock.advance(30_000);
    expect(await renewLease(deps, me, timing.leaseTtlMs)).toBe(true);
    const [s] = await deps.db.select().from(userTurnState);
    expect(s.leaseExpiresAt?.getTime()).toBe(deps.clock.now().getTime() + timing.leaseTtlMs);
    expect(await releaseLease(deps, me)).toBe(true);
    const [after] = await deps.db.select().from(userTurnState);
    expect([after.leaseOwner, after.leaseExpiresAt]).toEqual([null, null]);
  });

  it("renew extends an overdue lease nobody took over", async () => {
    const me = handle();
    await tryAcquireLease(deps, me, timing.leaseTtlMs);
    deps.clock.advance(timing.leaseTtlMs + 1);
    expect(await holdsLease(deps.db, me, deps.clock.now())).toBe(false);
    expect(await renewLease(deps, me, timing.leaseTtlMs)).toBe(true);
    expect(await holdsLease(deps.db, me, deps.clock.now())).toBe(true);
  });
});

describe("startHeartbeat", () => {
  /** Resolves each sleep only when the test calls tick(). */
  function steppedSleeper() {
    const waiting: (() => void)[] = [];
    const sleeper: Sleeper = {
      sleep: (_ms, signal) =>
        new Promise<void>((resolve, reject) => {
          waiting.push(resolve);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const tick = async () => {
      waiting.shift()?.();
      // Let the renew query run.
      for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    };
    return { sleeper, tick, waiting };
  }

  it("renews each interval and reports a lost lease once", async () => {
    const me = handle();
    await tryAcquireLease(deps, me, timing.leaseTtlMs);
    const { sleeper, tick } = steppedSleeper();
    let lost = 0;
    const hb = startHeartbeat(deps, me, {
      ttlMs: timing.leaseTtlMs,
      intervalMs: timing.heartbeatMs,
      sleeper,
      onLost: () => (lost += 1),
    });
    deps.clock.advance(timing.heartbeatMs);
    await tick();
    const [s] = await deps.db.select().from(userTurnState);
    expect(s.leaseExpiresAt?.getTime()).toBe(deps.clock.now().getTime() + timing.leaseTtlMs);

    // Someone else takes over.
    await deps.db.update(userTurnState).set({ leaseOwner: randomUUID() }).where(eq(userTurnState.userId, userId));
    await tick();
    expect(lost).toBe(1);
    hb.stop();
  });

  it("stops cleanly without reporting a loss after release", async () => {
    const me = handle();
    await tryAcquireLease(deps, me, timing.leaseTtlMs);
    const { sleeper, tick, waiting } = steppedSleeper();
    let lost = 0;
    const hb = startHeartbeat(deps, me, {
      ttlMs: timing.leaseTtlMs,
      intervalMs: timing.heartbeatMs,
      sleeper,
      onLost: () => (lost += 1),
    });
    await tick();
    hb.stop();
    await releaseLease(deps, me);
    await tick();
    expect(lost).toBe(0);
    expect(waiting).toHaveLength(0);
  });
});
