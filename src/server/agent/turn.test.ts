import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { policy } from "@/server/config/policy";
import { inboundMessages, media, outboundMessages, turns, users } from "@/server/db/schema";
import type { AgentTurnInput, ClaimedMessage, ReadyImage, UserRow } from "@/server/pipeline/contracts";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, type TestDeps } from "@/test/deps";
import { textMessage } from "@/test/fake-llm";
import { CONTEXT_HEADER } from "./context";
import { LlmCallError } from "./errors";
import { MAX_TOKENS_RETRY_CAP } from "./loop";
import { SYSTEM_PROMPT } from "./system-prompt";
import { AGENT_ERROR_REPLY, REFUSAL_REPLY, runAgent, SHORTEN_NOTE, SYSTEM_NOTE_HEADER, withUserNote } from "./turn";
import type { LlmRequest, Message } from "./types";

const PHONE = "+12015550105";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let t: TestDb;
let deps: TestDeps;
let user: UserRow;
let turnId: string;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
  deps = makeTestDeps(t.db);
  [user] = await deps.db
    .insert(users)
    .values({
      phoneE164: PHONE,
      provider: "simulator",
      status: "active",
      consentedAt: deps.clock.now(),
      timezone: "America/New_York",
      timezoneSource: "simulator",
    })
    .returning();
  turnId = await insertTurn(deps.clock.now());
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function insertTurn(at: Date): Promise<string> {
  const [row] = await deps.db
    .insert(turns)
    .values({ userId: user.id, clockAt: at, startedAt: at, status: "claimed" })
    .returning({ id: turns.id });
  return row.id;
}

async function claimed(text: string | null, minutesAgo = 0, forTurn = turnId): Promise<ClaimedMessage> {
  const sentAt = new Date(deps.clock.now().getTime() - minutesAgo * 60_000);
  const [row] = await deps.db
    .insert(inboundMessages)
    .values({
      userId: user.id,
      provider: "simulator",
      providerMessageId: `sim-${++seq}`,
      text,
      sentAt,
      receivedAt: sentAt,
      status: forTurn === turnId ? "processing" : "done",
      turnId: forTurn,
    })
    .returning();
  return {
    id: row.id,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    text: row.text,
    keyword: row.keyword,
    crisisKind: row.crisisKind,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
  };
}

async function photo(msg: ClaimedMessage, ref: string): Promise<ReadyImage> {
  const [row] = await deps.db
    .insert(media)
    .values({ userId: user.id, inboundMessageId: msg.id, status: "stored", width: 1456, height: 1092 })
    .returning({ id: media.id });
  return {
    mediaId: row.id,
    inboundMessageId: msg.id,
    ref,
    base64: Buffer.from(`fake-jpeg-${ref}`).toString("base64"),
    mediaType: "image/jpeg",
    width: 1456,
    height: 1092,
  };
}

function input(overrides: Partial<AgentTurnInput> & Pick<AgentTurnInput, "messages">): AgentTurnInput {
  return {
    user,
    turnId,
    turnClock: deps.clock.now(),
    timezone: "America/New_York",
    images: [],
    failedImageCount: 0,
    signal: new AbortController().signal,
    deadlineMs: deps.clock.now().getTime() + policy.pipeline.maxDurationMs,
    ...overrides,
  };
}

function response(content: unknown[], stopReason: Message["stop_reason"], extra: Record<string, unknown> = {}): Message {
  return { ...textMessage(""), content, stop_reason: stopReason, stop_details: null, ...extra } as Message;
}

function lastRequest(): LlmRequest {
  return deps.llm.requests[deps.llm.requests.length - 1].params;
}

function findKeys(value: unknown, keys: string[], path = "$"): string[] {
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (keys.includes(k)) found.push(`${path}.${k}`);
    found.push(...findKeys(v, keys, `${path}.${k}`));
  }
  return found;
}

