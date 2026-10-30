import { policy } from "@/server/config/policy";

// Turns model text into iMessage bubbles. iMessage renders no markdown, so markers are stripped
// and lists become sentences. Bubbles are split on blank lines, long ones are cut at sentence and
// then word boundaries, and the result is fitted to the bubble cap by MERGING neighbours. Text is
// never dropped here: if it can't fit, `overflow` is set and the caller decides (one "shorten"
// retry, then a logged truncation by whole bubbles).

export interface FormatLimits {
  maxBubbles: number;
  maxBubbleChars: number;
}

export interface FormattedBubbles {
  bubbles: string[];
  /** True when the text needs more than maxBubbles bubbles; `bubbles` then holds all of it. */
  overflow: boolean;
}

const DEFAULT_LIMITS: FormatLimits = {
  maxBubbles: policy.format.maxBubbles,
  maxBubbleChars: policy.format.maxBubbleChars,
};

/** Joins two bubbles merged into one; a line break keeps the paragraph boundary visible. */
const MERGE_SEPARATOR = "\n";

export function formatBubbles(text: string, limits: FormatLimits = DEFAULT_LIMITS): FormattedBubbles {
  const paragraphs = normalizeWhitespace(stripMarkdown(text))
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const pieces = paragraphs.flatMap((p) => splitLong(p, limits.maxBubbleChars));
  return fitBubbles(pieces, limits.maxBubbles, limits.maxBubbleChars);
}

/**
 * Reserves slots for code-owned bubbles (the totals line, safety copy) that are always sent last
 * and never merged with model text. The model's bubbles are fitted into the remaining slots.
 */
export function appendCodeBubbles(
  modelBubbles: string[],
  codeBubbles: string[],
  limits: FormatLimits = DEFAULT_LIMITS,
): FormattedBubbles {
  const slots = Math.max(0, limits.maxBubbles - codeBubbles.length);
  const fitted = fitBubbles(modelBubbles, slots, limits.maxBubbleChars);
  const overflow = fitted.overflow || codeBubbles.length > limits.maxBubbles;
  return { bubbles: [...fitted.bubbles, ...codeBubbles], overflow };
}

/** Merges adjacent bubbles (smallest combined pair first) until at most maxCount remain. */
export function fitBubbles(bubbles: string[], maxCount: number, maxChars: number): FormattedBubbles {
  const out = bubbles.filter((b) => b.length > 0);
  while (out.length > maxCount) {
    let best = -1;
    let bestLen = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const len = out[i].length + MERGE_SEPARATOR.length + out[i + 1].length;
      if (len <= maxChars && len < bestLen) {
        best = i;
        bestLen = len;
      }
    }
    if (best < 0) return { bubbles: out, overflow: true };
    out.splice(best, 2, `${out[best]}${MERGE_SEPARATOR}${out[best + 1]}`);
  }
  return { bubbles: out, overflow: false };
}

export function stripMarkdown(input: string): string {
  let text = input.replace(/\r\n?/g, "\n");
  // Fenced code: keep the content, drop the fence lines.
  text = text.replace(/^[ \t]*(```|~~~)[^\n]*\n?/gm, "");
  // Images and links: [label](url) -> "label (url)", or just the url when they match.
  text = text.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
    const l = label.trim();
    return !l || l === url ? url : `${l} (${url})`;
  });
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1").replace(/`/g, "");
  // Horizontal rules become paragraph breaks before emphasis runs, which would turn "***" into "*".
  text = text.replace(/^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/gm, "");
  // Emphasis. Markers must hug non-space text so "2 * 3" and snake_case survive.
  text = text.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1");
  text = text.replace(/__(?=\S)([^\n]*?\S)__/g, "$1");
  text = text.replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");
  text = text.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1");
  text = text.replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1");
  return listsToSentences(text.split("\n")).join("\n");
}

const HEADER = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST_ITEM = /^\s*(?:[-*+•‣◦▪●]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** List items become sentences appended to the paragraph they belong to. */
function listsToSentences(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    if (RULE.test(raw) || TABLE_DIVIDER.test(raw)) {
      out.push("");
      continue;
    }
    let line = raw.replace(QUOTE, "");
    const header = HEADER.exec(line);
    if (header) {
      out.push(asSentence(header[1]));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .join(", ");
    }
    const item = LIST_ITEM.exec(line);
    if (!item) {
      out.push(line);
      continue;
    }
    const sentence = asSentence(item[1]);
    if (!sentence) continue;
    const prev = out.length > 0 ? out[out.length - 1] : "";
    if (prev.trim().length > 0) out[out.length - 1] = `${prev.trimEnd()} ${sentence}`;
    else out.push(sentence);
  }
  return out;
}

function asSentence(fragment: string): string {
  let s = fragment.trim();
  if (!s) return "";
  // "iPhone" and "eBay" keep their casing.
  if (!/^\p{Ll}\p{Lu}/u.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  if (/[,;:]$/.test(s)) s = `${s.slice(0, -1)}.`;
  else if (!/[.!?…]["')\]]?$/.test(s) && !/\p{Extended_Pictographic}\uFE0F?$/u.test(s)) s = `${s}.`;
  return s;
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n\n")
    .map((paragraph) => paragraph.replace(/\n/g, " ").trim())
    .join("\n\n")
    .trim();
}

/** Splits one paragraph into pieces of at most maxChars, at sentence then word boundaries. */
function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = splitSentences(paragraph).flatMap((s) => (s.length <= maxChars ? [s] : splitWords(s, maxChars)));
  return pack(sentences, maxChars, " ");
}

/** Splits after terminal punctuation followed by a space, so "1.5 cups" stays whole. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…]["')\]]*) +/).filter((s) => s.length > 0);
}

function splitWords(sentence: string, maxChars: number): string[] {
  // A single token longer than a bubble (a long URL) is the one case that must be cut.
  const words = sentence.split(" ").flatMap((w) => {
    if (w.length <= maxChars) return [w];
    const chunks: string[] = [];
    for (let i = 0; i < w.length; ) {
      let end = Math.min(i + maxChars, w.length);
      // Never between the halves of a surrogate pair: a lone surrogate is invalid on the wire.
      if (end < w.length && end - i > 1 && isHighSurrogate(w.charCodeAt(end - 1))) end -= 1;
      chunks.push(w.slice(i, end));
      i = end;
    }
    return chunks;
  });
  return pack(words, maxChars, " ");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function pack(units: string[], maxChars: number, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) current = unit;
    else if (current.length + separator.length + unit.length <= maxChars) current = `${current}${separator}${unit}`;
    else {
      out.push(current);
      current = unit;
    }
  }
  if (current) out.push(current);
  return out;
}
