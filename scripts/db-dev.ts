import "./_env";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

// `npm run db:dev`: the zero-install dev database (D-016). PGlite (Postgres compiled to WASM)
// served over the Postgres wire protocol on 127.0.0.1:54330, persisted in .pglite/. It allows 8
// connections; the dev pool is capped at 4 so migrate, seed and studio can connect alongside.
// `npm run dev` starts the same server in-process when nothing is listening there yet.

export const PGLITE_HOST = "127.0.0.1";
export const PGLITE_PORT = 54330;
const DATA_DIR = ".pglite";
const MAX_CONNECTIONS = 8;

export interface DevDbServer {
  url: string;
  stop(): Promise<void>;
}

/** True if DATABASE_URL points at the PGlite dev server's address. */
export function isPgliteDevUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["127.0.0.1", "localhost"].includes(u.hostname) && u.port === String(PGLITE_PORT);
  } catch {
    return false;
  }
}

export function isListening(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function startPgliteServer(): Promise<DevDbServer> {
  const db = new PGlite(DATA_DIR, { extensions: { pg_trgm } });
  await db.waitReady;
  const server = new PGLiteSocketServer({ db, host: PGLITE_HOST, port: PGLITE_PORT, maxConnections: MAX_CONNECTIONS });
  try {
    await server.start();
  } catch (err) {
    await db.close();
    throw err;
  }
  let stopped = false;
  return {
    url: `postgresql://postgres:postgres@${PGLITE_HOST}:${PGLITE_PORT}/postgres`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop();
      // Closing flushes the data directory; skipping it can leave .pglite needing recovery.
      await db.close();
    },
  };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  (async () => {
    if (await isListening(PGLITE_HOST, PGLITE_PORT)) {
      console.error(`db:dev: something is already listening on ${PGLITE_HOST}:${PGLITE_PORT}`);
      process.exit(1);
    }
    const server = await startPgliteServer();
    console.log(`db:dev: PGlite listening at ${server.url} (data in ${DATA_DIR}/). Ctrl-C to stop.`);
    const shutdown = () => {
      server.stop().then(
        () => {
          console.log("db:dev: stopped");
          process.exit(0);
        },
        () => process.exit(1),
      );
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })().catch((err: unknown) => {
    console.error(`db:dev: failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
