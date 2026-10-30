import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema, resetEnvForTests } from "@/server/config/env";
import { config, proxy } from "@/proxy";
import { isCrossSiteRequest, simulatorAvailable } from "./guard";

// D-102: the simulator is reachable only when explicitly enabled, never on production, and (until
// admin Basic auth lands in M5) never on previews. Both proxy.ts and every handler use this check.

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("simulatorAvailable", () => {
  it.each([
    [{ ENABLE_SIMULATOR: "true" }, true],
    [{ ENABLE_SIMULATOR: "true", VERCEL_ENV: "development" }, true],
    [{ ENABLE_SIMULATOR: "true", VERCEL_ENV: "production" }, false],
    [{ ENABLE_SIMULATOR: "true", VERCEL_ENV: "preview" }, false],
    [{ ENABLE_SIMULATOR: "false" }, false],
    [{}, false],
  ])("%j -> %s", (vars, expected) => {
    expect(simulatorAvailable(envSchema.parse(vars))).toBe(expected);
  });

  it("fails closed when the environment doesn't validate", () => {
    vi.stubEnv("ENABLE_SIMULATOR", "true");
    vi.stubEnv("LOG_LEVEL", "verbose");
    resetEnvForTests();
    expect(simulatorAvailable()).toBe(false);
  });
});

describe("proxy", () => {
  it("404s /dev and /api/dev when the simulator is off", async () => {
    vi.stubEnv("ENABLE_SIMULATOR", "false");
    resetEnvForTests();
    const res = proxy();
    expect(res?.status).toBe(404);
    expect(res?.headers.get("cache-control")).toContain("no-store");
  });

  it("is a production deployment's hard stop even with the flag on", () => {
    vi.stubEnv("ENABLE_SIMULATOR", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    resetEnvForTests();
    expect(proxy()?.status).toBe(404);
  });

  it("passes requests through when the simulator is on", () => {
    vi.stubEnv("ENABLE_SIMULATOR", "true");
    resetEnvForTests();
    expect(proxy()).toBeUndefined();
  });

  it("matches only /dev and /api/dev; webhook, cron, internal and admin routes stay outside", async () => {
    // Next's own matcher implementation. Its module graph expects the global that Next's server sets.
    (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
    const { unstable_doesMiddlewareMatch: matches } = await import("next/experimental/testing/server");
    for (const url of ["/dev", "/dev/chat", "/dev/chat?phone=%2B12015550100", "/api/dev/sim/messages", "/api/dev/sim/media/x"]) {
      expect(matches({ config, url }), url).toBe(true);
    }
    for (const url of [
      "/",
      "/devtools",
      "/api/devices",
      "/api/internal/kick",
      "/api/webhooks/sendblue/token",
      "/api/webhooks/stripe",
      "/api/cron/tick",
      "/admin",
    ]) {
      expect(matches({ config, url }), url).toBe(false);
    }
  });
});

describe("isCrossSiteRequest", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/dev/sim/messages", { method: "POST", headers });

  it.each([
    ["the page's own fetch", { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }, false],
    ["a user-initiated request", { "sec-fetch-site": "none" }, false],
    ["curl or a test (no browser headers)", {}, false],
    ["an older browser posting from the same host", { origin: "http://localhost:3000", host: "localhost:3000" }, false],
    ["a form on another site", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }, true],
    ["another dev server on localhost", { "sec-fetch-site": "same-site", origin: "http://localhost:5173" }, true],
    ["an older browser posting from elsewhere", { origin: "https://evil.example", host: "localhost:3000" }, true],
    ["a sandboxed frame", { origin: "null" }, true],
  ])("%s -> %s", (_label, headers, expected) => {
    expect(isCrossSiteRequest(req(headers))).toBe(expected);
  });
});
