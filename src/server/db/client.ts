import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "@/server/config/env";
import { logError } from "@/server/errors";
import * as schema from "./schema";
import type { Db } from "./types";

// One pool per process. In dev it lives on globalThis so HMR doesn't leak pools, and stays below
// the PGlite socket server's 8 connections. A connect timeout keeps a saturated pool from hanging
// webhooks past the provider's timeout (ingest returns 503 instead and the provider redelivers).

type Holder = { pool?: Pool; db?: Db };
const holder: Holder = ((globalThis as { __nutritionCoachDb?: Holder }).__nutritionCoachDb ??= {});

export function createPool(connectionString: string, max: number): Pool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
  });
  pool.on("error", (err) => logError("db.pool_error", err));
  return pool;
}

export function getDb(): Db {
  if (holder.db) return holder.db;
  const env = getEnv();
  const pool = createPool(env.DATABASE_URL, env.NODE_ENV === "production" ? 10 : 4);
  // Keeps the Fluid instance alive long enough to release idle clients (no-op outside Vercel).
  attachDatabasePool(pool);
  holder.pool = pool;
  holder.db = drizzle({ client: pool, schema, casing: "snake_case" }) as unknown as Db;
  return holder.db;
}

export async function closeDb(): Promise<void> {
  const pool = holder.pool;
  holder.pool = undefined;
  holder.db = undefined;
  await pool?.end();
}
