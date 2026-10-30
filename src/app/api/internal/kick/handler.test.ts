import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Deps } from "@/server/deps";
import type { Runner } from "@/server/pipeline/runner";
import { bearerMatches, handleInternalKick } from "./handler";

const SECRET = "test-secret-6b1f0d0e9a4c4d7f";

class RecordingRunner implements Runner {
  readonly names: string[] = [];
  run(name: string): void {
    this.names.push(name);
  }
}

function setup() {
  const runner = new RecordingRunner();
  let built = 0;
  const getDeps = () => {
    built += 1;
    return { runner } as unknown as Deps;
  };
  return { runner, getDeps, built: () => built };
}

function request(body: unknown, auth?: string): Request {
  return new Request("http://localhost/api/internal/kick", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/internal/kick", () => {
  it("schedules a kick for a valid, authenticated request", async () => {
    const s = setup();
    const res = await handleInternalKick(request({ userId: randomUUID() }, `Bearer ${SECRET}`), SECRET, s.getDeps);
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(s.runner.names).toEqual(["internal_kick"]);
  });

  it.each([
    ["no header", undefined],
    ["a wrong secret", "Bearer nope"],
    ["a longer secret", `Bearer ${SECRET}x`],
    ["the wrong scheme", `Basic ${SECRET}`],
  ])("401s with %s, before building deps", async (_label, auth) => {
    const s = setup();
    const res = await handleInternalKick(request({ userId: randomUUID() }, auth), SECRET, s.getDeps);
    expect(res.status).toBe(401);
    expect(s.built()).toBe(0);
    expect(s.runner.names).toEqual([]);
  });

  it("401s everything when no secret is configured", async () => {
    const s = setup();
    for (const auth of ["Bearer ", "Bearer undefined", undefined]) {
      expect((await handleInternalKick(request({ userId: randomUUID() }, auth), undefined, s.getDeps)).status).toBe(401);
      expect((await handleInternalKick(request({ userId: randomUUID() }, auth), "", s.getDeps)).status).toBe(401);
    }
  });

  it("400s a body that isn't {userId: uuid}", async () => {
    const s = setup();
    for (const body of ["not json", { userId: "u-1" }, {}, { userId: randomUUID(), extra: 1 }]) {
      const res = await handleInternalKick(request(body, `Bearer ${SECRET}`), SECRET, s.getDeps);
      if (typeof body === "object" && "extra" in body) {
        // Unknown keys are stripped, not rejected.
        expect(res.status).toBe(202);
      } else {
        expect(res.status).toBe(400);
      }
    }
  });

  it("bearerMatches is exact", () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(bearerMatches(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(bearerMatches(null, SECRET)).toBe(false);
  });
});
