import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_HOST, isMainModule, nextDevArgs } from "./_cli";

// The try-it tooling: scripts, package.json and the configs read by next and drizzle-kit.

const ROOT = fileURLToPath(new URL("..", import.meta.url));

afterEach(() => {
  vi.doUnmock("@next/env");
  vi.doUnmock("node:os");
  vi.resetModules();
});

describe("isMainModule", () => {
  it.each(["/home/me/sp ace/ci/scripts/migrate.ts", "/home/me/repo-ü/scripts/migrate.ts"])(
    "matches the started script even when its URL is percent-encoded (%s)",
    (path) => {
      expect(isMainModule(pathToFileURL(path).href, path)).toBe(true);
    },
  );

  it("is false for another script or when there is no argv[1]", () => {
    expect(isMainModule(pathToFileURL("/repo/scripts/migrate.ts").href, "/repo/scripts/dev.ts")).toBe(false);
    expect(isMainModule(pathToFileURL("/repo/scripts/migrate.ts").href, undefined)).toBe(false);
  });

  it("no script compares import.meta.url with a hand-built file:// URL", () => {
    const scripts = readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const naive = scripts.filter((f) =>
      /import\.meta\.url\s*===\s*`file:/.test(readFileSync(join(ROOT, "scripts", f), "utf8")),
    );
    expect(naive).toEqual([]);
  });
});

describe("nextDevArgs", () => {
  it("listens on loopback by default, so the simulator isn't on the LAN", () => {
    expect(nextDevArgs(["--port", "3001"])).toEqual(["next", "dev", "-H", DEV_HOST, "--port", "3001"]);
    expect(DEV_HOST).toBe("127.0.0.1");
  });

  it.each([[["-H", "0.0.0.0"]], [["--hostname", "0.0.0.0"]], [["--hostname=0.0.0.0"]], [["-H0.0.0.0"]]])(
    "keeps a host the caller chose (%j)",
    (args) => {
      expect(nextDevArgs(args)).toEqual(["next", "dev", ...args]);
    },
  );
});

describe("package.json", () => {
  it("every scripts/*.ts a script runs exists", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const missing = Object.entries(pkg.scripts).flatMap(([name, cmd]) =>
      [...cmd.matchAll(/scripts\/[\w.-]+\.ts/g)]
        .map((m) => m[0])
        .filter((file) => !existsSync(join(ROOT, file)))
        .map((file) => `${name}: ${file}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("next.config", () => {
  it("hides the dev indicator, which covers the simulator's attach button at phone width", async () => {
    const { default: config } = await import("../next.config");
    expect(config.devIndicators).toBe(false);
  });

  it("allows this machine's LAN addresses as dev origins, so the documented -H 0.0.0.0 hydrates on a phone", async () => {
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      networkInterfaces: () => ({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [
          { address: "192.0.2.20", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
      }),
    }));
    const { default: config } = await import("../next.config");
    expect(config.allowedDevOrigins).toEqual(["127.0.0.1", "192.0.2.20"]);
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain("npm run dev -- -H 0.0.0.0");
  });
});

describe("drizzle.config", () => {
  it("loads .env.local itself, since drizzle-kit runs outside tsx and _env.ts (D-125)", async () => {
    const saved = { url: process.env.DATABASE_URL, unpooled: process.env.DATABASE_URL_UNPOOLED };
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    const fromEnvFile = "postgresql://postgres:postgres@127.0.0.1:55437/from_env_local";
    const loadEnvConfig = vi.fn(() => {
      process.env.DATABASE_URL = fromEnvFile;
    });
    vi.doMock("@next/env", () => ({ loadEnvConfig, default: { loadEnvConfig } }));
    try {
      const { default: config } = await import("../drizzle.config");
      expect(loadEnvConfig).toHaveBeenCalledWith(ROOT.replace(/\/$/, ""), true);
      expect((config as { dbCredentials: { url: string } }).dbCredentials.url).toBe(fromEnvFile);
    } finally {
      for (const [key, value] of [
        ["DATABASE_URL", saved.url],
        ["DATABASE_URL_UNPOOLED", saved.unpooled],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
