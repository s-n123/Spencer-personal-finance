import { policy } from "@/server/config/policy";
import type { TurnIterationUsage } from "@/server/db/schema";
import { log } from "@/server/log";
import type { AgentTurnInput, AgentTurnOutput, ReadyImage, RunAgentFn, UserRow } from "@/server/pipeline/contracts";
import { crisisLifeline, crisisTextLine } from "@/server/safety/resources";
import { formatLocalHourMinute, renderContext, type TimezoneSource } from "./context";
import { LlmCallError } from "./errors";
import { formatBubbles } from "./format";
import { loadHistory, type HistoryMessage } from "./history";
import { runLoop, type LoopInput, type LoopOutcome } from "./loop";
import type { ContentBlockParam, MessageParam } from "./types";

// One agent turn (PLAN §4, M1 scope): text-only history, then a final user message of
// [context block, labelled images, caption], run through the loop, formatted into bubbles.
// No tools are registered in M1; the loop is ready for them.

/** One bubble for any failure that leaves us without a usable reply. */
export const AGENT_ERROR_REPLY = "Sorry — I hit a snag on my end. Try again in a minute?";

/** A refusal that survives the server-side fallback gets caring copy, never the partial output. */
export const REFUSAL_REPLY =
  `Sorry, I can't help with that one. If something is weighing on you, you can call or text ` +
  `${crisisLifeline.number} anytime, or text ${crisisTextLine.keyword} to ${crisisTextLine.number}. ` +
  `I'm happy to keep helping with food and nutrition.`;

/** Appended as a mid-conversation system message for the one "shorten" retry. */
export const SHORTEN_NOTE =
  `Your draft reply to this message was too long to send. Write it again as at most ` +
  `${policy.format.maxBubbles} short bubbles, each under ${policy.format.maxBubbleChars} characters, ` +
  `separated by blank lines. Keep the key points and the same meaning.`;

/** First line of the user-turn form of the note, for models that reject role:"system" messages. */
export const SYSTEM_NOTE_HEADER = "[Note from the system, not written by the user]";

export const runAgent: RunAgentFn = async (deps, input) => {
  input.signal.throwIfAborted();
  const userId = input.user.id;
  const history = await loadHistory(deps.db, {
    userId,
    turnId: input.turnId,
    excludeInboundIds: input.messages.map((m) => m.id),
  });
  const context = renderContext({
    turnClock: input.turnClock,
    timezone: input.timezone,
    timezoneSource: timezoneSource(input.user, input.timezone),
    userStatus: input.user.status,
    imageRefs: input.images.map((img) => img.ref),
    failedImageCount: input.failedImageCount,
  });
  const messages = withTurnMessage(history, buildTurnContent(context, input.images, captionOf(input)));

  const base: Omit<LoopInput, "messages" | "maxIterations"> = {
    model: deps.models.main,
    effort: deps.models.mainEffort,
    maxTokens: policy.agent.mainMaxTokens,
    userId,
    tools: [],
    signal: input.signal,
    deadlineMs: input.deadlineMs,
  };
  const first = await runLoop(deps, { ...base, messages, maxIterations: policy.agent.maxIterations });
  const usage = [...first.usage];
  const mediaSummaries = summarizeMedia(input);
  const logFields = { userId, turnId: input.turnId };

  if (first.outcome.kind !== "text") {
    return cannedOutput(first.outcome, first.stopReason, usage, mediaSummaries, logFields);
  }

  let formatted = formatBubbles(first.outcome.text);
  let stopReason = first.stopReason;
  if (formatted.bubbles.length === 0) {
    // Markup only ("---", an empty code fence): nothing would be sent, so the user gets the canned reply.
    const empty = new LlmCallError("empty_reply", { retryable: false });
    return cannedOutput({ kind: "error", error: empty }, first.stopReason, usage, mediaSummaries, logFields);
  }
  if (formatted.overflow) {
    // One retry from the same append-only transcript (the long draft is not sent back).
    let retry = await runLoop(deps, {
      ...base,
      messages: [...first.transcript, { role: "system", content: SHORTEN_NOTE }],
      maxIterations: 1,
    });
    usage.push(...retry.usage);
    if (retry.outcome.kind === "error" && retry.outcome.error.kind === "bad_request") {
      // A model without mid-conversation system messages 400s on them: Claude Sonnet 5, where the
      // server-side fallback routes (and then sticks for ~1 h). Anthropic's documented fallback is
      // the same note in the user turn.
      retry = await runLoop(deps, { ...base, messages: withUserNote(first.transcript, SHORTEN_NOTE), maxIterations: 1 });
      usage.push(...retry.usage);
    }
    if (retry.outcome.kind === "text") {
      const shorter = formatBubbles(retry.outcome.text);
      if (shorter.bubbles.length > 0) {
        formatted = shorter;
        stopReason = retry.stopReason;
      }
    }
    if (formatted.overflow) {
      log.warn("agent.reply_truncated", { ...logFields, count: formatted.bubbles.length });
      formatted = { bubbles: formatted.bubbles.slice(0, policy.format.maxBubbles), overflow: false };
    }
  }

  log.info("agent.turn_done", { ...logFields, iterations: usage.length, stopReason, count: formatted.bubbles.length });
  return {
    bubbles: formatted.bubbles,
    mode: "agent",
    stopReason,
    refusalCategory: null,
    usage,
    mediaSummaries,
  };
};

