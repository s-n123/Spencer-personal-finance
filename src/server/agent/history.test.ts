import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inboundMessages, media, outboundMessages, turns, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { loadHistory, mergeConsecutive, PHOTO_PLACEHOLDER } from "./history";

const PHONE = "+12015550103";
const T0 = new Date("2026-11-02T17:00:00.000Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

let t: TestDb;
let db: Db;
let userId: string;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(db);
  const [u] = await db
    .insert(users)
    .values({ phoneE164: PHONE, provider: "simulator", status: "active" })
    .returning({ id: users.id });
  userId = u.id;
});

async function turn(minute: number): Promise<string> {
  const [row] = await db
    .insert(turns)
    .values({ userId, clockAt: at(minute), startedAt: at(minute), status: "done" })
    .returning({ id: turns.id });
  return row.id;
}

async function inbound(
  turnId: string,
  minute: number,
  values: { text?: string | null; status?: string; crisisKind?: string | null; summary?: string | null; photo?: boolean },
): Promise<string> {
  const [row] = await db
    .insert(inboundMessages)
    .values({
      userId,
      provider: "simulator",
      providerMessageId: `sim-${++seq}`,
      text: values.text ?? null,
      crisisKind: values.crisisKind ?? null,
      sentAt: at(minute),
      receivedAt: at(minute),
      status: values.status ?? "done",
      turnId,
    })
    .returning({ id: inboundMessages.id });
  if (values.photo) {
    await db.insert(media).values({ userId, inboundMessageId: row.id, status: "stored", summary: values.summary ?? null });
  }
  return row.id;
}

async function outbound(
  turnId: string | null,
  text: string,
  values: { seq?: number; status?: string; kind?: string } = {},
): Promise<void> {
  await db.insert(outboundMessages).values({
    userId,
    turnId,
    kind: values.kind ?? "reply",
    seq: values.seq ?? 0,
    text,
    idempotencyKey: `out-${++seq}`,
    status: values.status ?? "sent",
  });
}

describe("loadHistory", () => {
  let current: string;
  let currentInbound: string;

  beforeEach(async () => {
    // T0: text purged by retention, reply sent -> a leading assistant message, which is dropped.
    const t0 = await turn(0);
    await inbound(t0, 0, { text: null });
    await outbound(t0, "old reply");
    // T1: plain exchange with a two-bubble reply (order by seq).
    const t1 = await turn(1);
    await inbound(t1, 1, { text: "hi" });
    await outbound(t1, "Send me a photo", { seq: 1 });
    await outbound(t1, "Hey!", { seq: 0 });
    // T2: photo with a summary, then its caption; the reply status is unknown (still counts).
    const t2 = await turn(2);
    await inbound(t2, 2, { photo: true, summary: "[photo 12:02]" });
    await inbound(t2, 2.1, { text: "lunch" });
    await outbound(t2, "Looks like a salad", { status: "unknown" });
    // T3: photo without a summary; the reply failed, so the user's turn has no answer.
    const t3 = await turn(3);
    await inbound(t3, 3, { photo: true });
    await outbound(t3, "never delivered", { status: "failed" });
    // T4: a crisis-tagged row and an ignored row are never replayed; a safety reply isn't either.
    const t4 = await turn(4);
    await inbound(t4, 4, { text: "anyone there?" });
    await inbound(t4, 4.1, { crisisKind: "self_harm" });
    await inbound(t4, 4.2, { text: "ignored text", status: "ignored" });
    await outbound(t4, "Yes!");
    await outbound(t4, "safety copy", { kind: "safety", seq: 1 });
    // Not tied to a turn (priority path): excluded.
    await outbound(null, "STOP confirmation", { kind: "priority" });
    // The current turn: its rows must never appear.
    current = await turn(5);
    currentInbound = await inbound(current, 5, { text: "this turn", status: "processing" });
    await outbound(current, "should not appear");
  });

  it("returns alternating text-only messages from earlier turns, oldest first", async () => {
    const history = await loadHistory(db, { userId, turnId: current, excludeInboundIds: [currentInbound] });
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hey!\n\nSend me a photo" },
      { role: "user", content: "[photo 12:02]\nlunch" },
      { role: "assistant", content: "Looks like a salad" },
      { role: "user", content: `${PHOTO_PLACEHOLDER}\nanyone there?` },
      { role: "assistant", content: "Yes!" },
    ]);
    for (const m of history) expect(typeof m.content).toBe("string");
    for (let i = 1; i < history.length; i++) expect(history[i].role).not.toBe(history[i - 1].role);
  });

  it("excludes the current turn even when its rows are already done", async () => {
    await db.update(inboundMessages).set({ status: "done" });
    const history = await loadHistory(db, { userId, turnId: current, excludeInboundIds: [currentInbound] });
    const all = history.map((m) => m.content).join("\n");
    expect(all).not.toContain("this turn");
    expect(all).not.toContain("should not appear");
  });

  it("limits to the last N exchanges", async () => {
    const history = await loadHistory(db, {
      userId,
      turnId: current,
      excludeInboundIds: [currentInbound],
      exchanges: 2,
    });
    expect(history).toEqual([
      { role: "user", content: `${PHOTO_PLACEHOLDER}\nanyone there?` },
      { role: "assistant", content: "Yes!" },
    ]);
  });

  it("is empty for a user with no earlier turns", async () => {
    const [other] = await db
      .insert(users)
      .values({ phoneE164: "+12015550104", provider: "simulator", status: "active" })
      .returning({ id: users.id });
    expect(await loadHistory(db, { userId: other.id, turnId: current, excludeInboundIds: [] })).toEqual([]);
  });
});

