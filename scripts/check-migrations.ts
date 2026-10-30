import "./_env";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// `npm run db:check` (D-015). drizzle-orm 0.45's migrator silently skips a migration whose journal
// timestamp is older than the last applied one, and an edited schema without a migration only
// fails at deploy time, so both are caught here:
//   1. the journal is well-formed: idx contiguous from 0, `when` strictly increasing, exactly one
//      .sql file per entry (and no stray .sql files);
//   2. `drizzle-kit check` passes;
//   3. `drizzle-kit generate` against a throwaway copy of drizzle/ reports "No schema changes".
// drizzle-kit can exit 0 after an error, so its output is checked, not just its exit code.

const MIGRATIONS = "drizzle";
const SCHEMA = "./src/server/db/schema/index.ts";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function checkJournal(dir: string): string[] {
  const problems: string[] = [];
  const journalPath = join(dir, "meta", "_journal.json");
  if (!existsSync(journalPath)) return [`missing ${journalPath}`];
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries?: JournalEntry[] };
  const entries = journal.entries ?? [];
  entries.forEach((entry, i) => {
    if (entry.idx !== i) problems.push(`journal entry ${i} has idx ${entry.idx} (must be contiguous from 0)`);
    const prev = entries[i - 1];
    if (prev && !(entry.when > prev.when)) {
      problems.push(
        `journal entry ${entry.tag} has when=${entry.when}, not after ${prev.tag} (${prev.when}); ` +
          "the migrator would silently skip it. Delete and regenerate your migration.",
      );
    }
    if (!existsSync(join(dir, `${entry.tag}.sql`))) problems.push(`journal entry ${entry.tag} has no ${entry.tag}.sql`);
  });
  const tags = new Set(entries.map((e) => e.tag));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    if (!tags.has(file.slice(0, -".sql".length))) problems.push(`${file} is not in the journal`);
  }
  return problems;
}

function drizzleKit(args: string[]): { status: number | null; output: string } {
  const r = spawnSync("npx", ["drizzle-kit", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // generate prompts on ambiguous renames; with stdin closed it must not hang CI.
    timeout: 120_000,
    shell: process.platform === "win32",
  });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function main(): number {
  const problems = checkJournal(MIGRATIONS);
  if (problems.length > 0) {
    for (const p of problems) console.error(`db:check: ${p}`);
    return 1;
  }

  const tmp = mkdtempSync(join(tmpdir(), "nc-dbcheck-"));
  try {
    const out = join(tmp, "drizzle");
    cpSync(MIGRATIONS, out, { recursive: true });
    const before = readdirSync(out).sort().join("\n");
    // drizzle-kit resolves `out` relative to the working directory, so it must be relative.
    const config = join(tmp, "drizzle.config.mjs");
    writeFileSync(
      config,
      `export default ${JSON.stringify({ dialect: "postgresql", schema: SCHEMA, out: relative(process.cwd(), out), casing: "snake_case" })};\n`,
    );

    const check = drizzleKit(["check", "--config", config]);
    if (check.status !== 0 || /error/i.test(check.output)) {
      console.error(`db:check: drizzle-kit check failed:\n${check.output}`);
      return 1;
    }

    const gen = drizzleKit(["generate", "--config", config]);
    const after = readdirSync(out).sort().join("\n");
    if (gen.status !== 0 || !gen.output.includes("No schema changes") || before !== after) {
      console.error(
        "db:check: the schema and the migrations differ. Run `npm run db:generate -- --name <change>` " +
          `and commit the migration.\n${gen.output}`,
      );
      return 1;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("db:check: journal ok, schema matches migrations");
  return 0;
}

process.exit(main());
