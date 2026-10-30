import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "@/server/config/env";
import { textMessage } from "@/test/fake-llm";
import { LlmCallError, toLlmCallError } from "./errors";
import { AnthropicLlm, createLlmClient, FALLBACK_BETA, type BetaMessagesApi } from "./llm";
import { OfflineDemoLlm } from "./offline-llm";
import type { LlmRequest, MessageParams } from "./types";

const headers = () => new Headers({ "request-id": "req_test_123" });
const request: LlmRequest = {
  model: "claude-sonnet-5-5",
  max_tokens: 8000,
  messages: [{ role: "user", content: "secret meal text" }],
};
const opts = () => ({ signal: new AbortController().signal, timeoutMs: 42_000, maxRetries: 1 });

class RecordingApi implements BetaMessagesApi {
  readonly calls: { body: MessageParams; options: { signal: AbortSignal; timeout: number; maxRetries: number } }[] = [];
  constructor(private readonly result: () => Promise<ReturnType<typeof textMessage>>) {}
  create(body: MessageParams, options: { signal: AbortSignal; timeout: number; maxRetries: number }) {
    this.calls.push({ body, options });
    return this.result();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AnthropicLlm", () => {
  it("opts into the server-side fallback and passes the per-call budget", async () => {
    const api = new RecordingApi(async () => textMessage("hi"));
    const o = opts();
    await new AnthropicLlm(api, true).create(request, o);
    const { body, options } = api.calls[0];
    expect(body.betas).toEqual([FALLBACK_BETA]);
    expect(body.fallbacks).toBe("default");
    expect(options).toEqual({ signal: o.signal, timeout: 42_000, maxRetries: 1 });
    expect(request).not.toHaveProperty("betas");
  });

  it("sends no beta header or fallbacks when ANTHROPIC_FALLBACKS=off", async () => {
    const api = new RecordingApi(async () => textMessage("hi"));
    await new AnthropicLlm(api, false).create(request, opts());
    expect(api.calls[0].body).not.toHaveProperty("betas");
    expect(api.calls[0].body).not.toHaveProperty("fallbacks");
  });

  it("never sends sampling parameters, even if a caller smuggles them in", async () => {
    const api = new RecordingApi(async () => textMessage("hi"));
    const smuggled = { ...request, temperature: 0.2, top_p: 0.9, top_k: 5 } as LlmRequest;
    await new AnthropicLlm(api, true).create(smuggled, opts());
    for (const key of ["temperature", "top_p", "top_k"]) expect(api.calls[0].body).not.toHaveProperty(key);
  });

  it("maps SDK errors and logs only sanitized metadata", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = { type: "error", error: { type: "overloaded_error", message: "echo: secret meal text" } };
    const api = new RecordingApi(async () => {
      throw new InternalServerError(529, body, undefined, headers(), "overloaded_error");
    });
    const err = await new AnthropicLlm(api, true).create(request, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).kind).toBe("overloaded");
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("req_test_123");
    expect(logged).toContain('"httpStatus":529');
    expect(logged).not.toContain("secret meal text");
  });
});

describe("toLlmCallError", () => {
  const spendCapBody = {
    type: "error",
    error: { type: "rate_limit_error", message: "limit", details: { error_code: "enforced_spend_limit_reached" } },
  };
  const cases: [string, unknown, string, boolean][] = [
    ["spend-cap 429", new RateLimitError(429, spendCapBody, undefined, headers(), "rate_limit_error"), "spend_cap", false],
    [
      "ordinary 429",
      new RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }, undefined, headers()),
      "rate_limited",
      true,
    ],
    ["529", new InternalServerError(529, {}, undefined, headers(), "overloaded_error"), "overloaded", true],
    ["500", new InternalServerError(500, {}, undefined, headers(), "api_error"), "server", true],
    ["400", new BadRequestError(400, {}, undefined, headers(), "invalid_request_error"), "bad_request", false],
    ["401", new AuthenticationError(401, {}, undefined, headers(), "authentication_error"), "auth", false],
    ["402", APIError.generate(402, { type: "error", error: { type: "billing_error" } }, undefined, headers()), "billing", false],
    ["user abort", new APIUserAbortError(), "aborted", false],
    ["timeout", new APIConnectionTimeoutError(), "timeout", true],
    ["connection", new APIConnectionError({ message: "reset" }), "connection", true],
    ["plain error", new Error("x"), "unknown", false],
    ["non-error", "string", "unknown", false],
  ];

  it.each(cases)("%s -> %s", (_name, input, kind, retryable) => {
    const mapped = toLlmCallError(input);
    expect(mapped.kind).toBe(kind);
    expect(mapped.retryable).toBe(retryable);
    expect(mapped.errorCode).toBe(`llm_${kind}`);
    expect(mapped.message).toBe(`llm_${kind}`);
  });

  it("keeps the request ID and status for logs", () => {
    const mapped = toLlmCallError(new InternalServerError(500, {}, undefined, headers(), "api_error"));
    expect(mapped.requestID).toBe("req_test_123");
    expect(mapped.status).toBe(500);
  });
});

describe("createLlmClient", () => {
  it("returns the offline demo model for LLM_PROVIDER=fake", () => {
    const env = envSchema.parse({ NODE_ENV: "test", LLM_PROVIDER: "fake" });
    expect(createLlmClient(env)).toBeInstanceOf(OfflineDemoLlm);
  });

  it("returns the Anthropic client otherwise, without making a call", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = envSchema.parse({ NODE_ENV: "test", LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test-not-real" });
    expect(createLlmClient(env)).toBeInstanceOf(AnthropicLlm);
  });
});
