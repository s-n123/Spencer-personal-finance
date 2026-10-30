import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "@/server/db/schema";
import type { Db } from "@/server/db/types";

// Real-Postgres test database for the "pg" Vitest project (driver parity + race tests).
// Each call creates a fresh database on TEST_DATABASE_URL's server and drops it on close.

export interface PgTestDb {
  db: Db;
  pool: pg.Pool;
  url: string;
  close(): Promise<void>;
}

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set; run `npm run test:pg`, which starts a throwaway Postgres");
  }
  return url;
}

export async function createPgTestDb(opts: { poolSize?: number } = {}): Promise<PgTestDb> {
  const adminUrl = requireTestDatabaseUrl();
  const name = `nc_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: opts.poolSize ?? 10 });
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: "drizzle" });

  return {
    db: db as unknown as Db,
    pool,
    url: url.toString(),
    async close() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
