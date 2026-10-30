import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/server/config/env";
import type { Deps } from "@/server/deps";

// D-012 / D-102: every /dev page and /api/dev route re-checks the simulator guard itself, so a
// disabled simulator (or a production or preview deployment) answers 404 even if the proxy were
// bypassed or its matcher drifted, and no deps (DB pool, storage, LLM client) get built.
// /api/internal/kick is the contrast: it is not simulator-gated and authenticates by its secret.

type WithDeps = (route: string, fn: (deps: Deps) => Promise<Response>) => Promise<Response>;

const wiring = vi.hoisted(() => ({
  withDeps: vi.fn<WithDeps>(async () => new Response("delegated")),
  safeRoute: vi.fn(async (_route: string, fn: () => Promise<Response>) => fn()),
  getDeps: vi.fn((): Deps => {
    throw new Error("getDeps must not be called");
  }),
}));
vi.mock("@/server/wiring", () => wiring);
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

const { POST: postMessages } = await import("@/app/api/dev/sim/messages/route");
const { GET: getThread } = await import("@/app/api/dev/sim/thread/route");
const { POST: postReset } = await import("@/app/api/dev/sim/reset/route");
const { GET: getMedia } = await import("@/app/api/dev/sim/media/[id]/route");
const { POST: postKick } = await import("@/app/api/internal/kick/route");
const { default: DevIndex } = await import("@/app/dev/page");
const { default: DevChatPage } = await import("@/app/dev/chat/page");

const BASE = "http://localhost:3000";

const routes: [string, string, () => Promise<Response>][] = [
  ["POST /api/dev/sim/messages", "dev.sim.messages", () => postMessages(new Request(`${BASE}/api/dev/sim/messages`, { method: "POST", body: new FormData() }))],
  ["GET /api/dev/sim/thread", "dev.sim.thread", () => getThread(new Request(`${BASE}/api/dev/sim/thread?phone=%2B12015550100`))],
  ["POST /api/dev/sim/reset", "dev.sim.reset", () => postReset(new Request(`${BASE}/api/dev/sim/reset`, { method: "POST" }))],
  ["GET /api/dev/sim/media/[id]", "dev.sim.media", () => getMedia(new Request(`${BASE}/api/dev/sim/media/x`), { params: Promise.resolve({ id: randomUUID() }) })],
];

const chatPage = (phone?: string) => DevChatPage({ searchParams: Promise.resolve(phone === undefined ? {} : { phone }) });

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  resetEnvForTests();
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe.each([
  ["the flag off", { ENABLE_SIMULATOR: "false" }],
  ["a production deployment", { ENABLE_SIMULATOR: "true", VERCEL_ENV: "production" }],
  ["a preview deployment", { ENABLE_SIMULATOR: "true", VERCEL_ENV: "preview" }],
  ["an environment that doesn't validate", { ENABLE_SIMULATOR: "true", LOG_LEVEL: "verbose" }],
])("with %s", (_label, vars) => {
  beforeEach(() => setEnv(vars));

  it.each(routes)("%s answers 404 without building deps", async (_name, _route, call) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(wiring.withDeps).not.toHaveBeenCalled();
    expect(wiring.getDeps).not.toHaveBeenCalled();
  });

  it("the /dev pages call notFound()", async () => {
    expect(() => DevIndex()).toThrow("NEXT_NOT_FOUND");
    await expect(chatPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("with the simulator on", () => {
  beforeEach(() => setEnv({ ENABLE_SIMULATOR: "true" }));

  it.each(routes)("%s hands off to its handler", async (_name, route, call) => {
    expect(await (await call()).text()).toBe("delegated");
    expect(wiring.withDeps).toHaveBeenCalledTimes(1);
    expect(wiring.withDeps.mock.calls[0][0]).toBe(route);
  });

  it("/dev redirects to /dev/chat, which starts on a number in the switcher's range", async () => {
    expect(() => DevIndex()).toThrow("NEXT_REDIRECT /dev/chat");
    expect((await chatPage()).props).toEqual({ initialPhone: "+12015550100" });
    expect((await chatPage("0142")).props).toEqual({ initialPhone: "+12015550142" });
    // Out of range: falls back to the default rather than echoing it into the page.
    expect((await chatPage(["+1201555", "0200"].join(""))).props).toEqual({ initialPhone: "+12015550100" });
  });
});

describe("POST /api/internal/kick", () => {
  it("is not simulator-gated: with the simulator off it still authenticates by its secret", async () => {
    setEnv({ ENABLE_SIMULATOR: "false", INTERNAL_KICK_SECRET: "kick-secret-0a6c1f2e-for-tests-only-0000" });
    const kickRequest = (auth?: string) =>
      new Request(`${BASE}/api/internal/kick`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ userId: randomUUID() }),
      });

    expect((await postKick(kickRequest())).status).toBe(401);
    expect(wiring.getDeps).not.toHaveBeenCalled();

    const run = vi.fn();
    wiring.getDeps.mockReturnValueOnce({ runner: { run } } as unknown as Deps);
    expect((await postKick(kickRequest("Bearer kick-secret-0a6c1f2e-for-tests-only-0000"))).status).toBe(202);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
