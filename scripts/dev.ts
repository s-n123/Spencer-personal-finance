import "./_env";
import { spawn } from "node:child_process";
import { getEnv } from "../src/server/config/env";
import { nextDevArgs } from "./_cli";
import { isListening, isPgliteDevUrl, PGLITE_HOST, PGLITE_PORT, startPgliteServer, type DevDbServer } from "./db-dev";
import { runMigrations } from "./migrate";

// `npm run dev`: env (.env.local via _env.ts) -> the PGlite dev server, started in this process if
// DATABASE_URL points at it and nothing is listening yet -> migrations -> `next dev`. Ctrl-C stops
// Next first, then closes PGlite cleanly so its data directory is never left mid-write.
// Extra arguments go to `next dev` (npm run dev -- --port 3001). It listens on 127.0.0.1 unless
// they set a host (npm run dev -- -H 0.0.0.0 to reach it from another device).

const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
  const env = getEnv();
  let db: DevDbServer | null = null;
  if (isPgliteDevUrl(env.DATABASE_URL) && !(await isListening(PGLITE_HOST, PGLITE_PORT))) {
    db = await startPgliteServer();
    console.log(`dev: started PGlite on ${PGLITE_HOST}:${PGLITE_PORT} (data in .pglite/)`);
  }

  try {
    await runMigrations(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL);
    console.log("dev: migrations up to date");
  } catch (err) {
    await db?.stop();
    throw err;
  }

  const next = spawn("npx", nextDevArgs(process.argv.slice(2)), {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  let stopping = false;
  const finish = async (code: number) => {
    await db?.stop().catch((err: unknown) => {
      console.error(`dev: PGlite did not close cleanly: ${err instanceof Error ? err.message : String(err)}`);
    });
    process.exit(code);
  };

  next.once("exit", (code, signal) => {
    void finish(stopping || signal ? 0 : (code ?? 1));
  });

  // The terminal sends SIGINT to the whole process group, so Next receives it too; forward it in
  // case it doesn't, and force-kill if it hangs.
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (next.exitCode === null) next.kill(signal);
    setTimeout(() => {
      if (next.exitCode === null) next.kill("SIGKILL");
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(`dev: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