describe("runAgent request shape", () => {
  it("builds a cache-friendly request with labelled images before the caption", async () => {
    // One earlier exchange in history.
    const earlier = await insertTurn(new Date(deps.clock.now().getTime() - 3_600_000));
    await claimed("hello coach", 60, earlier);
    await deps.db.insert(outboundMessages).values({
      userId: user.id,
      turnId: earlier,
      kind: "reply",
      text: "Hi! Send me a meal photo anytime.",
      idempotencyKey: "reply:earlier:0",
      status: "sent",
    });

    const p1 = await claimed(null, 1);
    const p2 = await claimed(null, 0.5);
    const caption = await claimed("my lunch");
    const images = [await photo(p1, "img1"), await photo(p2, "img2")];
    deps.llm.push(textMessage("Looks like a grain bowl with salmon!\n\nWhat dressing did you use?"));

    const out = await runAgent(deps, input({ messages: [p1, p2, caption], images }));

    expect(deps.llm.requests).toHaveLength(1);
    const { params, opts } = deps.llm.requests[0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.max_tokens).toBe(policy.agent.mainMaxTokens);
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(params.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
    expect("thinking" in params).toBe(false);
    expect("tools" in params).toBe(false);
    expect("tool_choice" in params).toBe(false);
    expect(findKeys(params, ["temperature", "top_p", "top_k"])).toEqual([]);

    expect(params.metadata?.user_id).toBe(user.id);
    expect(params.metadata?.user_id).toMatch(UUID);
    expect(JSON.stringify(params)).not.toContain(PHONE.slice(2));

    // History is text-only; the final user message is context, labelled images, then caption.
    const history = params.messages.slice(0, -1);
    expect(history).toEqual([
      { role: "user", content: "hello coach" },
      { role: "assistant", content: "Hi! Send me a meal photo anytime." },
    ]);
    const final = params.messages[params.messages.length - 1];
    expect(final.role).toBe("user");
    const blocks = Array.isArray(final.content) ? final.content : [];
    expect(blocks.map((b) => b.type)).toEqual(["text", "text", "image", "text", "image", "text"]);
    const texts = blocks.map((b) => (b.type === "text" ? b.text : null));
    expect(texts[0]).toMatch(new RegExp(`^\\${CONTEXT_HEADER.slice(0, -1)}`));
    expect(texts[0]).toContain("Local time: Monday, November 2, 2026, 12:30 PM (2026-11-02)");
    expect(texts[0]).toContain("Photos attached: 2 (img1, img2)");
    expect(texts[1]).toBe("img1:");
    expect(texts[3]).toBe("img2:");
    expect(texts[5]).toBe("my lunch");
    const image = blocks[2];
    expect(image.type === "image" && image.source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: images[0].base64,
    });

    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.timeoutMs).toBe(policy.agent.llmCallTimeoutMs);
    expect(opts.maxRetries).toBe(1);

    expect(out).toEqual({
      bubbles: ["Looks like a grain bowl with salmon!", "What dressing did you use?"],
      mode: "agent",
      stopReason: "end_turn",
      refusalCategory: null,
      usage: [
        { latencyMs: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: "end_turn" },
      ],
      mediaSummaries: [
        { mediaId: images[0].mediaId, summary: "[photo 12:29]", kind: null },
        { mediaId: images[1].mediaId, summary: "[photo 12:29]", kind: null },
      ],
    });
  });

  it("never replays thinking or tool blocks from earlier turns", async () => {
    const earlier = await insertTurn(new Date(deps.clock.now().getTime() - 60_000));
    await claimed("earlier", 1, earlier);
    await deps.db.insert(outboundMessages).values({
      userId: user.id,
      turnId: earlier,
      kind: "reply",
      text: "earlier reply",
      idempotencyKey: "reply:e:0",
      status: "sent",
    });
    await runAgent(deps, input({ messages: [await claimed("now")] }));
    for (const m of lastRequest().messages.slice(0, -1)) {
      expect(typeof m.content).toBe("string");
    }
    expect(findKeys(lastRequest().messages, ["thinking", "signature", "tool_use_id"])).toEqual([]);
  });

  it("folds an unanswered earlier message into this turn's user message", async () => {
    const earlier = await insertTurn(new Date(deps.clock.now().getTime() - 60_000));
    await claimed("did you get this?", 1, earlier);
    await runAgent(deps, input({ messages: [await claimed("hello?")] }));
    const msgs = lastRequest().messages;
    expect(msgs).toHaveLength(1);
    const blocks = Array.isArray(msgs[0].content) ? msgs[0].content : [];
    expect(blocks[0]).toEqual({ type: "text", text: "did you get this?" });
    expect(blocks[1].type === "text" && blocks[1].text.startsWith(CONTEXT_HEADER)).toBe(true);
  });

  it("reports failed photos in the context block", async () => {
    await runAgent(deps, input({ messages: [await claimed(null)], failedImageCount: 1 }));
    const blocks = lastRequest().messages[0].content;
    const context = Array.isArray(blocks) && blocks[0].type === "text" ? blocks[0].text : "";
    expect(context).toContain("1 photo couldn't be loaded — ask the user to resend it.");
    expect(context).toContain("Photos attached: none");
  });

  it("keeps the system block byte-identical across users, clocks and inputs", async () => {
    await runAgent(deps, input({ messages: [await claimed("one")] }));
    const first = JSON.stringify(lastRequest().system);
    deps.clock.advance(7 * 3_600_000);
    const [other] = await deps.db
      .insert(users)
      .values({ phoneE164: "+12015550106", provider: "simulator", status: "active", timezone: "Asia/Tokyo" })
      .returning();
    user = other;
    turnId = await insertTurn(deps.clock.now());
    await runAgent(deps, input({ messages: [await claimed("two")], timezone: "Asia/Tokyo" }));
    expect(JSON.stringify(lastRequest().system)).toBe(first);
  });

  it("derives a shorter timeout and no retries close to the deadline", async () => {
    const now = deps.clock.now().getTime();
    await runAgent(deps, input({ messages: [await claimed("hi")], deadlineMs: now + 100_000 }));
    const { opts } = deps.llm.requests[0];
    expect(opts.timeoutMs).toBe(100_000 - policy.agent.llmDeadlineMarginMs);
    expect(opts.maxRetries).toBe(0);
  });

  it("makes no call and sends the canned reply when the deadline leaves no time", async () => {
    const now = deps.clock.now().getTime();
    const out = await runAgent(deps, input({ messages: [await claimed("hi")], deadlineMs: now + 40_000 }));
    expect(deps.llm.requests).toHaveLength(0);
    expect(out.bubbles).toEqual([AGENT_ERROR_REPLY]);
    expect(out.stopReason).toBe("error:deadline");
  });

  it("records latency from the injected clock and token usage per iteration", async () => {
    deps.llm.push(() => {
      deps.clock.advance(1_234);
      return response([{ type: "text", text: "Done.", citations: null }], "end_turn", {
        usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 },
      });
    });
    const out = await runAgent(deps, input({ messages: [await claimed("hi")] }));
    expect(out.usage).toEqual([
      { latencyMs: 1_234, inputTokens: 50, outputTokens: 7, cacheReadTokens: 900, cacheWriteTokens: 40, stopReason: "end_turn" },
    ]);
  });
});

