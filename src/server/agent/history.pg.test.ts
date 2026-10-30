import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inboundMessages, media, outboundMessages, turns, users } from "@/server/db/schema";
import { createPgTestDb, type PgTestDb } from "@/test/pg";
import { loadHistory } from "./history";

// Driver parity for the history query on node-postgres (correlated EXISTS, uuid IN lists, ordering).

let t: PgTestDb;
beforeAll(async () => {
  t = await createPgTestDb({ poolSize: 2 });
});
afterAll(async () => {
  await t?.close();
});

describe("loadHistory on node-postgres", () => {
  it("returns the same alternating text-only history as on PGlite", async () => {
    const db = t.db;
    const [u] = await db
      .insert(users)
      .values({ phoneE164: "+12015550107", provider: "simulator", status: "active" })
      .returning({ id: users.id });
    const at = (m: number) => new Date(Date.UTC(2026, 10, 2, 17, m));
    const mkTurn = async (m: number) =>
      (await db.insert(turns).values({ userId: u.id, clockAt: at(m), startedAt: at(m) }).returning({ id: turns.id }))[0].id;

    const t1 = await mkTurn(1);
    const [p] = await db
      .insert(inboundMessages)
      .values({ userId: u.id, provider: "simulator", providerMessageId: "pg-1", sentAt: at(1), receivedAt: at(1), status: "done", turnId: t1 })
      .returning({ id: inboundMessages.id });
    await db.insert(media).values({ userId: u.id, inboundMessageId: p.id, status: "stored", summary: "[photo 12:01]" });
    await db.insert(inboundMessages).values({
      userId: u.id,
      provider: "simulator",
      providerMessageId: "pg-2",
      text: "dinner",
      sentAt: at(1),
      receivedAt: at(1),
      status: "done",
      turnId: t1,
    });
    await db.insert(outboundMessages).values([
      { userId: u.id, turnId: t1, kind: "reply", seq: 1, text: "Enjoy!", idempotencyKey: "pg:r:1", status: "sent" },
      { userId: u.id, turnId: t1, kind: "reply", seq: 0, text: "Looks tasty.", idempotencyKey: "pg:r:0", status: "sent" },
    ]);
    // A refused turn (safety copy only) is left out whole: no unanswered user message at the end.
    const refused = (
      await db
        .insert(turns)
        .values({ userId: u.id, clockAt: at(2), startedAt: at(2), mode: "safety" })
        .returning({ id: turns.id })
    )[0].id;
    await db.insert(inboundMessages).values({
      userId: u.id,
      provider: "simulator",
      providerMessageId: "pg-3",
      text: "declined question",
      sentAt: at(2),
      receivedAt: at(2),
      status: "done",
      turnId: refused,
    });
    await db
      .insert(outboundMessages)
      .values({ userId: u.id, turnId: refused, kind: "safety", text: "refusal copy", idempotencyKey: "pg:s:0", status: "sent" });
    const current = await mkTurn(3);

    expect(await loadHistory(db, { userId: u.id, turnId: current, excludeInboundIds: [] })).toEqual([
      { role: "user", content: "[photo 12:01]\ndinner" },
      { role: "assistant", content: "Looks tasty.\n\nEnjoy!" },
    ]);
  });
});
