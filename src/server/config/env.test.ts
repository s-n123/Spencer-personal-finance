import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { envSchema, getEnv, resetEnvForTests, simulatorEnabled } from "./env";

// D-020: .env.example lists exactly the keys the schema reads (NODE_ENV and VERCEL_ENV are set by
// the platform), every example value validates, and the simulator can never be on in production.

const EXAMPLE = fileURLToPath(new URL("../../../.env.example", import.meta.url));
const PLATFORM_KEYS = new Set(["NODE_ENV", "VERCEL_ENV"]);

function exampleEntries(): Map<string, string> {
  const entries = new Map<string, string>();
  readFileSync(EXAMPLE, "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return;
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!m) throw new Error(`.env.example line ${i + 1} is not KEY=value`);
      if (entries.has(m[1])) throw new Error(`.env.example repeats ${m[1]}`);
      entries.set(m[1], m[2]);
    });
  return entries;
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe(".env.example", () => {
  it("has exactly the schema's keys", () => {
    const schemaKeys = Object.keys(envSchema.shape)
      .filter((k) => !PLATFORM_KEYS.has(k))
      .sort();
    expect([...exampleEntries().keys()].sort()).toEqual(schemaKeys);
  });

  it("validates as-is (a fresh copy to .env.local boots)", () => {
    const parsed = envSchema.safeParse(Object.fromEntries(exampleEntries()));
    expect(parsed.success, JSON.stringify(parsed.error?.issues.map((i) => i.path))).toBe(true);
    expect(parsed.data?.ENABLE_SIMULATOR).toBe(true);
    expect(parsed.data?.MEDIA_STORAGE).toBe("local");
  });

  it("holds no secrets", () => {
    const entries = exampleEntries();
    for (const key of ["ANTHROPIC_API_KEY", "INTERNAL_KICK_SECRET"]) expect(entries.get(key)).toBe("");
  });
});

describe("simulatorEnabled", () => {
  it("is off on a production deployment even with ENABLE_SIMULATOR=true", () => {
    const env = envSchema.parse({ VERCEL_ENV: "production", ENABLE_SIMULATOR: "true" });
    expect(simulatorEnabled(env)).toBe(false);
  });

  it("follows the flag elsewhere", () => {
    expect(simulatorEnabled(envSchema.parse({ ENABLE_SIMULATOR: "true" }))).toBe(true);
    expect(simulatorEnabled(envSchema.parse({ ENABLE_SIMULATOR: "1", VERCEL_ENV: "development" }))).toBe(true);
    expect(simulatorEnabled(envSchema.parse({}))).toBe(false);
    expect(simulatorEnabled(envSchema.parse({ ENABLE_SIMULATOR: "false" }))).toBe(false);
  });

  it("getEnv refuses a production deployment with the flag set", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ENABLE_SIMULATOR", "true");
    expect(() => getEnv()).toThrow(/ENABLE_SIMULATOR/);
  });
});

describe("instrumentation register()", () => {
  it("validates the environment eagerly on the Node runtime, so a bad config fails at start", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("MODEL_MAIN_EFFORT", "canary-value-91c2");
    await expect(register()).rejects.toThrow(/MODEL_MAIN_EFFORT/);
  });

  it("refuses to start a production deployment with the simulator flag on", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ENABLE_SIMULATOR", "true");
    await expect(register()).rejects.toThrow(/ENABLE_SIMULATOR/);
  });

  it("starts with a valid environment and skips other runtimes", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await expect(register()).resolves.toBeUndefined();
    resetEnvForTests();
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("MODEL_MAIN_EFFORT", "canary-value-91c2");
    await expect(register()).resolves.toBeUndefined();
  });
});

describe("getEnv", () => {
  it("reports invalid keys by name, never their values", () => {
    vi.stubEnv("MODEL_MAIN_EFFORT", "canary-value-91c2");
    let message = "";
    try {
      getEnv();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("MODEL_MAIN_EFFORT");
    expect(message).not.toContain("canary-value-91c2");
  });
});
