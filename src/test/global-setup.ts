import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot } from "./db";

// Builds one migrated PGlite snapshot per unit-test run; workers load it via PGLITE_SNAPSHOT.
export default async function setup(): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "nc-pglite-"));
  const file = join(dir, "snapshot.tar");
  const blob = await buildSnapshot();
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  process.env.PGLITE_SNAPSHOT = file;
  return () => rmSync(dir, { recursive: true, force: true });
}
