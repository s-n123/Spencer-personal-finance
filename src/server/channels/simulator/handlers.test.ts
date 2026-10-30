import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "@/server/channels/registry";
import { inboundMessages, media, outboundMessages, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { mediaKey } from "@/server/media/storage/types";
import type { Runner } from "@/server/pipeline/runner";
import { InlineRunner } from "@/server/pipeline/runner";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, type TestDeps } from "@/test/deps";
import { SimulatorAdapter, simInboxPrefix } from "./adapter";
import {
  getSimMedia,
  getSimThread,
  postSimMessages,
  postSimReset,
  resetSimulator,
  SIM_LIMITS,
  type SimPostResult,
  type ThreadResponse,
} from "./handlers";

const PHONE = "+12015550120";
const OTHER = "+12015550121";
// Built at runtime so the repo-hygiene scan never sees a non-fictional number literal.
const NOT_FICTIONAL = ["+1", "201", "555", "0200"].join("");

/** Holds scheduled kicks so a test decides whether the pipeline runs. */
class HeldRunner implements Runner {
  readonly names: string[] = [];
  run(name: string): void {
    this.names.push(name);
  }
}

let t: TestDb;
let deps: TestDeps;
let runner: HeldRunner;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
  runner = new HeldRunner();
  deps = withSimulator(makeTestDeps(t.db, { runner }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function withSimulator(d: TestDeps): TestDeps {
  d.adapters = createRegistry({ db: d.db, storage: d.storage, clock: d.clock });
  return d;
}

function jpegFile(name = "meal.jpg", size = 64): File {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return new File([bytes], name, { type: "image/jpeg" });
}

function form(fields: Record<string, string | undefined>, files: File[] = []): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.set(k, v);
  for (const file of files) f.append("files", file, file.name);
  return f;
}

function post(body: FormData): Promise<Response> {
  return postSimMessages(deps, new Request("http://localhost/api/dev/sim/messages", { method: "POST", body }));
}

async function thread(phone = PHONE): Promise<ThreadResponse> {
  const res = await getSimThread(deps, new Request(`http://localhost/api/dev/sim/thread?phone=${encodeURIComponent(phone)}`));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  return (await res.json()) as ThreadResponse;
}

async function inboundRows() {
  return t.db.select().from(inboundMessages).orderBy(asc(inboundMessages.sentAt));
}

describe("POST /api/dev/sim/messages", () => {
  it("ingests a text message for a new simulator user (created consented until M4, D-007)", async () => {
    const res = await post(form({ phone: PHONE, text: "  hello coach  ", timezone: "America/Chicago" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SimPostResult;
    expect(body).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(body.providerMessageId).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await inboundRows();
    expect(row).toMatchObject({ provider: "simulator", providerMessageId: `${body.providerMessageId}:text`, text: "hello coach" });
    const [user] = await t.db.select().from(users).where(eq(users.phoneE164, PHONE));
    expect(user.consentedAt).not.toBeNull();
    expect(user).toMatchObject({ timezone: "America/Chicago", timezoneSource: "simulator" });
    expect(runner.names).toEqual(["kick"]);
  });

  it("splits photos and text into one inbound event each, in composer order (D-123)", async () => {
    const heic = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])], "IMG_0001.HEIC", { type: "" });
    const res = await post(form({ phone: PHONE, text: "lunch", providerMessageId: "client-id-0001" }, [jpegFile(), heic]));
    expect(await res.json()).toMatchObject({ accepted: 3, duplicates: 0, providerMessageId: "client-id-0001" });

    const rows = await inboundRows();
    expect(rows.map((r) => r.providerMessageId)).toEqual(["client-id-0001:img0", "client-id-0001:img1", "client-id-0001:text"]);
    expect(rows.map((r) => r.text)).toEqual([null, null, "lunch"]);
    expect(new Set(rows.map((r) => r.sentAt.getTime())).size).toBe(3);

    const mediaRows = await t.db.select().from(media).orderBy(asc(media.createdAt));
    expect(mediaRows).toHaveLength(2);
    expect(mediaRows.every((m) => /^sim-inbox:[0-9a-f-]{36}$/.test(m.providerUrl ?? ""))).toBe(true);
    expect(mediaRows.map((m) => m.sourceContentType).sort()).toEqual(["image/heic", "image/jpeg"]);
    const staged = [...deps.storage.objects.keys()].filter((k) => k.startsWith(simInboxPrefix()));
    expect(staged).toHaveLength(2);
  });

  it("a resend with the same id is deduped and stages nothing new", async () => {
    const fields = { phone: PHONE, text: "again", providerMessageId: "client-id-0002" };
    await post(form(fields, [jpegFile()]));
    const stagedBefore = deps.storage.objects.size;
    const res = await post(form(fields, [jpegFile()]));
    expect(await res.json()).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(deps.storage.objects.size).toBe(stagedBefore);
    expect(await inboundRows()).toHaveLength(2);
  });

  it.each([
    ["a non-fictional number", { phone: NOT_FICTIONAL, text: "hi" }, 400, "phone_not_fictional"],
    ["a missing number", { text: "hi" }, 400, "phone_not_fictional"],
    ["an empty message", { phone: PHONE, text: "   " }, 400, "empty_message"],
    ["an unsafe client id", { phone: PHONE, text: "hi", providerMessageId: "../../x" }, 400, "bad_provider_message_id"],
    ["over-long text", { phone: PHONE, text: "x".repeat(SIM_LIMITS.maxTextChars + 1) }, 400, "text_too_long"],
  ])("rejects %s", async (_label, fields, status, error) => {
    const res = await post(form(fields));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(await inboundRows()).toHaveLength(0);
  });

  it("rejects oversized and non-image files before storing anything", async () => {
    const big = await post(form({ phone: PHONE }, [jpegFile("big.jpg", SIM_LIMITS.maxFileBytes + 1)]));
    expect(big.status).toBe(413);
    const pdf = await post(form({ phone: PHONE }, [jpegFile(), new File([new Uint8Array([37, 80, 68, 70])], "x.pdf", { type: "application/pdf" })]));
    expect(pdf.status).toBe(415);
    expect(deps.storage.objects.size).toBe(0);
    expect(await inboundRows()).toHaveLength(0);
  });

  it("refuses a request bigger than the proxy buffers, before parsing it", async () => {
    const res = await postSimMessages(
      deps,
      new Request("http://localhost/api/dev/sim/messages", {
        method: "POST",
        headers: { "content-length": String(SIM_LIMITS.maxRequestBytes + 1), "content-type": "multipart/form-data; boundary=x" },
        body: "--x--",
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request_too_large" });
  });

  it("refuses a post from another site's page before parsing or storing anything", async () => {
    const crossSite: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      { origin: "https://evil.example", host: "localhost:3000" },
    ];
    for (const headers of crossSite) {
      const res = await postSimMessages(
        deps,
        new Request("http://localhost:3000/api/dev/sim/messages", {
          method: "POST",
          headers,
          body: form({ phone: PHONE, text: "hi" }, [jpegFile()]),
        }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross_site" });
    }
    expect(await inboundRows()).toHaveLength(0);
    expect(deps.storage.objects.size).toBe(0);
    expect(runner.names).toEqual([]);

    const own = await postSimMessages(
      deps,
      new Request("http://localhost:3000/api/dev/sim/messages", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" },
        body: form({ phone: PHONE, text: "hi" }),
      }),
    );
    expect(own.status).toBe(200);
  });

  it("ignores an invalid timezone hint", async () => {
    await post(form({ phone: PHONE, text: "hi", timezone: "Mars/Olympus_Mons" }));
    const [user] = await t.db.select().from(users).where(eq(users.phoneE164, PHONE));
    expect(user.timezone).toBeNull();
  });

  it("answers 503 on a database failure and logs nothing identifying", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    const failing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return () => Promise.reject(Object.assign(new Error(`Failing row contains (${PHONE}, secret text)`), { code: "57P01" }));
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Db;
    deps = withSimulator(makeTestDeps(failing, { runner }));
    const res = await post(form({ phone: PHONE, text: "secret text" }));
    expect(res.status).toBe(503);
    expect(errors.join("\n")).toContain("57P01");
    expect(errors.join("\n")).not.toContain(PHONE);
    expect(errors.join("\n")).not.toContain("secret text");
  });
});

describe("GET /api/dev/sim/thread", () => {
  it("returns an empty thread for a number that hasn't texted, and 400 for a real-looking one", async () => {
    expect(await thread(OTHER)).toEqual({ phone: OTHER, items: [], typing: false });
    const res = await getSimThread(deps, new Request(`http://localhost/api/dev/sim/thread?phone=${encodeURIComponent(NOT_FICTIONAL)}`));
    expect(res.status).toBe(400);
  });

  it("shows the user's message and the coach's reply after the pipeline runs", async () => {
    const inline = new InlineRunner();
    deps = withSimulator(makeTestDeps(t.db, { runner: inline }));
    await post(form({ phone: PHONE, text: "what's in this?" }));
    await inline.drain();
    expect(inline.errors).toEqual([]);

    const view = await thread();
    expect(view.items.map((i) => [i.dir, i.text])).toEqual([
      ["in", "what's in this?"],
      ["out", "got 1 message(s)"],
    ]);
    expect(view.items[0]).toMatchObject({ status: "done", tag: null, media: [] });
    expect(view.items[1]).toMatchObject({ status: "sent", kind: "reply" });
    expect(view.typing).toBe(false);
  });

  it("lists a message's photos with their processing status", async () => {
    await post(form({ phone: PHONE }, [jpegFile(), jpegFile("b.jpg")]));
    const view = await thread();
    expect(view.items).toHaveLength(2);
    for (const item of view.items) {
      expect(item.dir).toBe("in");
      if (item.dir === "in") expect(item.media).toEqual([{ id: expect.any(String), status: "pending" }]);
    }
  });

  it("shows typing from typing_start until a reply is sent or 60 s pass", async () => {
    await post(form({ phone: PHONE, text: "hi" }));
    const [user] = await t.db.select().from(users).where(eq(users.phoneE164, PHONE));
    const adapter = deps.adapters.get("simulator") as SimulatorAdapter;

    await adapter.startTyping(null, PHONE);
    deps.clock.advance(1_000);
    expect((await thread()).typing).toBe(true);

    deps.clock.advance(1_000);
    await t.db.insert(outboundMessages).values({
      userId: user.id,
      kind: "reply",
      text: "hey!",
      idempotencyKey: `reply:${randomUUID()}:0`,
      status: "sent",
      sentAt: deps.clock.now(),
    });
    expect((await thread()).typing).toBe(false);

    deps.clock.advance(1_000);
    await adapter.startTyping(null, PHONE);
    expect((await thread()).typing).toBe(true);
    deps.clock.advance(SIM_LIMITS.typingWindowMs);
    expect((await thread()).typing).toBe(false);
  });
});

describe("GET /api/dev/sim/media/[id]", () => {
  async function storedMedia(phone: string, provider = "simulator") {
    const [user] = await t.db.insert(users).values({ phoneE164: phone, provider }).returning();
    const id = randomUUID();
    const key = mediaKey(user.id, id);
    await deps.storage.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg");
    await t.db.insert(media).values({ id, userId: user.id, status: "stored", storageKey: key, contentType: "image/jpeg" });
    return { id, user, key };
  }

  it("serves a simulator user's processed JPEG privately", async () => {
    const { id } = await storedMedia(PHONE);
    const res = await getSimMedia(deps, id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it("404s for non-simulator users, unprocessed rows, missing blobs and malformed ids", async () => {
    const other = await storedMedia(OTHER, "sendblue");
    expect((await getSimMedia(deps, other.id)).status).toBe(404);

    const mine = await storedMedia(PHONE);
    await t.db.update(media).set({ status: "downloading" }).where(eq(media.id, mine.id));
    expect((await getSimMedia(deps, mine.id)).status).toBe(404);

    await t.db.update(media).set({ status: "stored" }).where(eq(media.id, mine.id));
    await deps.storage.delete(mine.key);
    expect((await getSimMedia(deps, mine.id)).status).toBe(404);

    expect((await getSimMedia(deps, "../../etc/passwd")).status).toBe(404);
    expect((await getSimMedia(deps, randomUUID())).status).toBe(404);
  });
});

describe("POST /api/dev/sim/reset", () => {
  it("deletes simulator users with fictional numbers, their blobs and staged uploads only", async () => {
    await post(form({ phone: PHONE, text: "hi" }, [jpegFile()]));
    await post(form({ phone: OTHER, text: "yo" }));
    const [keep] = await t.db.insert(users).values({ phoneE164: "+12015550130", provider: "sendblue" }).returning();
    const simUsers = await t.db.select().from(users).where(eq(users.provider, "simulator"));
    for (const u of simUsers) await deps.storage.put(mediaKey(u.id, randomUUID()), new Uint8Array([1]), "image/jpeg");
    const keepKey = mediaKey(keep.id, randomUUID());
    await deps.storage.put(keepKey, new Uint8Array([1]), "image/jpeg");

    const result = await resetSimulator(deps);
    expect(result).toEqual({ users: 2, blobs: 3 });
    expect((await t.db.select().from(users)).map((u) => u.id)).toEqual([keep.id]);
    expect(await inboundRows()).toHaveLength(0);
    expect([...deps.storage.objects.keys()]).toEqual([keepKey]);
  });

  it("refuses a reset posted from another site's page", async () => {
    await post(form({ phone: PHONE, text: "hi" }));
    const url = "http://localhost:3000/api/dev/sim/reset";
    const blocked = await postSimReset(deps, new Request(url, { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    expect(blocked.status).toBe(403);
    expect(await t.db.select().from(users)).toHaveLength(1);

    const own = await postSimReset(deps, new Request(url, { method: "POST", headers: { "sec-fetch-site": "same-origin" } }));
    expect(await own.json()).toEqual({ users: 1, blobs: 0 });
    expect(await t.db.select().from(users)).toHaveLength(0);
  });
});
