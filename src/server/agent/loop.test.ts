import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { policy } from "@/server/config/policy";
import type { Db } from "@/server/db/types";
import { makeTestDeps } from "@/test/deps";
import { textMessage } from "@/test/fake-llm";
import {
  buildRequest,
  callOptions,
  echoContent,
  finalText,
  runLoop,
  withLastToolCached,
  type LoopInput,
  type ToolExecutor,
} from "./loop";
import type { Message, ToolUnion } from "./types";

type Content = Message["content"];

const tool = (name: string): ToolUnion => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object", properties: {} },
});

const NOW = new Date("2026-11-02T17:30:00.000Z");
const signal = new AbortController().signal;

describe("buildRequest", () => {
  const spec = {
    model: "claude-sonnet-5-5",
    effort: "medium" as const,
    maxTokens: 8000,
    userId: "8f0c7a52-3a8e-4c1e-9d55-0d2f0a3b7c11",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  it("omits tools and tool_choice when no tools are registered", () => {
    const req = buildRequest({ ...spec, tools: [] });
    expect("tools" in req).toBe(false);
    expect("tool_choice" in req).toBe(false);
  });

  it("puts a 1 h cache breakpoint on the last tool only and uses tool_choice auto", () => {
    const tools = [tool("a_tool"), tool("b_tool"), tool("c_tool")];
    const req = buildRequest({ ...spec, tools });
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.tools?.map((t) => ("cache_control" in t ? t.cache_control : undefined))).toEqual([
      undefined,
      undefined,
      { type: "ephemeral", ttl: "1h" },
    ]);
    // The caller's (frozen, shared) tool list is never mutated.
    expect("cache_control" in tools[2]).toBe(false);
    expect(withLastToolCached([])).toEqual([]);
  });
});

describe("callOptions", () => {
  it.each([
    [300_000, policy.agent.llmCallTimeoutMs, 1],
    [policy.agent.llmRetryMinRemainingMs + 1, policy.agent.llmCallTimeoutMs, 1],
    [policy.agent.llmRetryMinRemainingMs, policy.agent.llmCallTimeoutMs, 0],
    [80_000, 80_000 - policy.agent.llmDeadlineMarginMs, 0],
  ])("with %i ms left: timeout %i, maxRetries %i", (remaining, timeoutMs, maxRetries) => {
    const opts = callOptions(NOW, NOW.getTime() + remaining, signal);
    expect({ timeoutMs: opts?.timeoutMs, maxRetries: opts?.maxRetries }).toEqual({ timeoutMs, maxRetries });
  });

  it("returns null when the margin leaves no time for a call", () => {
    expect(callOptions(NOW, NOW.getTime() + policy.agent.llmDeadlineMarginMs, signal)).toBeNull();
  });

  it("aborts at the deadline margin, so a long retry-after can't outlive the invocation", async () => {
    let fetches = 0;
    const client = new Anthropic({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () => {
        fetches += 1;
        const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
        return new Response(body, { status: 429, headers: { "content-type": "application/json", "retry-after": "600" } });
      },
    });
    const lease = new AbortController();
    const opts = callOptions(NOW, NOW.getTime() + policy.agent.llmDeadlineMarginMs + 50, lease.signal);
    if (!opts) throw new Error("expected a call budget");
    const call = client.beta.messages.create(
      { model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      // A retry is forced so the SDK sleeps out the retry-after; only the signal can end that sleep.
      { signal: opts.signal, timeout: opts.timeoutMs, maxRetries: 1 },
    );
    const outcome = await Promise.race([
      call.then(
        () => "resolved",
        (err: unknown) => err,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still asleep"), 2_000)),
    ]);
    expect(outcome).toBeInstanceOf(APIUserAbortError);
    expect(fetches).toBe(1);
    expect(lease.signal.aborted).toBe(false);
  });

  it("still follows the caller's signal", () => {
    const lease = new AbortController();
    const opts = callOptions(NOW, NOW.getTime() + 300_000, lease.signal);
    lease.abort(new Error("lease lost"));
    expect(opts?.signal.aborted).toBe(true);
  });
});

describe("finalText and echoContent", () => {
  const fallback = {
    type: "fallback",
    from: { model: "claude-sonnet-5-5" },
    to: { model: "claude-sonnet-5" },
    trigger: { type: "refusal" },
  };

  it("joins adjacent text blocks and separates text around other blocks", () => {
    const content = [
      { type: "text", text: "Nice ", citations: null },
      { type: "text", text: "plate!", citations: null },
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Want ideas?", citations: null },
    ] as unknown as Content;
    expect(finalText(content)).toBe("Nice plate!\n\nWant ideas?");
  });

  it("reads only the text after the last server-side fallback boundary", () => {
    const content = [
      { type: "text", text: "declined partial", citations: null },
      fallback,
      { type: "text", text: "from the fallback", citations: null },
    ] as unknown as Content;
    expect(finalText(content)).toBe("from the fallback");
  });

  it("drops thinking and tool_use blocks before the last fallback block when echoing", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s1" },
      { type: "tool_use", id: "t1", name: "x", input: {}, caller: { type: "direct" } },
      { type: "text", text: "kept text", citations: null },
      fallback,
      { type: "thinking", thinking: "", signature: "s2" },
    ] as unknown as Content;
    expect(echoContent(content).map((b) => b.type)).toEqual(["text", "fallback", "thinking"]);
    const plain = [{ type: "thinking", thinking: "", signature: "s" }] as unknown as Content;
    expect(echoContent(plain)).toEqual(plain);
  });
});

