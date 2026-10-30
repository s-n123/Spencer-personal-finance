import { describe, expect, it } from "vitest";
import { policy } from "@/server/config/policy";
import { appendCodeBubbles, fitBubbles, formatBubbles, stripMarkdown } from "./format";

const MAX = policy.format.maxBubbleChars;

/** Words of the input, in order, so tests can assert nothing was dropped or reordered. */
function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function sentence(i: number, len = 90): string {
  const base = `Sentence number ${i} talks about grilled chicken, rice and roasted broccoli`;
  return `${base}${" and more".repeat(Math.max(0, Math.ceil((len - base.length) / 9)))}.`.slice(-len);
}

describe("stripMarkdown", () => {
  it.each([
    ["**bold** and __strong__", "bold and strong"],
    ["*italic* and _soft_", "italic and soft"],
    ["~~gone~~ here", "gone here"],
    ["use `code` here", "use code here"],
    ["## Lunch\nLooks great", "Lunch.\nLooks great"],
    ["see [the menu](https://example.com/menu)", "see the menu (https://example.com/menu)"],
    ["[https://example.com](https://example.com)", "https://example.com"],
    ["visit <https://example.com>", "visit https://example.com"],
    ["> quoted line", "quoted line"],
  ])("%j -> %j", (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });

  it("keeps arithmetic asterisks, snake_case and decimals intact", () => {
    expect(stripMarkdown("2 * 3 = 6 and snake_case_name, 1.5 cups")).toBe("2 * 3 = 6 and snake_case_name, 1.5 cups");
  });

  it("drops code fences but keeps their content", () => {
    expect(stripMarkdown("Try this:\n```text\nhello there\n```\nok")).toBe("Try this:\nhello there\nok");
  });

  it("turns bullet lists into sentences on the preceding line", () => {
    expect(stripMarkdown("Here's what I see:\n- grilled chicken\n- white rice\n* broccoli!")).toBe(
      "Here's what I see: Grilled chicken. White rice. Broccoli!",
    );
  });

  it("doesn't add a period after an emoji", () => {
    expect(stripMarkdown("Ideas:\n- more veggies 🥦\n- water ❤️")).toBe("Ideas: More veggies 🥦 Water ❤️");
  });

  it("turns numbered lists into sentences", () => {
    expect(stripMarkdown("1. Eat breakfast,\n2) Drink water")).toBe("Eat breakfast. Drink water.");
  });

  it("removes horizontal rules", () => {
    expect(stripMarkdown("one\n---\ntwo")).toBe("one\n\ntwo");
  });

  it.each(["***", "___", "* * *", "_ _ _"])("removes a %j rule without leaving a marker behind", (rule) => {
    expect(stripMarkdown(`Nice!\n${rule}\nMore`)).toBe("Nice!\n\nMore");
  });

  it("keeps the casing of words like iPhone when a list item becomes a sentence", () => {
    expect(stripMarkdown("Tips:\n- iPhone photos work\n- eBay finds")).toBe("Tips: iPhone photos work. eBay finds.");
  });
});

