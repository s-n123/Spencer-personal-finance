import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { formatBubbles } from "./format";
import { describeTurn, jpegSize, OfflineDemoLlm } from "./offline-llm";
import { CONTEXT_HEADER } from "./context";
import type { ContentBlockParam, LlmRequest } from "./types";

async function jpeg(width: number, height: number): Promise<string> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 160, b: 90 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
  return buf.toString("base64");
}

function request(content: ContentBlockParam[]): LlmRequest {
  return { model: "claude-sonnet-5-5", max_tokens: 8000, messages: [{ role: "user", content }] };
}

const opts = () => ({ signal: new AbortController().signal, timeoutMs: 60_000, maxRetries: 0 });

describe("jpegSize", () => {
  it("reads dimensions from a real JPEG", async () => {
    expect(jpegSize(await jpeg(1456, 1092))).toEqual({ width: 1456, height: 1092 });
  });

  it("returns null for non-JPEG data", () => {
    expect(jpegSize(Buffer.from("not an image").toString("base64"))).toBeNull();
  });
});

describe("OfflineDemoLlm", () => {
  it("describes the photos and note it received, as plain text", async () => {
    const data = await jpeg(1456, 1092);
    const res = await new OfflineDemoLlm().create(
      request([
        { type: "text", text: `${CONTEXT_HEADER}\nPhotos attached: 1 (img1)` },
        { type: "text", text: "img1:" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        { type: "text", text: "my lunch" },
      ]),
      opts(),
    );
    expect(res.stop_reason).toBe("end_turn");
    const block = res.content[0];
    expect(block.type).toBe("text");
    const text = block.type === "text" ? block.text : "";
    expect(text).toBe(
      "I got 1 photo (1456x1092) and your note. Live photo analysis needs an ANTHROPIC_API_KEY — set it in .env.local with LLM_PROVIDER=anthropic.",
    );
    // Already plain text that fits one bubble.
    expect(formatBubbles(text)).toEqual({ bubbles: [text], overflow: false });
  });

  it("handles several photos and no caption", () => {
    const text = describeTurn([
      { type: "text", text: CONTEXT_HEADER },
      { type: "text", text: "img1:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      { type: "text", text: "img2:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
    ]);
    expect(text).toMatch(/^I got 2 photos \(unknown size, unknown size\)\. /);
    expect(text).not.toContain("note");
  });

  it("answers a text-only message", async () => {
    const res = await new OfflineDemoLlm().create(request([{ type: "text", text: "hi" }]), opts());
    const block = res.content[0];
    expect(block.type === "text" && block.text.startsWith("I got your message.")).toBe(true);
  });

  it("honors an aborted signal", async () => {
    const ac = new AbortController();
    ac.abort(new Error("lease lost"));
    await expect(
      new OfflineDemoLlm().create(request([{ type: "text", text: "hi" }]), { ...opts(), signal: ac.signal }),
    ).rejects.toThrow("lease lost");
  });
});