describe("runLoop with tools (M2 readiness)", () => {
  it("executes tool calls, appends results in one user message, and continues", async () => {
    const deps = makeTestDeps(null as unknown as Db);
    const toolUse = { type: "tool_use", id: "toolu_1", name: "a_tool", input: { q: 1 }, caller: { type: "direct" } };
    deps.llm.push(
      { ...textMessage(""), content: [toolUse], stop_reason: "tool_use" } as unknown as Message,
      textMessage("Logged it."),
    );
    const calls: string[] = [];
    const executeTools: ToolExecutor = async (blocks) => {
      calls.push(...blocks.map((b) => b.id));
      return blocks.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" }));
    };
    const input: LoopInput = {
      model: "claude-sonnet-5-5",
      effort: "medium",
      maxTokens: 8000,
      userId: "8f0c7a52-3a8e-4c1e-9d55-0d2f0a3b7c11",
      tools: [tool("a_tool")],
      messages: [{ role: "user", content: "log my eggs" }],
      signal,
      deadlineMs: deps.clock.now().getTime() + 300_000,
      maxIterations: policy.agent.maxIterations,
      executeTools,
    };
    const result = await runLoop(deps, input);
    expect(calls).toEqual(["toolu_1"]);
    expect(result.outcome).toEqual({ kind: "text", text: "Logged it." });
    const second = deps.llm.requests[1].params;
    expect(second.messages.slice(1)).toEqual([
      { role: "assistant", content: [toolUse] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ]);
    expect(second.tool_choice).toEqual({ type: "auto" });
    // The input array is never mutated (append-only copy).
    expect(input.messages).toHaveLength(1);
  });

  it("logs a tool executor failure with sanitized fields only, then ends with an error outcome", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = makeTestDeps(null as unknown as Db);
    const toolUse = { type: "tool_use", id: "toolu_1", name: "a_tool", input: {}, caller: { type: "direct" } };
    deps.llm.push({ ...textMessage(""), content: [toolUse], stop_reason: "tool_use" } as unknown as Message);
    const dbError = Object.assign(new Error('Failing row contains (secret meal text)'), { code: "23502" });
    const result = await runLoop(deps, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      maxTokens: 8000,
      userId: "u",
      tools: [tool("a_tool")],
      messages: [{ role: "user", content: "hi" }],
      signal,
      deadlineMs: deps.clock.now().getTime() + 300_000,
      maxIterations: 2,
      executeTools: async () => {
        throw dbError;
      },
    });
    expect(result.outcome.kind).toBe("error");
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("agent.tools_failed");
    expect(logged).toContain('"sqlState":"23502"');
    expect(logged).not.toContain("secret meal text");
    spy.mockRestore();
  });

  it("stops at maxIterations", async () => {
    const deps = makeTestDeps(null as unknown as Db);
    const paused = { ...textMessage("…"), stop_reason: "pause_turn" } as Message;
    deps.llm.push(paused, paused, paused);
    const result = await runLoop(deps, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      maxTokens: 8000,
      userId: "u",
      tools: [],
      messages: [{ role: "user", content: "hi" }],
      signal,
      deadlineMs: deps.clock.now().getTime() + 300_000,
      maxIterations: 2,
    });
    expect(result.outcome).toEqual({ kind: "iterations_exhausted" });
    expect(deps.llm.requests).toHaveLength(2);
  });
});