describe("runAgent stop reasons", () => {
  it("end_turn: uses only text blocks and ignores thinking", async () => {
    deps.llm.push(
      response(
        [
          // Non-empty (display "summarized"), so leaking it into the reply would show.
          { type: "thinking", thinking: "internal reasoning", signature: "sig" },
          { type: "text", text: "**Nice** plate!", citations: null },
          { type: "redacted_thinking", data: "opaque" },
        ],
        "end_turn",
      ),
    );
    const out = await runAgent(deps, input({ messages: [await claimed("lunch")] }));
    expect(out.bubbles).toEqual(["Nice plate!"]);
    expect(out.mode).toBe("agent");
  });

  it("end_turn with only markup (nothing left to send after formatting): canned reply", async () => {
    deps.llm.push(textMessage("---"), textMessage("```\n```"));
    for (let i = 0; i < 2; i++) {
      const out = await runAgent(deps, input({ messages: [await claimed("lunch")] }));
      expect(out.bubbles).toEqual([AGENT_ERROR_REPLY]);
      expect(out.mode).toBe("agent");
      expect(out.stopReason).toBe("error:empty_reply");
    }
  });

  it("end_turn with no text: canned reply", async () => {
    deps.llm.push(response([{ type: "thinking", thinking: "", signature: "sig" }], "end_turn"));
    const out = await runAgent(deps, input({ messages: [await claimed("lunch")] }));
    expect(out.bubbles).toEqual([AGENT_ERROR_REPLY]);
    expect(out.stopReason).toBe("error:empty_reply");
  });

  it("refusal: canned caring reply, safety mode, category recorded, partial output discarded", async () => {
    deps.llm.push(
      response([{ type: "text", text: "partial words", citations: null }], "refusal", {
        stop_details: { type: "refusal", category: "general_harms", explanation: null },
      }),
    );
    const out = await runAgent(deps, input({ messages: [await claimed("question")] }));
    expect(out.bubbles).toEqual([REFUSAL_REPLY]);
    expect(out.bubbles.join(" ")).not.toContain("partial");
    expect(out.mode).toBe("safety");
    expect(out.refusalCategory).toBe("general_harms");
    expect(out.stopReason).toBe("refusal");
    expect(REFUSAL_REPLY.length).toBeLessThanOrEqual(policy.format.maxBubbleChars);
    expect(REFUSAL_REPLY).toContain("988");
  });

  it("refusal without stop_details: category null", async () => {
    deps.llm.push(response([], "refusal"));
    const out = await runAgent(deps, input({ messages: [await claimed("question")] }));
    expect(out.mode).toBe("safety");
    expect(out.refusalCategory).toBeNull();
  });

  it("max_tokens: retries once with max_tokens doubled, then the canned reply", async () => {
    deps.llm.push(response([], "max_tokens"), response([], "max_tokens"));
    const out = await runAgent(deps, input({ messages: [await claimed("long question")] }));
    expect(deps.llm.requests).toHaveLength(2);
    const [a, b] = deps.llm.requests.map((r) => r.params);
    expect(a.max_tokens).toBe(policy.agent.mainMaxTokens);
    expect(b.max_tokens).toBe(Math.min(policy.agent.mainMaxTokens * 2, MAX_TOKENS_RETRY_CAP));
    expect(b.messages).toEqual(a.messages);
    expect(out.bubbles).toEqual([AGENT_ERROR_REPLY]);
    expect(out.stopReason).toBe("max_tokens");
    expect(out.usage.map((u) => u.stopReason)).toEqual(["max_tokens", "max_tokens"]);
  });

  it("max_tokens then end_turn: uses the retried answer and never runs tools from the truncated one", async () => {
    deps.llm.push(
      response([{ type: "tool_use", id: "toolu_1", name: "log_meal", input: {}, caller: { type: "direct" } }], "max_tokens"),
      textMessage("Here you go."),
    );
    const out = await runAgent(deps, input({ messages: [await claimed("q")] }));
    expect(out.bubbles).toEqual(["Here you go."]);
    expect(deps.llm.requests[1].params.messages).toEqual(deps.llm.requests[0].params.messages);
  });

  it("pause_turn: appends the content verbatim and continues", async () => {
    const paused = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Working on it", citations: null },
    ];
    deps.llm.push(response(paused, "pause_turn"), textMessage("All set."));
    const out = await runAgent(deps, input({ messages: [await claimed("q")] }));
    expect(deps.llm.requests).toHaveLength(2);
    const [a, b] = deps.llm.requests.map((r) => r.params);
    expect(b.messages).toEqual([...a.messages, { role: "assistant", content: paused }]);
    expect(out.bubbles).toEqual(["All set."]);
    expect(out.usage).toHaveLength(2);
  });

  it("an unhandled stop reason: canned reply", async () => {
    deps.llm.push(response([{ type: "text", text: "cut", citations: null }], "model_context_window_exceeded"));
    const out = await runAgent(deps, input({ messages: [await claimed("q")] }));
    expect(out.bubbles).toEqual([AGENT_ERROR_REPLY]);
    expect(out.stopReason).toBe("error:unexpected_stop");
    expect(out.usage[0].stopReason).toBe("model_context_window_exceeded");
  });

  it("tool_use with no tools registered: canned reply, no further call", async () => {
    deps.llm.push(
      response([{ type: "tool_use", id: "toolu_1", name: "log_meal", input: {}, caller: { type: "direct" } }], "tool_use"),
    );
    const out = await runAgent(deps, input({ messages: [await claimed("log this")] }));
    expect(deps.llm.requests).toHaveLength(1);
    expect(out.bubbles).toEqual([AGENT_ERROR_REPLY]);
    expect(out.stopReason).toBe("tool_use");
  });

  it("a thrown error: one canned bubble", async () => {
    deps.llm.push(new Error("boom"));
    const out = await runAgent(deps, input({ messages: [await claimed("hi")] }));
    expect(out.bubbles).toEqual([AGENT_ERROR_REPLY]);
    expect(out.mode).toBe("agent");
    expect(out.stopReason).toBe("error:unknown");
  });

  it("a spend-cap error: canned reply, no retry by the loop", async () => {
    deps.llm.push(new LlmCallError("spend_cap", { retryable: false, status: 429 }));
    const out = await runAgent(deps, input({ messages: [await claimed("hi")] }));
    expect(deps.llm.requests).toHaveLength(1);
    expect(out.bubbles).toEqual([AGENT_ERROR_REPLY]);
    expect(out.stopReason).toBe("error:spend_cap");
  });

  it("an aborted turn rethrows instead of replying", async () => {
    const ac = new AbortController();
    deps.llm.push(() => {
      ac.abort(new Error("lease lost"));
      throw new Error("request aborted");
    });
    await expect(runAgent(deps, input({ messages: [await claimed("hi")], signal: ac.signal }))).rejects.toThrow();
    const pre = new AbortController();
    pre.abort(new Error("already gone"));
    await expect(runAgent(deps, input({ messages: [await claimed("hi")], signal: pre.signal }))).rejects.toThrow(
      "already gone",
    );
  });
});

