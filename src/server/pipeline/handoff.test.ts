import { describe, expect, it } from "vitest";
import { sanitizeError } from "@/server/errors";
import { createHttpHandoff, HandoffError } from "./handoff";

function fakeFetch(status = 202) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fn, calls };
}

describe("createHttpHandoff", () => {
  it("POSTs only the user id to /api/internal/kick with the bearer secret", async () => {
    const f = fakeFetch();
    const handoff = createHttpHandoff("https://coach.example.test/some/path", "s3cret", { fetchFn: f.fn });
    await handoff("0b6f3f2e-9a43-4c34-8d43-1f0a2b3c4d5e");
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe("https://coach.example.test/api/internal/kick");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer s3cret", "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ userId: "0b6f3f2e-9a43-4c34-8d43-1f0a2b3c4d5e" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("adds the Vercel protection-bypass header when configured", async () => {
    const f = fakeFetch();
    await createHttpHandoff("https://preview.example.test", "s", { fetchFn: f.fn, bypassSecret: "bypass" })("u");
    expect(f.calls[0].init.headers).toMatchObject({ "x-vercel-protection-bypass": "bypass" });
  });

  it("cancels the unread response body so the connection is released", async () => {
    let res: Response | null = null;
    const fn = (async () => {
      res = new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return res;
    }) as typeof fetch;
    await createHttpHandoff("https://coach.example.test", "s", { fetchFn: fn })("u");
    expect(res!.bodyUsed).toBe(true);
  });

  it("throws a sanitized error on a non-2xx answer", async () => {
    const f = fakeFetch(401);
    const err = await createHttpHandoff("https://coach.example.test", "s", { fetchFn: f.fn })("u").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandoffError);
    expect(sanitizeError(err)).toMatchObject({ errorName: "HandoffError", errorCode: "handoff_failed", httpStatus: 401 });
  });
});
