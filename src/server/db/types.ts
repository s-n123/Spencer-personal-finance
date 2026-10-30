import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Driver-agnostic database handle. Production uses node-postgres, unit tests use PGlite; app code
 * is typed against the base PgDatabase so it runs on both. Transactions (`tx`) satisfy this type.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
