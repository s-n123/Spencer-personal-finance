// Product tunables. These are reviewable in diffs and tested; secrets and wiring live in env.ts.
// Values marked REVIEW are ones SPEC.md asks the owner to review (see DECISIONS.md).

export const policy = {
  pipeline: {
    /** SPEC Architecture 3: debounce ~4 s per user, measured from the newest message. */
    debounceMs: 4_000,
    /** Cap from the first message of a burst so a long stream still gets answered. */
    maxDebounceMs: 15_000,
    /** Lease TTL; renewed every heartbeatMs. A holder that misses renewals is presumed dead. */
    leaseTtlMs: 45_000,
    heartbeatMs: 15_000,
    /** A lease with more than this left is "fresh": a live holder will see our message on recheck. */
    freshLeaseThresholdMs: 25_000,
    /** Max attempts to take over a lease that is close to expiry. */
    acquireAttempts: 3,
    /** Function deadline (Vercel Hobby max). */
    maxDurationMs: 300_000,
    /** Don't start a turn with less than this left; hand off instead. */
    minTurnBudgetMs: 150_000,
    /** Reserved after the agent for sends and bookkeeping. */
    sendReserveMs: 30_000,
    perSendTimeoutMs: 10_000,
    /** Opportunistic sweep: rows older than this with an expired lease are re-driven. */
    sweepStaleAfterMs: 30_000,
    sweepBatch: 5,
    /** Media prefetch. */
    mediaDownloadTimeoutMs: 15_000,
    mediaMaxBytes: 25 * 1024 * 1024,
    mediaClaimMs: 60_000,
    mediaMaxAttempts: 3,
    ensureMediaWaitMs: 20_000,
    ensureTriageWaitMs: 5_000,
    maxImagesPerTurn: 6,
  },
  agent: {
    maxIterations: 6,
    mainMaxTokens: 8_000,
    fastMaxTokens: 1_024,
    llmCallTimeoutMs: 60_000,
    /** Each call's timeout is min(llmCallTimeoutMs, remaining - llmDeadlineMarginMs). */
    llmDeadlineMarginMs: 45_000,
    /** Retries only when this much time remains. */
    llmRetryMinRemainingMs: 150_000,
    historyExchanges: 12,
  },
  format: {
    maxBubbles: 3,
    maxBubbleChars: 300,
  },
  media: {
    /** Anthropic high-resolution tier (Claude 4.7+): long edge and visual-token budget. */
    maxEdge: 2_576,
    maxVisualTokens: 4_784,
    jpegQuality: 85,
    retentionDays: 30,
  },
  messages: {
    textRetentionDays: 90,
  },
  /** Simulator users get these fictional numbers only: +1 NPA 555-01XX. */
  simulator: {
    defaultPhone: "+12015550100",
  },
} as const;

export type Policy = typeof policy;
