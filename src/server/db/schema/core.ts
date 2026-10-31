import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Conventions (CLAUDE.md): text + CHECK instead of pgEnum; timestamptz everywhere; FK actions:
// user_id -> users CASCADE, parent -> child CASCADE, references (media_id, turn_id, *_message_id)
// SET NULL; every FK column is indexed. Columns with a digit after a capital get explicit names.

const tz = { withTimezone: true } as const;

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    phoneE164: text("phone_e164").notNull(),
    /** Provider of the most recent inbound message. */
    provider: text().notNull(),
    /** Our line (E.164) the user last texted; replies and check-ins go from it. */
    line: text(),
    status: text().notNull().default("onboarding"),
    isAdult: boolean(),
    consentedAt: timestamp(tz),
    timezone: text(),
    timezoneSource: text(),
    lastInboundAt: timestamp(tz),
    messagingPausedAt: timestamp(tz),
    stopConfirmedAt: timestamp(tz),
    createdAt: timestamp(tz).notNull().defaultNow(),
    updatedAt: timestamp(tz).notNull().defaultNow(),
  },
  (t) => [
    unique("users_phone_e164_key").on(t.phoneE164),
    check("users_status_check", sql`${t.status} in ('onboarding', 'active')`),
    check(
      "users_timezone_source_check",
      sql`${t.timezoneSource} is null or ${t.timezoneSource} in ('user', 'simulator', 'default')`,
    ),
  ],
);

/** Per-user debounce deadline and processing lease (one turn per user at a time). */
export const userTurnState = pgTable("user_turn_state", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  processAfter: timestamp(tz).notNull(),
  /** Set when a burst starts; cleared at claim so each burst gets its own max-debounce cap. */
  burstStartedAt: timestamp(tz),
  leaseOwner: uuid(),
  leaseExpiresAt: timestamp(tz),
  updatedAt: timestamp(tz).notNull().defaultNow(),
});

export const turns = pgTable(
  "turns",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text().notNull().default("claimed"),
    mode: text().notNull().default("agent"),
    /** The turn clock: max(sent_at) of the claimed messages. */
    clockAt: timestamp(tz).notNull(),
    startedAt: timestamp(tz).notNull(),
    finishedAt: timestamp(tz),
    iterations: integer().notNull().default(0),
    /** Per-iteration metadata only (latency, token usage, stop reason). Never content. */
    usage: jsonb().$type<TurnIterationUsage[]>().notNull().default([]),
    stopReason: text(),
    errorCode: text(),
    createdAt: timestamp(tz).notNull().defaultNow(),
  },
  (t) => [
    index("turns_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("turns_created_at_idx").on(t.createdAt),
    // Orphan recovery runs on every lease acquire; keep it independent of history length.
    index("turns_open_user_id_idx")
      .on(t.userId, t.createdAt)
      .where(sql`${t.status} in ('claimed', 'effects_committed', 'reply_written')`),
    check(
      "turns_status_check",
      sql`${t.status} in ('claimed', 'effects_committed', 'reply_written', 'done', 'failed')`,
    ),
    check(
      "turns_mode_check",
      sql`${t.mode} in ('agent', 'onboarding', 'command', 'care', 'gated', 'safety', 'recovery')`,
    ),
  ],
);

export interface TurnIterationUsage {
  latencyMs: number;
  /** The model that produced the response: after a server-side fallback, not the one requested. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The 1 h share of cacheWriteTokens (billed above 5 m writes). */
  cacheWrite1hTokens: number;
  stopReason: string | null;
  /**
   * A fallback-served response only: every billed attempt, the declined one included. The counts
   * above then cover just the attempt that produced the message.
   */
  attempts?: TurnAttemptUsage[];
}

