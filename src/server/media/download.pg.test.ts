import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inboundMessages, media, users } from "@/server/db/schema";
import type { Deps } from "@/server/deps";
import { realSleeper } from "@/server/time";
import { makeTestDeps, type TestDeps } from "@/test/deps";
import { solidJpeg } from "@/test/fixtures/images";
import { createPgTestDb, type PgTestDb } from "@/test/pg";
import { ensureMedia, prefetchMedia } from "./download";

// Single-flight on real Postgres: concurrent claims run on separate pooled connections, which
// PGlite (one connection) cannot reproduce.

let t: PgTestDb;
let deps: TestDeps;
let userId: string;

beforeAll(async () => {
  t = await createPgTestDb({ poolSize: 10 });
  deps = makeTestDeps(t.db);
  const [u] = await t.db
    .insert(users)
    .values({ phoneE164: "+12015550102", provider: "simulator", status: "active", consentedAt: deps.clock.now() })
    .returning({ id: users.id });
  userId = u.id;
});
afterAll(async () => {
  await t?.close();
});

async function seed(): Promise<{ messageId: string; mediaId: string; calls: () => number; release: () => void }> {
  const [msg] = await t.db
    .insert(inboundMessages)
    .values({
      userId,
      provider: "simulator",
      providerMessageId: randomUUID(),
      sentAt: deps.clock.now(),
      receivedAt: deps.clock.now(),
    })
    .returning({ id: inboundMessages.id });
  const url = `https://media.simulator.invalid/${randomUUID()}`;
  deps.adapter.media.set(url, { bytes: await solidJpeg(48, 32), contentType: "image/jpeg" });
  const [row] = await t.db
    .insert(media)
    .values({ userId, inboundMessageId: msg.id, providerUrl: url })
    .returning({ id: media.id });

  // Every fetch waits until released, so all contenders are in flight at once.
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = deps.adapter.fetchMedia.bind(deps.adapter);
  deps.adapter.fetchMedia = async (u: string) => {
    calls++;
    await gate;
    return original(u);
  };
  return { messageId: msg.id, mediaId: row.id, calls: () => calls, release };
}

describe("media single-flight on Postgres", () => {
  it("eight concurrent prefetches download the row once", async () => {
    const s = await seed();
    const runs = Array.from({ length: 8 }, () => prefetchMedia(deps, [s.mediaId], new AbortController().signal));
    // Let every claim reach the database before the winner's download completes.
    while (s.calls() < 1) await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    s.release();
    await Promise.all(runs);

    expect(s.calls()).toBe(1);
    const [r] = await t.db.select().from(media).where(eq(media.id, s.mediaId));
    expect(r).toMatchObject({ status: "stored", attempts: 1, providerUrl: null });
    expect(deps.storage.objects.has(r.storageKey!)).toBe(true);
  });

  it("ensureMedia racing prefetches still downloads once and returns the image", async () => {
    const s = await seed();
    const prefetches = Array.from({ length: 4 }, () =>
      prefetchMedia(deps, [s.mediaId], new AbortController().signal),
    );
    // Real 500 ms polls: a fake sleeper would burn the 20 s budget in a few real milliseconds.
    const live: Deps = { ...deps, sleeper: realSleeper };
    const ensured = ensureMedia(live, [s.messageId], new AbortController().signal);
    while (s.calls() < 1) await new Promise<void>((r) => setImmediate(r));
    s.release();
    const [res] = await Promise.all([ensured, ...prefetches]);

    expect(s.calls()).toBe(1);
    expect(res.failed).toEqual([]);
    expect(res.ready.map((r) => [r.ref, r.mediaId, r.width, r.height])).toEqual([["img1", s.mediaId, 48, 32]]);
  });
});
