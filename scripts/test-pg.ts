import "./_env";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the "pg" Vitest project (node-postgres parity + race tests) against real Postgres.
// If TEST_DATABASE_URL is set (CI service container, or your own server) it is used as-is.
// Otherwise a throwaway cluster is started from local Postgres binaries and removed afterwards.

const extraArgs = process.argv.slice(2);

function findPgBin(): string | null {
  const candidates = [
    process.env.PG_BIN,
    "/usr/lib/postgresql/18/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl"))) return dir;
  }
  const which = spawnSync("sh", ["-c", "command -v initdb"], { encoding: "utf8" });
  const found = which.stdout.trim();
  return found ? found.replace(/\/initdb$/, "") : null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function runVitest(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["vitest", "run", "--project", "pg", ...extraArgs], {
      stdio: "inherit",
      env: { ...env, TZ: "Pacific/Chatham" },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  if (process.env.TEST_DATABASE_URL) {
    return runVitest(process.env);
  }
  const bin = findPgBin();
  if (!bin) {
    console.error(
      "No Postgres binaries found. Install Postgres (initdb, pg_ctl) or set TEST_DATABASE_URL to a server you can create databases on.",
    );
    return 1;
  }
  const isRoot = process.getuid?.() === 0;
  // initdb refuses to run as root; in containers run the cluster as the postgres user.
  const asUser = (cmd: string[]): string[] => (isRoot ? ["runuser", "-u", "postgres", "--", ...cmd] : cmd);

  const dir = mkdtempSync(join(tmpdir(), "nc-pg-"));
  chmodSync(dir, 0o777);
  const data = join(dir, "data");
  const port = await freePort();
  const run = (cmd: string[]) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr || r.stdout}`);
  };
  try {
    run(asUser([join(bin, "initdb"), "-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]));
    run(
      asUser([
        join(bin, "pg_ctl"),
        "-D",
        data,
        "-o",
        `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`,
        "-l",
        join(dir, "pg.log"),
        "-w",
        "start",
      ]),
    );
    const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    return await runVitest({ ...process.env, TEST_DATABASE_URL: url });
  } finally {
    spawnSync(asUser([join(bin, "pg_ctl"), "-D", data, "-m", "immediate", "stop"])[0], asUser([join(bin, "pg_ctl"), "-D", data, "-m", "immediate", "stop"]).slice(1));
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