export interface TurnAttemptUsage {
  type: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    providerMessageId: text().notNull(),
    toLine: text(),
    /** NULL when not stored (pre-consent, purged by retention). */
    text: text(),
    /** Command keyword matched on this message alone at ingest (e.g. STOP, HELP, YES). */
    keyword: text(),
    /** Crisis screen tag (emergency | self_harm | ed); the text itself is never stored for it. */
    crisisKind: text(),
    sentAt: timestamp(tz).notNull(),
    receivedAt: timestamp(tz).notNull(),
    status: text().notNull().default("pending"),
    turnId: uuid().references(() => turns.id, { onDelete: "set null" }),
    preConsent: boolean().notNull().default(false),
    preConsentMediaCount: integer().notNull().default(0),
    triageStatus: text(),
    triage: jsonb(),
    createdAt: timestamp(tz).notNull().defaultNow(),
  },
  (t) => [
    unique("inbound_messages_provider_message_key").on(t.provider, t.providerMessageId),
    index("inbound_messages_user_id_received_at_idx").on(t.userId, t.receivedAt),
    index("inbound_messages_open_user_idx")
      .on(t.userId)
      .where(sql`${t.status} in ('pending', 'processing')`),
    index("inbound_messages_open_received_idx")
      .on(t.receivedAt)
      .where(sql`${t.status} in ('pending', 'processing')`),
    index("inbound_messages_received_at_idx").on(t.receivedAt),
    index("inbound_messages_turn_id_idx").on(t.turnId),
    check(
      "inbound_messages_status_check",
      sql`${t.status} in ('pending', 'processing', 'done', 'ignored', 'failed')`,
    ),
    check(
      "inbound_messages_crisis_kind_check",
      sql`${t.crisisKind} is null or ${t.crisisKind} in ('emergency', 'self_harm', 'ed')`,
    ),
    check(
      "inbound_messages_triage_status_check",
      sql`${t.triageStatus} is null or ${t.triageStatus} in ('pending', 'done', 'failed', 'skipped')`,
    ),
  ],
);

export const media = pgTable(
  "media",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inboundMessageId: uuid().references(() => inboundMessages.id, { onDelete: "set null" }),
    /** Provider URL, cleared once the bytes are stored. Never logged. */
    providerUrl: text(),
    status: text().notNull().default("pending"),
    claimedUntil: timestamp(tz),
    attempts: integer().notNull().default(0),
    storageKey: text(),
    /** Content type as reported by the provider (before conversion). */
    sourceContentType: text(),
    /** Stored content type (always image/jpeg after processing). */
    contentType: text(),
    width: integer(),
    height: integer(),
    bytes: integer(),
    sha256: text(),
    kind: text(),
    /** Code-written one-liner used in conversation history ("[photo 12:40: ...]"). */
    summary: text(),
    purgeAfter: timestamp(tz),
    purgedAt: timestamp(tz),
    errorCode: text(),
    createdAt: timestamp(tz).notNull().defaultNow(),
    updatedAt: timestamp(tz).notNull().defaultNow(),
  },
  (t) => [
    index("media_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("media_inbound_message_id_idx").on(t.inboundMessageId),
    index("media_purge_after_idx")
      .on(t.purgeAfter)
      .where(sql`${t.storageKey} is not null`),
    check(
      "media_status_check",
      sql`${t.status} in ('pending', 'downloading', 'stored', 'failed', 'purged')`,
    ),
  ],
);

export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    turnId: uuid().references(() => turns.id, { onDelete: "set null" }),
    kind: text().notNull(),
    proactiveKind: text(),
    /** Position of this bubble within its reply (0-based). */
    seq: integer().notNull().default(0),
    fromLine: text(),
    text: text(),
    mediaId: uuid().references(() => media.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    status: text().notNull().default("intent"),
    providerMessageId: text(),
    errorCode: text(),
    createdAt: timestamp(tz).notNull().defaultNow(),
    sentAt: timestamp(tz),
  },
  (t) => [
    unique("outbound_messages_idempotency_key").on(t.idempotencyKey),
    index("outbound_messages_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("outbound_messages_created_at_idx").on(t.createdAt),
    index("outbound_messages_turn_id_idx").on(t.turnId),
    index("outbound_messages_media_id_idx").on(t.mediaId),
    index("outbound_messages_unsent_idx")
      .on(t.userId)
      .where(sql`${t.status} in ('intent', 'sending')`),
    check(
      "outbound_messages_kind_check",
      sql`${t.kind} in ('reply', 'proactive', 'command', 'onboarding', 'safety', 'priority')`,
    ),
    check(
      "outbound_messages_status_check",
      sql`${t.status} in ('intent', 'sending', 'sent', 'unknown', 'suppressed', 'undeliverable', 'failed')`,
    ),
  ],
);

/** Simulator-only side channel: typing indicators and reactions shown in /dev/chat. */
export const simulatorEvents = pgTable(
  "simulator_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    payload: jsonb(),
    createdAt: timestamp(tz).notNull().defaultNow(),
  },
  (t) => [
    index("simulator_events_user_id_created_at_idx").on(t.userId, t.createdAt),
    check("simulator_events_type_check", sql`${t.type} in ('typing_start', 'typing_stop', 'reaction')`),
  ],
);

/** Dev-only clock offset for simulator time travel. Ignored in production. Single row (id = 1). */
export const devClock = pgTable(
  "dev_clock",
  {
    id: integer().primaryKey(),
    offsetMs: doublePrecision().notNull().default(0),
    updatedAt: timestamp(tz).notNull().defaultNow(),
  },
  (t) => [check("dev_clock_single_row_check", sql`${t.id} = 1`)],
);