describe("runAgent bubble fitting", () => {
  const long = (n: number) =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}: ${"lots of words about the meal ".repeat(9).trim()}.`).join(
      "\n\n",
    );

  it("asks once to shorten via a mid-conversation system message, then uses the shorter reply", async () => {
    deps.llm.push(textMessage(long(5)), textMessage("Short version.\n\nOne more thing."));
    const out = await runAgent(deps, input({ messages: [await claimed("tell me everything")] }));
    expect(deps.llm.requests).toHaveLength(2);
    const [a, b] = deps.llm.requests.map((r) => r.params);
    // Same append-only transcript plus the note; the long draft is not sent back.
    expect(b.messages).toEqual([...a.messages, { role: "system", content: SHORTEN_NOTE }]);
    expect(b.system).toEqual(a.system);
    expect(out.bubbles).toEqual(["Short version.", "One more thing."]);
    expect(out.usage).toHaveLength(2);
  });

  it("keeps the first bubbles (whole bubbles only) when the retry is still too long", async () => {
    const text = long(5);
    deps.llm.push(textMessage(text), textMessage(text));
    const out = await runAgent(deps, input({ messages: [await claimed("tell me everything")] }));
    expect(out.bubbles).toHaveLength(policy.format.maxBubbles);
    for (const b of out.bubbles) {
      expect(b.length).toBeLessThanOrEqual(policy.format.maxBubbleChars);
      expect(text).toContain(b);
    }
    expect(out.bubbles[0].startsWith("Paragraph 1:")).toBe(true);
  });

  it("moves the note into the user turn when the model rejects role:system messages (400)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejected = new LlmCallError("bad_request", { retryable: false, status: 400 });
    deps.llm.push(textMessage(long(5)), rejected, textMessage("Short version."));
    const out = await runAgent(deps, input({ messages: [await claimed("tell me everything")] }));
    expect(deps.llm.requests).toHaveLength(3);
    const [a, , c] = deps.llm.requests.map((r) => r.params);
    // Same transcript; the final user message gains one trailing note block and nothing else changes.
    expect(c.messages.slice(0, -1)).toEqual(a.messages.slice(0, -1));
    const before = a.messages[a.messages.length - 1];
    const after = c.messages[c.messages.length - 1];
    expect(after.role).toBe("user");
    expect(after.content).toEqual([
      ...(Array.isArray(before.content) ? before.content : []),
      { type: "text", text: `${SYSTEM_NOTE_HEADER}\n${SHORTEN_NOTE}` },
    ]);
    expect(c.messages.some((m) => m.role === "system")).toBe(false);
    expect(out.bubbles).toEqual(["Short version."]);
    expect(out.usage).toHaveLength(2);
  });

  it("falls back to the truncated first draft when the shorten retry fails", async () => {
    deps.llm.push(textMessage(long(5)), new Error("boom"));
    const out = await runAgent(deps, input({ messages: [await claimed("tell me everything")] }));
    expect(out.bubbles).toHaveLength(policy.format.maxBubbles);
    expect(out.bubbles[0].startsWith("Paragraph 1:")).toBe(true);
    expect(out.mode).toBe("agent");
  });
});

describe("withUserNote", () => {
  const note = { type: "text", text: `${SYSTEM_NOTE_HEADER}\nbe brief` };

  it("appends the note to a string-content final user message without touching the input", () => {
    const transcript = [{ role: "user" as const, content: "hi" }];
    expect(withUserNote(transcript, "be brief")).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }, note] }]);
    expect(transcript).toEqual([{ role: "user", content: "hi" }]);
  });

  it("adds a user message when the transcript ends on the assistant", () => {
    const transcript = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "paused" },
    ];
    expect(withUserNote(transcript, "be brief")).toEqual([...transcript, { role: "user", content: [note] }]);
  });
});
