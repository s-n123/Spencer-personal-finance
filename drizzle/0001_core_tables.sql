CREATE TABLE "dev_clock" (
	"id" integer PRIMARY KEY NOT NULL,
	"offset_ms" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dev_clock_single_row_check" CHECK ("dev_clock"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"to_line" text,
	"text" text,
	"keyword" text,
	"crisis_kind" text,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"turn_id" uuid,
	"pre_consent" boolean DEFAULT false NOT NULL,
	"pre_consent_media_count" integer DEFAULT 0 NOT NULL,
	"triage_status" text,
	"triage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_messages_provider_message_key" UNIQUE("provider","provider_message_id"),
	CONSTRAINT "inbound_messages_status_check" CHECK ("inbound_messages"."status" in ('pending', 'processing', 'done', 'ignored', 'failed')),
	CONSTRAINT "inbound_messages_crisis_kind_check" CHECK ("inbound_messages"."crisis_kind" is null or "inbound_messages"."crisis_kind" in ('emergency', 'self_harm', 'ed')),
	CONSTRAINT "inbound_messages_triage_status_check" CHECK ("inbound_messages"."triage_status" is null or "inbound_messages"."triage_status" in ('pending', 'done', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"inbound_message_id" uuid,
	"provider_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"storage_key" text,
	"source_content_type" text,
	"content_type" text,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"sha256" text,
	"kind" text,
	"summary" text,
	"purge_after" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_status_check" CHECK ("media"."status" in ('pending', 'downloading', 'stored', 'failed', 'purged'))
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"turn_id" uuid,
	"kind" text NOT NULL,
	"proactive_kind" text,
	"seq" integer DEFAULT 0 NOT NULL,
	"from_line" text,
	"text" text,
	"media_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'intent' NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbound_messages_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "outbound_messages_kind_check" CHECK ("outbound_messages"."kind" in ('reply', 'proactive', 'command', 'onboarding', 'safety', 'priority')),
	CONSTRAINT "outbound_messages_status_check" CHECK ("outbound_messages"."status" in ('intent', 'sending', 'sent', 'unknown', 'suppressed', 'undeliverable', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "simulator_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulator_events_type_check" CHECK ("simulator_events"."type" in ('typing_start', 'typing_stop', 'reaction'))
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"mode" text DEFAULT 'agent' NOT NULL,
	"clock_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"iterations" integer DEFAULT 0 NOT NULL,
	"usage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_reason" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_status_check" CHECK ("turns"."status" in ('claimed', 'effects_committed', 'reply_written', 'done', 'failed')),
	CONSTRAINT "turns_mode_check" CHECK ("turns"."mode" in ('agent', 'onboarding', 'command', 'care', 'gated', 'safety', 'recovery'))
);
--> statement-breakpoint
CREATE TABLE "user_turn_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"process_after" timestamp with time zone NOT NULL,
	"burst_started_at" timestamp with time zone,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"provider" text NOT NULL,
	"line" text,
	"status" text DEFAULT 'onboarding' NOT NULL,
	"is_adult" boolean,
	"consented_at" timestamp with time zone,
	"timezone" text,
	"timezone_source" text,
	"last_inbound_at" timestamp with time zone,
	"messaging_paused_at" timestamp with time zone,
	"stop_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_e164_key" UNIQUE("phone_e164"),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('onboarding', 'active')),
	CONSTRAINT "users_timezone_source_check" CHECK ("users"."timezone_source" is null or "users"."timezone_source" in ('user', 'simulator', 'default'))
);
--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_inbound_message_id_inbound_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulator_events" ADD CONSTRAINT "simulator_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_turn_state" ADD CONSTRAINT "user_turn_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_messages_user_id_received_at_idx" ON "inbound_messages" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_open_user_idx" ON "inbound_messages" USING btree ("user_id") WHERE "inbound_messages"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "inbound_messages_open_received_idx" ON "inbound_messages" USING btree ("received_at") WHERE "inbound_messages"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "inbound_messages_received_at_idx" ON "inbound_messages" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_turn_id_idx" ON "inbound_messages" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "media_user_id_created_at_idx" ON "media" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "media_inbound_message_id_idx" ON "media" USING btree ("inbound_message_id");--> statement-breakpoint
CREATE INDEX "media_purge_after_idx" ON "media" USING btree ("purge_after") WHERE "media"."storage_key" is not null;--> statement-breakpoint
CREATE INDEX "outbound_messages_user_id_created_at_idx" ON "outbound_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_created_at_idx" ON "outbound_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_turn_id_idx" ON "outbound_messages" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_media_id_idx" ON "outbound_messages" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_unsent_idx" ON "outbound_messages" USING btree ("user_id") WHERE "outbound_messages"."status" in ('intent', 'sending');--> statement-breakpoint
CREATE INDEX "simulator_events_user_id_created_at_idx" ON "simulator_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "turns_user_id_created_at_idx" ON "turns" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "turns_created_at_idx" ON "turns" USING btree ("created_at");