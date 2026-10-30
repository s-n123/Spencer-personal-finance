import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Wrap aggregates so they come back as numbers on every driver: node-postgres returns
 * count/sum/numeric as strings, PGlite returns numbers.
 */
export function sqlNumber(expr: SQL | SQLWrapper): SQL<number> {
  return sql<number>`${expr}`.mapWith(Number);
}

export function countAll(): SQL<number> {
  return sql<number>`count(*)`.mapWith(Number);
}

/** Runs a raw query and returns its rows on any driver (pg and PGlite both expose `.rows`). */
export async function selectRows<T>(db: { execute: (q: SQL) => Promise<unknown> }, query: SQL): Promise<T[]> {
  const res = (await db.execute(query)) as { rows: T[] };
  return res.rows;
}
