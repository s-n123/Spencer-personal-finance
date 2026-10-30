import type { TurnIterationUsage, users } from "@/server/db/schema";
import type { Deps } from "@/server/deps";

// Contracts between the pipeline, media and agent modules. The pipeline only calls these
// functions through `deps.pipeline`, so each module can be built and tested in isolation.

export type UserRow = typeof users.$inferSelect;

/** An inbound message claimed into a turn. */
export interface ClaimedMessage {
  id: string;
  provider: string;
  providerMessageId: string;
  text: string | null;
  keyword: string | null;
  crisisKind: string | null;
  sentAt: Date;
  receivedAt: Date;
}

/** A stored, resized, EXIF-stripped JPEG ready to send to the model. */
export interface ReadyImage {
  mediaId: string;
  inboundMessageId: string;
  /** Label used in the prompt: img1, img2, ... in message order. */
  ref: string;
  base64: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
}

export interface MediaReadiness {
  ready: ReadyImage[];
  /** Media that could not be downloaded/processed; the model is told to ask for a resend. */
  failed: { mediaId: string; inboundMessageId: string }[];
}

/** Downloads, converts and stores the given media rows (single-flight; safe to call repeatedly). */
export type PrefetchMediaFn = (deps: Deps, mediaIds: string[], signal: AbortSignal) => Promise<void>;

/**
 * Waits briefly for in-flight downloads of the claimed messages' media, processes any it can claim
 * itself, and returns what is ready plus what failed.
 */
export type EnsureMediaFn = (deps: Deps, inboundMessageIds: string[], signal: AbortSignal) => Promise<MediaReadiness>;

export interface AgentTurnInput {
  user: UserRow;
  turnId: string;
  /** Turn clock: max(sent_at) of the claimed messages. */
  turnClock: Date;
  /** Effective IANA timezone (user, simulator or DEFAULT_TIMEZONE). */
  timezone: string;
  messages: ClaimedMessage[];
  images: ReadyImage[];
  failedImageCount: number;
  /** Aborts on lease loss or deadline. */
  signal: AbortSignal;
  /** Invocation deadline (epoch ms); LLM timeouts derive from it. */
  deadlineMs: number;
}

export interface AgentTurnOutput {
  /** Final user-facing bubbles: plain text, at most 3, each at most 300 chars. */
  bubbles: string[];
  mode: "agent" | "safety";
  stopReason: string | null;
  refusalCategory: string | null;
  usage: TurnIterationUsage[];
  /** Code-written one-liners stored on media rows for future history ("[photo 12:40: ...]"). */
  mediaSummaries: { mediaId: string; summary: string; kind: string | null }[];
}

export type RunAgentFn = (deps: Deps, input: AgentTurnInput) => Promise<AgentTurnOutput>;

export interface PipelineHandlers {
  prefetchMedia: PrefetchMediaFn;
  ensureMedia: EnsureMediaFn;
  runAgent: RunAgentFn;
}
