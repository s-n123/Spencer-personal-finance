import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectRows } from "@/server/db/sql";
import { createTestDb, type TestDb } from "@/test/db";

// Schema conventions (CLAUDE.md): every user_id column has an FK to users with ON DELETE CASCADE
// and an index; reference FKs to media/turns/messages are SET NULL.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const SET_NULL_EXEMPT_USER_ID_TABLES = new Set<string>([]);

describe("schema conventions", () => {
  it("every user_id column cascades from users and is indexed", async () => {
    const cols = await selectRows<{ table_name: string }>(t.db, sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id'`);
    expect(cols.length).toBeGreaterThan(0);
    for (const { table_name } of cols) {
      const fk = await selectRows<{ confdeltype: string }>(t.db, sql`
        select c.confdeltype from pg_constraint c
        join pg_class r on r.oid = c.conrelid
        join pg_attribute a on a.attrelid = r.oid and a.attnum = any(c.conkey)
        where c.contype = 'f' and r.relname = ${table_name} and a.attname = 'user_id'`);
      const expected = SET_NULL_EXEMPT_USER_ID_TABLES.has(table_name) ? "n" : "c";
      expect(fk.map((r) => r.confdeltype), `${table_name}.user_id FK`).toEqual([expected]);
      const idx = await selectRows<{ indexdef: string }>(t.db, sql`
        select indexdef from pg_indexes where schemaname = 'public' and tablename = ${table_name}`);
      const indexed =
        idx.some((r) => /\(user_id[,)]/.test(r.indexdef)) || table_name === "user_turn_state";
      expect(indexed, `${table_name}.user_id index`).toBe(true);
    }
  });

  it("reference FKs (media_id, turn_id, *_message_id) are SET NULL and indexed", async () => {
    const fks = await selectRows<{ table_name: string; column_name: string; confdeltype: string }>(t.db, sql`
      select r.relname as table_name, a.attname as column_name, c.confdeltype
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_attribute a on a.attrelid = r.oid and a.attnum = any(c.conkey)
      where c.contype = 'f' and r.relnamespace = 'public'::regnamespace and a.attname <> 'user_id'`);
    for (const fk of fks) {
      expect(fk.confdeltype, `${fk.table_name}.${fk.column_name}`).toBe("n");
      const idx = await selectRows<{ indexdef: string }>(t.db, sql`
        select indexdef from pg_indexes where schemaname = 'public' and tablename = ${fk.table_name}`);
      const re = new RegExp(`\\(${fk.column_name}[,)]`);
      expect(idx.some((r) => re.test(r.indexdef)), `${fk.table_name}.${fk.column_name} index`).toBe(true);
    }
  });

  it("pg_trgm is installed", async () => {
    const r = await selectRows<{ s: number }>(t.db, sql`select similarity('chicken breast', 'chiken brest') as s`);
    expect(Number(r[0].s)).toBeGreaterThan(0.2);
  });
});