describe("loadHistory and refused turns", () => {
  async function turnWithMode(minute: number, mode: string, stopReason: string | null = "refusal"): Promise<string> {
    const [row] = await db
      .insert(turns)
      .values({ userId, clockAt: at(minute), startedAt: at(minute), status: "done", mode, stopReason })
      .returning({ id: turns.id });
    return row.id;
  }

  it.each([
    ["marked safety at commit", "safety", "refusal"],
    ["marked safety, any stop reason", "safety", null],
    // A turn closed under another mode (e.g. a recovery re-run) is still a refusal.
    ["closed as a recovery turn", "recovery", "refusal"],
  ])("leaves out a turn answered by the refusal copy (%s)", async (_name, mode, stopReason) => {
    const t1 = await turn(1);
    await inbound(t1, 1, { text: "hi" });
    await outbound(t1, "Hey!");
    const refused = await turnWithMode(2, mode, stopReason);
    await inbound(refused, 2, { text: "declined question" });
    // Refusal copy goes out as an ordinary reply (D-126).
    await outbound(refused, "refusal copy");
    const current = await turn(3);
    const currentInbound = await inbound(current, 3, { text: "next question", status: "processing" });

    const history = await loadHistory(db, { userId, turnId: current, excludeInboundIds: [currentInbound] });
    // Ends on the assistant, so nothing is folded into this turn as "unanswered".
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hey!" },
    ]);
  });

  it("does not spend an exchange slot on a refused turn", async () => {
    const t1 = await turn(1);
    await inbound(t1, 1, { text: "hi" });
    await outbound(t1, "Hey!");
    const refused = await turnWithMode(2, "safety");
    await inbound(refused, 2, { text: "declined question" });
    await outbound(refused, "refusal copy");
    const current = await turn(3);
    expect(await loadHistory(db, { userId, turnId: current, excludeInboundIds: [], exchanges: 1 })).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hey!" },
    ]);
  });
});

describe("mergeConsecutive", () => {
  it("merges same-role neighbours and drops leading assistant messages", () => {
    expect(
      mergeConsecutive([
        { role: "assistant", content: "a0" },
        { role: "user", content: "u1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a1" },
        { role: "assistant", content: "a2" },
      ]),
    ).toEqual([
      { role: "user", content: "u1\nu2" },
      { role: "assistant", content: "a1\n\na2" },
    ]);
  });
});