describe("formatBubbles", () => {
  it("splits bubbles on blank lines and normalizes whitespace", () => {
    const r = formatBubbles("  Nice lunch!  \n\n\n\nThat looks   like\na grain bowl.\n\nWhat dressing?  ");
    expect(r).toEqual({ bubbles: ["Nice lunch!", "That looks like a grain bowl.", "What dressing?"], overflow: false });
  });

  it("returns plain text with no markdown markers", () => {
    const r = formatBubbles("**Great pick!** Here's the plate:\n- *salmon*\n- `rice`\n\n### Tip\nAdd greens.");
    expect(r.overflow).toBe(false);
    for (const b of r.bubbles) expect(b).not.toMatch(/[*`#]|^\s*-\s/m);
    expect(r.bubbles.join(" ")).toContain("Great pick! Here's the plate: Salmon. Rice.");
  });

  it("returns no bubbles for empty or whitespace-only text", () => {
    expect(formatBubbles("  \n\n ")).toEqual({ bubbles: [], overflow: false });
  });

  it("merges adjacent short bubbles to fit the bubble cap without dropping any", () => {
    const text = ["One.", "Two.", "Three.", "Four.", "Five."].join("\n\n");
    const r = formatBubbles(text);
    expect(r.overflow).toBe(false);
    expect(r.bubbles.length).toBeLessThanOrEqual(policy.format.maxBubbles);
    expect(words(r.bubbles.join(" "))).toEqual(words(text));
  });

  it("merges the smallest adjacent pair first", () => {
    const long = "x".repeat(250);
    expect(fitBubbles([long, "a", "b", long], 3, MAX)).toEqual({ bubbles: [long, "a\nb", long], overflow: false });
  });

  it("splits a long paragraph at sentence boundaries, each piece within the limit", () => {
    const paragraph = Array.from({ length: 6 }, (_, i) => sentence(i, 90)).join(" ");
    expect(paragraph.length).toBeGreaterThan(MAX);
    const r = formatBubbles(paragraph);
    for (const b of r.bubbles) {
      expect(b.length).toBeLessThanOrEqual(MAX);
      expect(b.endsWith(".")).toBe(true);
    }
    expect(words(r.bubbles.join(" "))).toEqual(words(paragraph));
  });

  it("keeps decimals whole when splitting sentences", () => {
    const paragraph = `${"Some filler words here. ".repeat(10)}About 1.5 cups of rice. ${"More filler words. ".repeat(8)}`;
    const r = formatBubbles(paragraph);
    expect(r.bubbles.some((b) => b.includes("1.5 cups"))).toBe(true);
  });

  it("falls back to word boundaries for a single sentence over the limit, never mid-word", () => {
    const longSentence = `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")}.`;
    const r = formatBubbles(longSentence);
    for (const b of r.bubbles) expect(b.length).toBeLessThanOrEqual(MAX);
    expect(words(r.bubbles.join(" "))).toEqual(words(longSentence));
  });

  it("never cuts an over-long token between the halves of an emoji", () => {
    for (const token of ["😀".repeat(200), `${"a".repeat(MAX - 1)}😀${"b".repeat(10)}`]) {
      const r = formatBubbles(token);
      expect(r.bubbles.join("")).toBe(token);
      for (const b of r.bubbles) {
        expect(b.length).toBeLessThanOrEqual(MAX);
        // A lone surrogate is not well-formed UTF-16 (it would be mangled on the wire).
        expect(b.isWellFormed()).toBe(true);
      }
    }
  });

  it("returns no bubbles for markdown-only text (the caller must not send an empty reply)", () => {
    expect(formatBubbles("---").bubbles).toEqual([]);
    expect(formatBubbles("```\n```").bubbles).toEqual([]);
  });

  it("flags overflow and keeps every word when the text cannot fit", () => {
    const text = Array.from({ length: 5 }, (_, i) => sentence(i, 280)).join("\n\n");
    const r = formatBubbles(text);
    expect(r.overflow).toBe(true);
    expect(r.bubbles.length).toBe(5);
    expect(words(r.bubbles.join(" "))).toEqual(words(text));
  });

  it("honors custom limits", () => {
    const r = formatBubbles("a b c d e f", { maxBubbles: 2, maxBubbleChars: 5 });
    expect(r).toEqual({ bubbles: ["a b c", "d e f"], overflow: false });
  });
});

describe("appendCodeBubbles", () => {
  it("reserves slots for code bubbles and keeps them last and unmerged", () => {
    const code = ["Today: totals line"];
    const r = appendCodeBubbles(["One.", "Two.", "Three."], code);
    expect(r.overflow).toBe(false);
    expect(r.bubbles.length).toBe(policy.format.maxBubbles);
    expect(r.bubbles[r.bubbles.length - 1]).toBe(code[0]);
    expect(words(r.bubbles.slice(0, -1).join(" "))).toEqual(["One.", "Two.", "Three."]);
  });

  it("flags overflow when the model bubbles can't fit the remaining slots", () => {
    const big = "y".repeat(280);
    const r = appendCodeBubbles([big, big, big], ["code"]);
    expect(r.overflow).toBe(true);
    expect(r.bubbles).toEqual([big, big, big, "code"]);
  });
});
