import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Small helpers shared by the scripts. No side effects on import, so tests can load them.

/**
 * True when `metaUrl` (import.meta.url) is the file node was started with. Compares paths, not
 * URLs: import.meta.url is percent-encoded (spaces, non-ASCII) and uses file:///C:/ on Windows.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  return argv1 !== undefined && fileURLToPath(metaUrl) === resolve(argv1);
}

/** Where `npm run dev` listens unless the caller passes -H/--hostname (next dev's own default is 0.0.0.0). */
export const DEV_HOST = "127.0.0.1";

/**
 * `next dev` arguments: loopback by default, so the simulator (threads, photos, the API key, db
 * reset) isn't reachable from the LAN. `npm run dev -- -H 0.0.0.0` opts in; next.config.ts allows
 * this machine's LAN addresses as dev origins, so the page hydrates at http://<LAN IP>:3000.
 */
export function nextDevArgs(extra: string[]): string[] {
  const hasHost = extra.some((a) => a.startsWith("-H") || a === "--hostname" || a.startsWith("--hostname="));
  return ["next", "dev", ...(hasHost ? [] : ["-H", DEV_HOST]), ...extra];
}
