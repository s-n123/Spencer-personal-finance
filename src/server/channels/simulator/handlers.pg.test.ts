import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "@/server/channels/registry";
import { outboundMessages, users } from "@/server/db/schema";
import type { Runner } from "@/server/pipeline/runner";
import { makeTestDeps, type TestDeps } from "@/test/deps";
import { createPgTestDb, type PgTestDb } from "@/test/pg";
import type { SimulatorAdapter } from "./adapter";
import { loadThread, postSimMessages, resetSimulator } from "./handlers";

// Driver parity on node-postgres for the simulator's raw-SQL paths: timestamps from coalesce() and
// max() come back as Date or string depending on the driver, and the reset uses a regex match.

const PHONE = "+12015550140";

let t: PgTestDb;
let deps: TestDeps;

beforeAll(async () => {
  t = await createPgTestDb();
  const runner: Runner = { run: () => undefined };
  deps = makeTestDeps(t.db, { runner });
  deps.adapters = createRegistry({ db: t.db, storage: deps.storage, clock: deps.clock });
});
afterAll(async () => {
  await t?.close();
});

describe("simulator handlers on node-postgres", () => {
  it("orders the thread, computes typing and resets by fictional-number pattern", async () => {
    const body = new FormData();
    body.set("phone", PHONE);
    body.set("text", "hello");
    const res = await postSimMessages(deps, new Request("http://localhost/x", { method: "POST", body }));
    expect(res.status).toBe(200);

    const [user] = await t.db.select().from(users).where(eq(users.phoneE164, PHONE));
    deps.clock.advance(500);
    await (deps.adapters.get("simulator") as SimulatorAdapter).startTyping(null, PHONE);
    let view = await loadThread(deps, PHONE);
    expect(view.typing).toBe(true);

    deps.clock.advance(500);
    await t.db.insert(outboundMessages).values({
      userId: user.id,
      kind: "reply",
      text: "hi there",
      idempotencyKey: `reply:${randomUUID()}:0`,
      status: "sent",
      sentAt: deps.clock.now(),
    });
    view = await loadThread(deps, PHONE);
    expect(view.typing).toBe(false);
    expect(view.items.map((i) => [i.dir, i.text])).toEqual([
      ["in", "hello"],
      ["out", "hi there"],
    ]);
    expect(view.items.every((i) => !Number.isNaN(Date.parse(i.at)))).toBe(true);

    expect(await resetSimulator(deps)).toEqual({ users: 1, blobs: 0 });
    expect(await t.db.select().from(users)).toHaveLength(0);
  });
});
