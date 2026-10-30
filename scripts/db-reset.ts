import "./_env";
import { rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import pg from "pg";
import { getEnv } from "../src/server/config/env";
import { isListening, isPgliteDevUrl, PGLITE_HOST, PGLITE_PORT, startPgliteServer, type DevDbServer } from "./db-dev";
import { runMigrations } from "./migrate";

// `npm run db:reset`: drops and recreates the public and drizzle schemas, re-runs every migration
// and removes the app's stored media from MEDIA_LOCAL_DIR. Refuses anything but a database on this
// machine.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLocal(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error("refusing to reset a non-local database (host must be 127.0.0.1, localhost or ::1)");
  }
}

/**
 * The top-level key prefixes the app writes: users/<id>/<media>.jpg (storage/types.ts) and the
 * simulator's sim-inbox/<upload> staging area. Only these are removed, never the whole directory,
 * so a mistyped MEDIA_LOCAL_DIR (say `src` or `.git`) can't take anything else with it.
 */
const MEDIA_KEY_ROOTS = ["users", "sim-inbox"];

/** Only ever deletes inside the project. */
function clearLocalMedia(dir: string): void {
  const abs = resolve(dir);
  const rel = relative(process.cwd(), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    console.warn(`db:reset: not clearing MEDIA_LOCAL_DIR outside the project (${dir})`);
    return;
  }
  for (const root of MEDIA_KEY_ROOTS) rmSync(join(abs, root), { recursive: true, force: true });
}

async function main(): Promise<void> {
  const env = getEnv();
  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  assertLocal(url);

  let server: DevDbServer | null = null;
  if (isPgliteDevUrl(url) && !(await isListening(PGLITE_HOST, PGLITE_PORT))) {
    server = await startPgliteServer();
  }
  try {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("drop schema if exists drizzle cascade");
      await client.query("drop schema if exists public cascade");
      await client.query("create schema public");
    } finally {
      await client.end();
    }
    await runMigrations(url);
  } finally {
    await server?.stop();
  }
  if (env.MEDIA_STORAGE === "local") clearLocalMedia(env.MEDIA_LOCAL_DIR);
  console.log("db:reset: schemas recreated, migrations applied, local media cleared");
}

main().catch((err: unknown) => {
  console.error(`db:reset: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