function cannedOutput(
  outcome: Exclude<LoopOutcome, { kind: "text" }>,
  lastStopReason: string | null,
  usage: TurnIterationUsage[],
  mediaSummaries: AgentTurnOutput["mediaSummaries"],
  logFields: { userId: string; turnId: string },
): AgentTurnOutput {
  if (outcome.kind === "refusal") {
    log.warn("agent.refusal", { ...logFields, refusalCategory: outcome.category ?? "none" });
    return {
      bubbles: [REFUSAL_REPLY],
      mode: "safety",
      stopReason: "refusal",
      refusalCategory: outcome.category,
      usage,
      mediaSummaries,
    };
  }
  const reason = outcome.kind === "error" ? outcome.error.kind : outcome.kind;
  log.warn("agent.canned_reply", { ...logFields, reason, stopReason: lastStopReason });
  return {
    bubbles: [AGENT_ERROR_REPLY],
    mode: "agent",
    stopReason: outcome.kind === "error" ? `error:${outcome.error.kind}` : lastStopReason,
    refusalCategory: null,
    usage,
    mediaSummaries,
  };
}

/** Context first, then each image after its label, then the caption (images before text). */
export function buildTurnContent(context: string, images: ReadyImage[], caption: string | null): ContentBlockParam[] {
  const content: ContentBlockParam[] = [{ type: "text", text: context }];
  for (const img of images) {
    content.push({ type: "text", text: `${img.ref}:` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  }
  if (caption) content.push({ type: "text", text: caption });
  return content;
}

/**
 * Appends this turn's user message. If history ends on an unanswered user message, its text is
 * folded into this one as a leading block so roles keep alternating.
 */
export function withTurnMessage(history: HistoryMessage[], content: ContentBlockParam[]): MessageParam[] {
  const messages: MessageParam[] = history.slice(0, -1);
  const last = history[history.length - 1];
  if (last?.role === "user") {
    messages.push({ role: "user", content: [{ type: "text", text: last.content }, ...content] });
  } else {
    if (last) messages.push(last);
    messages.push({ role: "user", content });
  }
  return messages;
}

/** The note as a trailing text block of the final user message (a new user message if needed). */
export function withUserNote(transcript: MessageParam[], note: string): MessageParam[] {
  const block: ContentBlockParam = { type: "text", text: `${SYSTEM_NOTE_HEADER}\n${note}` };
  const messages = [...transcript];
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    const content: ContentBlockParam[] =
      typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
    messages[messages.length - 1] = { role: "user", content: [...content, block] };
  } else {
    messages.push({ role: "user", content: [block] });
  }
  return messages;
}

function captionOf(input: AgentTurnInput): string | null {
  const texts = input.messages.map((m) => m.text?.trim() ?? "").filter((t) => t.length > 0);
  return texts.length > 0 ? texts.join("\n") : null;
}

function timezoneSource(user: UserRow, effective: string): TimezoneSource {
  if (!user.timezone || user.timezone !== effective) return "default";
  return user.timezoneSource === "user" || user.timezoneSource === "simulator" ? user.timezoneSource : "default";
}

/** M1 notes carry only the time; M2 writes "[photo 12:40: logged …]" from the tool that used it. */
function summarizeMedia(input: AgentTurnInput): AgentTurnOutput["mediaSummaries"] {
  const sentAt = new Map(input.messages.map((m) => [m.id, m.sentAt]));
  return input.images.map((img) => ({
    mediaId: img.mediaId,
    summary: `[photo ${formatLocalHourMinute(sentAt.get(img.inboundMessageId) ?? input.turnClock, input.timezone)}]`,
    kind: null,
  }));
}
