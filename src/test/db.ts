import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Db } from "@/server/db/types";

// Unit-test database: in-process PGlite (real Postgres compiled to WASM). A migrated snapshot is
// built once in globalSetup (PGLITE_SNAPSHOT) so each test file boots in well under a second.
// PGlite has a single connection: it cannot reproduce races; those live in *.pg.test.ts.

export interface TestDb {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const snapshot = process.env.PGLITE_SNAPSHOT;
  const client = snapshot
    ? new PGlite({ loadDataDir: new Blob([readFileSync(snapshot)]), extensions: { pg_trgm } })
    : new PGlite({ extensions: { pg_trgm } });
  const db = drizzle({ client, schema, casing: "snake_case" });
  if (!snapshot) {
    await migrate(db, { migrationsFolder: "drizzle" });
  }
  return { db: db as unknown as Db, client, close: () => client.close() };
}

/** Empties every app table (keeps the migrations table). */
export async function resetTestDb(db: Db): Promise<void> {
  const rows = await selectRows<{ tablename: string }>(
    db,
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = rows.map((r) => `"${r.tablename}"`);
  if (names.length > 0) {
    await db.execute(sql.raw(`truncate table ${names.join(", ")} restart identity cascade`));
  }
}

/** Builds a migrated snapshot tarball; used by the unit project's globalSetup. */
export async function buildSnapshot(): Promise<Blob> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle({ client, schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: "drizzle" });
  const dump = await client.dumpDataDir("none");
  await client.close();
  return dump;
}
