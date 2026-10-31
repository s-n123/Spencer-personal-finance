import "./_env";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { isMainModule } from "./_cli";

// Applies migrations over the unpooled URL under an advisory lock, then verifies that every
// journal entry was applied with a matching hash. drizzle-orm 0.45's migrator silently skips
// migrations whose journal timestamp is older than the last applied one; this check catches it.

const MIGRATIONS = "drizzle";
const LOCK_KEY = 727_001; // arbitrary, stable

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export async function runMigrations(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await verifyApplied(client);
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

async function verifyApplied(client: pg.Client): Promise<void> {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  const { rows } = await client.query<{ hash: string; created_at: string }>(
    'select hash, created_at from drizzle."__drizzle_migrations" order by created_at',
  );
  if (rows.length !== journal.entries.length) {
    throw new Error(
      `Migration count mismatch: journal has ${journal.entries.length}, database has ${rows.length}. ` +
        "A migration was probably skipped (out-of-order journal timestamp).",
    );
  }
  const applied = new Set(rows.map((r) => r.hash));
  for (const entry of journal.entries) {
    const sqlText = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
    const hash = createHash("sha256").update(sqlText).digest("hex");
    if (!applied.has(hash)) {
      throw new Error(`Migration ${entry.tag} is not applied with its current hash (edited after apply?)`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL (or DATABASE_URL_UNPOOLED) is required");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log("migrations: up to date"))
    .catch((err: unknown) => {
      console.error(`migrations failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
