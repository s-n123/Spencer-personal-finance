import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "@/server/db/schema";
import { countAll, selectRows } from "@/server/db/sql";
import { createPgTestDb, type PgTestDb } from "@/test/pg";

// Driver parity on node-postgres: aggregates come back as numbers via sqlNumber/countAll.

let t: PgTestDb;
beforeAll(async () => {
  t = await createPgTestDb();
});
afterAll(async () => {
  await t?.close();
});

describe("node-postgres driver parity", () => {
  it("countAll() returns a number, raw count(*) returns a string", async () => {
    await t.db.insert(users).values({ phoneE164: "+12015550100", provider: "simulator" });
    const [{ n }] = await t.db.select({ n: countAll() }).from(users);
    expect(n).toBe(1);
    const raw = await selectRows<{ n: unknown }>(t.db, sql`select count(*) as n from users`);
    expect(typeof raw[0].n).toBe("string");
  });
});
