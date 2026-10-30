import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRegistry } from "@/server/channels/registry";
import { simulatorEvents, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { FakeClock } from "@/test/clock";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { MemoryStorage } from "@/test/memory-storage";
import { SIM_INBOX_CONTENT_TYPE, SimulatorAdapter, simInboxKey, simInboxUrl } from "./adapter";

const PHONE = "+12015550110";

let t: TestDb;
let storage: MemoryStorage;
let clock: FakeClock;
let adapter: SimulatorAdapter;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
  storage = new MemoryStorage();
  clock = new FakeClock("2026-11-02T17:30:00.000Z");
  adapter = new SimulatorAdapter(t.db, storage, clock);
});

const live = () => new AbortController().signal;

describe("SimulatorAdapter.fetchMedia", () => {
  it("reads the staged upload from sim-inbox/<uuid>", async () => {
    const id = randomUUID();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await storage.put(simInboxKey(id), bytes, SIM_INBOX_CONTENT_TYPE);
    const got = await adapter.fetchMedia(simInboxUrl(id), live());
    expect(Array.from(got.bytes)).toEqual(Array.from(bytes));
    // The staging key has no extension, so no type is claimed; the pipeline sniffs the bytes.
    expect(got.contentType).toBeNull();
  });

  it.each([
    ["a path traversal", "sim-inbox:../../etc/passwd"],
    ["a non-uuid id", "sim-inbox:not-a-uuid"],
    ["an uppercase uuid", `sim-inbox:${randomUUID().toUpperCase()}`],
    ["a trailing segment", `sim-inbox:${randomUUID()}/x`],
    ["a provider URL", "https://example.com/photo.jpg"],
    ["a bare storage key", `sim-inbox/${randomUUID()}`],
  ])("rejects %s", async (_label, url) => {
    await expect(adapter.fetchMedia(url, live())).rejects.toMatchObject({ errorCode: "sim_media_bad_url" });
  });

  it("reports a missing upload without echoing the key", async () => {
    const err = await adapter.fetchMedia(simInboxUrl(randomUUID()), live()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).errorCode).toBe("sim_media_not_found");
    expect((err as AppError).message).not.toContain("sim-inbox");
  });

  it("honours an aborted signal", async () => {
    const id = randomUUID();
    await storage.put(simInboxKey(id), new Uint8Array([1]), SIM_INBOX_CONTENT_TYPE);
    const ctrl = new AbortController();
    ctrl.abort(new Error("turn aborted"));
    await expect(adapter.fetchMedia(simInboxUrl(id), ctrl.signal)).rejects.toThrow("turn aborted");
  });
});

describe("SimulatorAdapter sends and typing", () => {
  it("sendText reports sent with a fresh provider id and needs no transport", async () => {
    const a = await adapter.sendText(null, PHONE, "hi", { idempotencyKey: "k1", signal: live() });
    const b = await adapter.sendText(null, PHONE, "hi", { idempotencyKey: "k2", signal: live() });
    expect(a.status).toBe("sent");
    expect(a.providerMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.providerMessageId).not.toBe(a.providerMessageId);
  });

  it("sendText throws on an aborted signal (the sender records it as unknown)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(adapter.sendText(null, PHONE, "hi", { idempotencyKey: "k", signal: ctrl.signal })).rejects.toThrow();
  });

  it("startTyping and stopTyping write simulator_events at the injected clock's time", async () => {
    const [user] = await t.db.insert(users).values({ phoneE164: PHONE, provider: "simulator" }).returning();
    await adapter.startTyping(null, PHONE);
    clock.advance(2_000);
    await adapter.stopTyping(null, PHONE);
    const rows = await t.db
      .select()
      .from(simulatorEvents)
      .where(eq(simulatorEvents.userId, user.id))
      .orderBy(asc(simulatorEvents.createdAt));
    expect(rows.map((r) => r.type)).toEqual(["typing_start", "typing_stop"]);
    expect(rows[0].createdAt.toISOString()).toBe("2026-11-02T17:30:00.000Z");
    expect(rows[1].createdAt.toISOString()).toBe("2026-11-02T17:30:02.000Z");
  });

  it("typing for an unknown or non-simulator number writes nothing", async () => {
    await t.db.insert(users).values({ phoneE164: "+12015550111", provider: "sendblue" });
    await adapter.startTyping(null, "+12015550111");
    await adapter.startTyping(null, "+12015550112");
    expect(await t.db.select().from(simulatorEvents)).toHaveLength(0);
  });

  it("has no webhook surface", async () => {
    expect(await adapter.verify()).toBe(true);
    expect(adapter.parse()).toEqual([]);
  });
});

describe("createRegistry", () => {
  it("serves the simulator and refuses providers that are not wired yet", () => {
    const registry = createRegistry({ db: t.db, storage, clock });
    expect(registry.get("simulator")).toBeInstanceOf(SimulatorAdapter);
    expect(() => registry.get("sendblue")).toThrow(AppError);
  });
});
