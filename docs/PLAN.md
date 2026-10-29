# Plan: iMessage AI nutrition coach (MVP)

Status: DRAFT for owner review (2026-10-29). Nothing is built yet.
Inputs: `SPEC.md`, research notes in `docs/research/` (each fact tagged `[primary]`, `[sdk-source]` or `[search]`).
Decisions with sensible defaults are logged in `DECISIONS.md`; this file is the architecture and milestone plan.

---

## 1. Architecture at a glance

```
                ┌──────────────────────── Next.js 16 app on Vercel (Node runtime) ────────────────────────┐
 iPhone ─iMessage─► Sendblue ─webhook─► /api/webhooks/sendblue/[token]  ─┐
                                                                         ├─► ChannelAdapter.parse/verify
 Browser ─────────► /dev/chat (simulator UI) ─► /api/dev/sim/messages ───┘          │
                                                                                     ▼
                                         ingest(): upsert user · INSERT inbound ON CONFLICT DO NOTHING (dedupe)
                                                   · set turn_state.process_after = now()+4s · return 200
                                                                                     │ after()
                                                                                     ▼
                         TurnScheduler: download+store media → wait until process_after → acquire per-user
                         lease (UPDATE … RETURNING) → claim all pending messages as ONE turn → release → recheck
                                                                                     │
                                                                                     ▼
          TurnRouter: commands (STOP/START/HELP/DELETE) → onboarding/consent (deterministic) → access gate (M7)
                      → safety triage (Haiku) → care mode | Agent (Sonnet tool loop) → OutboundSender
                                                                                     │
                       Agent tools ──► nutrition/ (FDC search + macro math) · supplements/ (UL checks)
                                   ──► profile/targets (guardrails) · check-in prefs · history
                                                                                     │
                                         OutboundSender: format to 1–3 plain-text bubbles → adapter.send → record
 Cron (/api/cron/tick) ─► sweeper (stranded turns) · proactive check-ins (quiet hours, caps, back-off) · purges
 /admin (Basic auth) ─► metrics from inbound/outbound/media tables
```

Core principles
- **Provider isolation.** Everything provider-specific lives in `src/server/channels/<provider>/`. The rest of the app only sees normalized events and a `ChannelAdapter`.
- **Model estimates, code computes.** The model identifies foods, picks FDC records and estimates grams. Code does every multiplication and sum: macros, totals, remaining, UL comparisons, menu fit. The model gets numbers from tool results and is told to copy them.
- **Deterministic where the law or safety needs it.** Consent, age gating, STOP/START/HELP/DELETE and the emergency reply are code paths, not LLM judgment.
- **Durable state in Postgres, not in memory.** Serverless instances share nothing. Leases, debounce deadlines and idempotency keys all live in the DB.
- **Privacy by default.** Message bodies and photos never reach application logs. Photos are EXIF-stripped, stored privately, and purged on a schedule. No trackers anywhere.

## 2. Key flows

### 2.1 Inbound → turn (turn batching, SPEC §3)
1. **Webhook / simulator POST.** The adapter verifies authenticity (Sendblue: constant-time compare of the `sb-signing-secret` header, plus an unguessable path token) and parses to `NormalizedEvent[]`. Group chats, tapbacks, status callbacks and non-E.164 handles are acknowledged and ignored.
2. **`ingest()` in one short transaction:**
   - upsert the `users` row by phone;
   - `INSERT inbound_messages … ON CONFLICT (provider, provider_message_id) DO NOTHING RETURNING id` (a duplicate means return 200 and stop);
   - insert a `media` row per attachment (`status=pending`, provider URL kept until download);
   - `UPDATE user_turn_state SET process_after = now() + DEBOUNCE_MS`.
   Then it returns 200. Target is under 300 ms, well inside Sendblue's 45 s timeout.
3. **`after(() => scheduler.kick(userId))`** runs in the same invocation after the response:
   - **Media first:** download pending media for this user immediately (provider URLs expire: Linq 1 h, Sendblue 30 d), sniff the type, convert HEIC→JPEG, auto-orient, strip EXIF, resize with the port of Anthropic's `resizedSize`, store privately, then clear the provider URL.
   - **Debounce:** sleep until `process_after`. Every new message pushes `process_after` forward, so a photo → caption → photo burst settles into one deadline. Waiting is not billed as active CPU on Fluid compute.
   - **Lease:** `UPDATE user_turn_state SET lease_owner=$me, lease_expires_at=now()+LEASE_TTL WHERE user_id=$u AND (lease_expires_at IS NULL OR lease_expires_at < now()) AND process_after <= now() RETURNING …`. If the update returns no row, either another invocation holds the lease (it will see our message when it loops) or the deadline moved (the newer message's invocation will handle it). Either way, exit.
   - **Claim:** `UPDATE inbound_messages SET status='processing', turn_id=$t WHERE user_id=$u AND status='pending' RETURNING …`, then run the turn.
   - **Loop:** after the turn, mark the messages done. If messages arrived meanwhile, wait for their `process_after` and process them as the next turn, all under the same lease, while the deadline budget allows.
   - **Release, then recheck:** release the lease fenced on `lease_owner`, then check once more for pending messages. This closes the gap where a message lands just before the release and its own invocation already gave up.
4. **Durability:** `after()` is not durable (a crash or timeout loses the work after the 200). Recovery happens in two places:
   - the next inbound from that user claims any stale `pending` or `processing` rows whose lease has expired;
   - the cron sweeper re-drives users with messages pending longer than 2 minutes. This waits on the cron frequency; see §7.
5. **Time budget (single deadline):**
   - `maxDuration = 300` (the Hobby maximum);
   - turn budget 240 s;
   - Anthropic per-call `timeout = 60 s`, `maxRetries = 1`;
   - at most 6 tool-loop iterations, checking the remaining budget before each model call;
   - `LEASE_TTL = 330 s`, longer than `maxDuration`, so a live invocation never loses its lease.
6. **Tests** (no real waiting) use an injected clock and sleeper plus an `InlineRunner` in place of `after()`. A separate race suite runs against a real Postgres when `TEST_DATABASE_URL` is set.

### 2.2 TurnRouter (order matters)
1. **Keyword commands:**
   - The message is trimmed and case-folded, and the whole message must match.
   - STOP family (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT, OPTOUT): set `messaging_paused_at` and send one confirmation.
   - START or UNSTOP resumes. HELP returns the program description, support contact, opt-out instructions, policy links and the FDC attribution.
   - DELETE asks for confirmation. A YES within 10 minutes wipes everything; see §2.6.
   - While paused, only START, HELP and DELETE get a response.
2. **Onboarding (deterministic, no LLM, SPEC Safety §1):**
   1. Unknown number: send "AI coach, not a doctor" and ask "How old are you?".
   2. Age 18 or over: send the consent prompt. It names the 4 MHMDA elements (data categories, purposes, recipient categories, how to withdraw) and links the privacy policy and a *separate* consumer health data notice (TODO URLs). It ends with "Reply YES to agree".
   3. YES: write an append-only `consent_events` row with the timestamp, policy versions, prompt hash and message IDs.
   4. Under 18: decline politely and store only an `ineligible` flag.
   - **Pre-consent content is transient:** no LLM, no media download, and message text is nulled out right after the onboarding turn.
3. **Profile collection** (after consent, handled by the agent): the agent's context lists missing profile fields (goal, height/weight, diet, timezone, check-ins). It asks for one at a time, and everything is skippable. `update_profile` validates the answers and recomputes targets in code.
4. **Access gate (M7):** the user's access is `full`, `grace` or `gated`. A gated user gets a canned paywall reply, rate-limited to once every 24 h, and no model call. Commands, onboarding and safety replies are never gated.
5. **Safety triage (Haiku 5.5, structured output, runs in parallel with media prep).** It returns `ed_risk` (none, possible or high), `medical_emergency`, `medical_context` and `opt_out_intent`:
   - **Emergency:** send a deterministic "call 911" message first.
   - **ED risk high:** care mode. Send no numbers or tracking talk, share the National Alliance for Eating Disorders helpline (number held in config with a `verified_at` date) plus 988 and Crisis Text Line, and start a cooldown (no proactive messages, no calorie talk for N days).
   - **ED risk possible:** add a context flag that makes the agent gentler and drop number-heavy replies.
   - **Medical context:** add a context flag so the agent suggests checking supplement changes with a pharmacist or doctor.
   - **Opt-out intent** (natural language such as "stop texting me"): treat it as STOP.
6. **Agent** (Sonnet 5.5 tool loop; see §4) → **OutboundSender**.

### 2.3 Meal photo → log (SPEC §4, §5)
1. The agent sees the stored image or images, a caption and a context block. The context block holds the profile, targets, today's log with totals computed in code, any pending meal draft, and the supplement stack summary.
2. `search_foods({queries:[…]})` takes one call for all items.
   - It searches the local FDC seed first, in priority order FNDDS > SR Legacy > Foundation, with a trigram index. It falls back to the live FDC API, including Branded for packaged items.
   - It returns the top 5 candidates per query: fdcId, dataType, description, kcal and macros per 100 g, and typical portion gram weights.
3. The model picks candidates and estimates `grams`, `grams_low`, `grams_high` and `confidence` per item, then calls `log_meal`.
4. Code computes per item `per100 × grams / 100` using a fixed energy chain (1008 → 2047 → 2048 → kJ/4.184 → Atwater 4/4/9 from macros, flagged as derived). It snapshots the FDC values onto the item and computes the kcal range.
5. **Clarification rule (in code):** clarify when any low-confidence item's kcal range is at least `CLARIFY_MIN_KCAL_RANGE` (default 150), or when a low-confidence item is a hidden-calorie category (oil, butter, dressing, sauce, sugary drink, alcohol).
   - Code saves a `draft` meal and returns `needs_clarification` with the item to ask about, and the model asks ONE short question.
   - The next turn completes the draft. At most one question is asked per meal, and if the user says "just estimate", the meal is logged anyway.
6. Once logged, `log_meal` returns the canonical `totals_line` (e.g. "Today: 1,240 / 2,000 kcal · 82 / 140 g protein"). The system prompt requires one line on what was logged, then that line verbatim.

### 2.4 Menu photo (M3)
1. The agent reads the menu and shortlists up to 5 plausible dishes.
2. It decomposes each dish into FDC-grounded components with grams (via `search_foods`).
3. `score_menu_options` computes macros per option and a fit score against today's remaining kcal and protein, in code.
4. The agent recommends the best 2–3 in plain text.

### 2.5 Supplement label (M3)
1. The model extracts the label into the strict tool `save_supplement`:
   - product, brand, serving size and servings per day;
   - ingredients with amount, unit, chemical form (retinol vs beta-carotene, folic acid vs methylfolate, d- vs dl-alpha-tocopherol, nicotinic acid vs niacinamide), and whether the amount is elemental.
2. Code maps each name to a canonical nutrient key using a synonyms table and converts units (IU→mcg for vitamin D, IU→mg for vitamin E by form, folic acid→DFE).
3. Code aggregates per day across active products and compares against the UL table with scope awareness:
   - total-intake ULs (vitamins A, C and D) are reported as "from supplements alone; food adds more";
   - supplemental-only ULs (niacin, folic acid, vitamin E, magnesium) are compared directly;
   - for vitamin A, only preformed retinol counts.
4. Code flags duplicates when the same canonical nutrient appears in two or more products, and flags single-dose days above the UL (e.g. a weekly 50,000 IU vitamin D).
5. The agent phrases the flags in general-wellness language. If the user mentioned meds, pregnancy or a condition, it suggests checking with a pharmacist or doctor.

### 2.6 DELETE (SPEC Safety §2)
1. DELETE: reply "This permanently deletes all your data. Reply YES within 10 minutes to confirm."
2. YES within 10 minutes:
   - cancel any Stripe subscription (M7);
   - delete all of the user's blobs;
   - delete the `users` row (`ON DELETE CASCADE` reaches every user-owned table; shared FDC caches hold no user IDs);
   - write a non-identifying `deletion_receipts` row;
   - send one final confirmation.
3. **Limits** (stated in the consumer health data notice): Sendblue has no message-delete API, Neon point-in-time-restore history keeps data for its window, and Anthropic may retain flagged content. These are listed as owner decisions in §8.

### 2.7 Proactive check-ins (M5)
1. **Endpoint:** `/api/cron/tick`, secured by `Authorization: Bearer $CRON_SECRET`.
2. **Selection:** each run selects users who meet all of these:
   - opted in to that check-in category;
   - consented;
   - not STOPped;
   - not in back-off (`unanswered_proactive_count < 2`);
   - not in a safety cooldown;
   - timezone known;
   - local time is past the slot time, within a grace window, and outside quiet hours (default 21:00–08:00);
   - under the per-user daily cap (2);
   - under the global per-number daily cap.
3. **Idempotency:** a `UNIQUE (user_id, kind, local_date)` constraint on `proactive_sends`, so runs that are missed, duplicated or overlapping can't double-send.
4. **Back-off:** each proactive send increments `unanswered_proactive_count`, and any inbound resets it.
5. **Content:**
   - morning plan: targets plus one suggestion;
   - evening recap: today's totals vs target;
   - supplement reminder: the user's stack;
   - weekly recap on Sunday: weekly averages and adherence, computed in code.
   The model writes one or two bubbles from the computed facts.

## 3. Channel adapter interface (SPEC §1)

```ts
// src/server/channels/types.ts (sketch)
type Provider = 'simulator' | 'sendblue' | 'linq' | 'blooio';
interface InboundMessage {
  provider: Provider;
  providerMessageId: string;      // dedupe key (Sendblue: message_handle, one per attachment)
  fromE164: string;               // normalized with libphonenumber-js
  toLine: string | null;          // our sending number
  text: string | null;
  media: { url: string; mimeType?: string }[];
  sentAt: Date;                   // provider timestamp
  service?: 'iMessage' | 'SMS' | 'RCS';
  providerConversationId?: string; // Linq/Blooio chat id
}
type NormalizedEvent =
  | { kind: 'message'; message: InboundMessage }
  | { kind: 'status'; providerMessageId: string; status: string }
  | { kind: 'ignored'; reason: 'group' | 'reaction' | 'non_e164' | 'outbound_echo' | 'unknown' };

interface ChannelAdapter {
  readonly provider: Provider;
  readonly capabilities: { typing: boolean; reactions: boolean; readReceipts: boolean; outboundMedia: boolean };
  verify(req: { rawBody: string; headers: Headers; url: URL }): Promise<boolean>;
  parse(rawBody: string, headers: Headers): NormalizedEvent[];
  fetchMedia(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>;
  sendText(to: string, text: string, opts: { idempotencyKey: string }): Promise<SendResult>;
  sendImage?(to: string, image: { bytes: Uint8Array; contentType: string }, opts: { idempotencyKey: string }): Promise<SendResult>;
  startTyping?(to: string): Promise<void>;   // best-effort, never blocks a reply
  react?(to: string, providerMessageId: string, reaction: Reaction): Promise<void>;
}
```
- **SimulatorAdapter (M1):**
  - Inbound arrives as a multipart POST from `/dev/chat`. The browser downscales images before upload; HEIC is passed through raw.
  - Outbound "sends" just write `outbound_messages` rows, and typing and reactions go to `simulator_events`. The page polls once a second.
  - It supports several fake phone numbers and a reset button. It is enabled only when `ENABLE_SIMULATOR=true` (default in dev, off in production).
- **SendblueAdapter (M6):**
  - Auth headers `sb-api-key-id` and `sb-api-secret-key`, base URL `https://api.sendblue.co`.
  - Sends use `maxRetries: 0` with reconciliation, to avoid duplicate texts.
  - Typing goes to `/api/send-typing-indicator` and reactions to `/api/send-reaction`. Outbound images go through `/api/upload-file`, never public URLs of user photos.
  - The inbound Zod schemas stay lenient until real payloads are captured.

## 4. Agent design (SPEC §4)

- **Request shape (cache-friendly):**
  - `tools` (sorted, frozen; `cache_control` 1 h on the last tool);
  - `system` (static text including SPEC's texting style; `cache_control` 1 h);
  - one fresh user turn: a rendered context block, then labeled images, then the caption or text, preceded by compact history (the last ~12 exchanges as plain text, with past photos replaced by one-line summaries).
  - Earlier turns' assistant, thinking or tool blocks are never replayed. This avoids the preserved-thinking 400s and keeps the shared prefix cache hot.
- **Model params:**
  - Model: `MODEL_MAIN=claude-sonnet-5-5`.
  - No `temperature`, `top_p` or `top_k`: API version 2026-10-21 returns a 400 for them.
  - Thinking adaptive (the default). `MODEL_MAIN_EFFORT` defaults to `medium`, tuned with evals.
  - `tool_choice: auto` only (Sonnet 5.5 rejects forced choice).
  - `strict: true` on `log_meal`, `save_supplement` and `edit_or_delete_meal`.
- **Schemas:** Zod v4 → `z.toJSONSchema()` with `additionalProperties:false`. Inputs are re-validated with Zod (bounds live in Zod because strict schemas can't express min and max).
- **Tools** (SPEC minimum plus three):

  | Tool | Purpose |
  |---|---|
  | `search_foods` | FDC candidates (local seed, then API) |
  | `log_meal` | compute and log, or return `needs_clarification` |
  | `edit_or_delete_meal` | fix or remove a logged meal (`last` or id); recompute |
  | `get_day_summary` | totals, targets, remaining (computed) |
  | `get_history` | per-day totals and averages over a range |
  | `score_menu_options` | macro and fit scores for menu options (M3) |
  | `save_supplement` / `remove_supplement` / `get_supplement_stack` | stack CRUD plus aggregation, UL and duplicate flags (M3) |
  | `update_profile` | goals and body stats → recompute targets with guardrails (M4) |
  | `set_checkin_preferences` | opt-in, times, confirms assumed timezone (M4/M5) |

- **Output → bubbles:**
  - The model writes plain text, with bubbles separated by a blank line.
  - The formatter strips markdown (bullets, `**`, headers), caps replies at 3 bubbles of 300 characters or less (splitting long ones at sentence boundaries), and drops empty bubbles.
  - Unit tests cover the formatter, and evals check that the totals line is quoted exactly.
- **Stop reasons:**
  - `end_turn`: send the reply.
  - `tool_use`: run the tools and loop.
  - `refusal`: send a canned caring reply (in care mode, the helpline) and record a `safety_event`.
  - `max_tokens` or a context overflow: retry once with a trimmed history, then send a fallback.
  - Spend-cap 429: alert and send one "having trouble" reply; don't retry.
- **MODEL_FAST** (`claude-haiku-5-5`): safety triage and natural-language opt-out detection on each turn, via `messages.parse` + `zodOutputFormat`, with thinking off and small `max_tokens`.

## 5. Data model (Postgres, Drizzle; all `timestamptz`, UUID PKs, `ON DELETE CASCADE` from `users`)

| Table | Key columns | Milestone |
|---|---|---|
| `users` | `phone_e164` UNIQUE, `status` (onboarding/active/ineligible), `onboarding_step`, `timezone`, `timezone_source` (user/inferred), `last_inbound_at`, `messaging_paused_at` (STOP), `unanswered_proactive_count`, `proactive_paused_at`, `safety_cooldown_until`, `pending_action` jsonb (e.g. delete confirm + expiry), `trial_started_at`, `trial_ends_at` | M1 (+M4/M5/M7 columns) |
| `user_turn_state` | `user_id` PK, `process_after`, `lease_owner`, `lease_expires_at` | M1/M2 |
| `inbound_messages` | `provider`, `provider_message_id` (UNIQUE pair), `user_id`, `text` (nullable; purged pre-consent), `sent_at`, `received_at`, `status` (pending/processing/done/ignored/failed), `turn_id`, `pre_consent` | M1 |
| `media` | `user_id`, `inbound_message_id`, `provider_url` (cleared after download), `status`, `storage_key`, `content_type`, `width`, `height`, `bytes`, `sha256`, `kind` (meal/menu/label/other), `summary` (one-liner for history), `purge_after` | M1 |
| `outbound_messages` | `user_id`, `turn_id`, `kind` (reply/proactive/command/system), `proactive_kind`, `text`, `provider_message_id`, `status`, `error_code`, `idempotency_key` UNIQUE | M1 |
| `turns` | `user_id`, `status`, `mode` (agent/onboarding/command/care/gated), `iterations`, token usage incl. cache read/write, `stop_reason`, `latency_ms`, `error_code`. **No content.** | M1 |
| `simulator_events` | `phone`, `type` (typing/reaction), `payload`, `created_at` | M1 |
| `user_profiles` | `goal`, `sex?`, `age_years?`, `height_cm?`, `weight_kg?`, `goal_weight_kg?`, `activity_level?`, `weekly_rate_kg` (clamped), `diet_prefs[]`, `restrictions[]`, `kcal_target`, `protein_g_target`, `carb_g_target`, `fat_g_target`, `targets_source`, `guardrail_applied` | M2 (defaults) / M4 |
| `weight_entries` | `user_id`, `kg`, `measured_at` | M4 |
| `meals` | `user_id`, `status` (draft/logged/deleted), `local_date`, `eaten_at`, `meal_type`, `title`, `source` (photo/text), `media_id`, totals (`kcal`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `sugar_g`, `sodium_mg`), `clarification` jsonb, `turn_id` | M2 |
| `meal_items` | `meal_id`, `user_id`, `label`, `fdc_id`, `fdc_data_type`, `fdc_description`, `fdc_release`, `grams`, `grams_low`, `grams_high`, `confidence`, `category`, `energy_source`, `per100g` jsonb snapshot, computed macros | M2 |
| `fdc_foods` | `fdc_id` PK, `data_type`, `description` (GIN trigram), `food_category`, `release`, `per100g` jsonb, `energy_source`, `portions` jsonb, `brand_owner`, `gtin`, `serving_size`, `serving_unit`, `source` (seed/api), `fetched_at` | M2 |
| `fdc_search_cache` | (`query_norm`, `data_types`) PK, `fdc_ids[]`, `fetched_at` (30-day TTL) | M2 |
| `supplements` | `user_id`, `product_name`, `brand`, `serving_amount`, `serving_unit`, `servings_per_day`, `media_id`, `active`, `removed_at` | M3 |
| `supplement_ingredients` | `supplement_id`, `user_id`, `raw_name`, `nutrient_key?`, `form?`, `amount`, `unit`, `amount_norm`, `unit_norm`, `is_elemental?` | M3 |
| UL reference | **versioned TS data file** `src/server/supplements/upper-limits.ts`. Each row: `nutrient_key`, `ul`, `unit`, `applies_to` (total/supplemental_only/specific_form), `counted_forms`, `excluded_forms`, `physician_care_note`, `source_url`, `sheet_updated`, `retrieved_at` | M3 |
| `policy_versions` | `kind` (privacy/chd_notice/consent_prompt), `version`, `url`, `text`, `sha256`, `effective_at` | M4 |
| `consent_events` | append-only: `user_id`, `type` (age_18_plus/chd_collection/proactive:<kind>), `action` (granted/revoked), `policy_version_ids`, `prompt_sha256`, `inbound_provider_message_id`, `outbound_message_id`, `matched_keyword`, `provider`, `service`, `app_version` | M4 |
| `safety_events` | `user_id`, `kind`, `severity`, `turn_id`. **No text.** | M4 |
| `deletion_receipts` | `requested_at`, `completed_at`, `blobs_deleted`, `stripe_canceled`. No identifiers unless the owner approves a hashed suppression record. | M4 |
| `checkin_preferences` | `user_id` PK; morning, evening, supplement and weekly on/off + local times; weekly day = Sunday | M4/M5 |
| `proactive_sends` | `user_id`, `kind`, `local_date` (UNIQUE triple), `outbound_message_id`, `answered_at` | M5 |
| `billing_customers`, `subscriptions`, `stripe_events` (`event_id` PK), `pay_links` (`token_hash`, `user_id`, `kind`, `expires_at`, `last_session_id`) | | M7 |

Meals store `local_date`, computed in app code from `users.timezone`, so "today" is stable even if the timezone later changes.

## 6. File layout

```
SPEC.md  CLAUDE.md  DECISIONS.md  README.md  .env.example
docs/PLAN.md  docs/research/*.md
drizzle/                         # generated migrations (0000 = CREATE EXTENSION pg_trgm)
fixtures/{meals,menus,labels}/   # owner's photos (+ optional <name>.txt caption, <name>.expect.json)
scripts/{migrate.ts, eval.ts, fdc-seed.ts, db-dev.ts, make-synthetic-fixtures.ts}
src/
  app/
    page.tsx                     # minimal landing: what it is, privacy + CHD notice links (TODO), FDC attribution
    dev/chat/                    # simulator UI (iMessage look, upload, typing dots, phone switcher, reset)
    admin/                       # metrics (Basic auth)
    api/dev/sim/{messages,media/[id],reset}/route.ts
    api/webhooks/sendblue/[token]/route.ts      # M6
    api/webhooks/stripe/route.ts                # M7
    api/cron/tick/route.ts                      # M5 (sweeper from M2)
    pay/[token]/route.ts  billing/[token]/route.ts   # M7
  proxy.ts                       # /admin Basic auth; 404 /dev + /api/dev unless ENABLE_SIMULATOR
  server/
    config/{env.ts, policy.ts}   # Zod-validated env; tunables (caps, thresholds, quiet hours, guardrails)
    db/{client.ts, schema/*.ts}
    log.ts                       # allowlisted structured fields only; never bodies
    time.ts                      # Clock interface, tz helpers
    channels/{types.ts, registry.ts, simulator/*, sendblue/*}
    pipeline/{ingest.ts, scheduler.ts, lease.ts, runner.ts, router.ts, outbound.ts}
    media/{image.ts, heic.ts, download.ts, storage/{types.ts, local.ts, vercel-blob.ts}}
    agent/{llm.ts, loop.ts, system-prompt.ts, context.ts, history.ts, format.ts, triage.ts, tools/*.ts}
    nutrition/{fdc/{client.ts, schemas.ts, normalize.ts, search.ts}, energy.ts, macros.ts, uncertainty.ts,
               targets.ts, day.ts, menu.ts}
    supplements/{nutrients.ts, units.ts, upper-limits.ts, aggregate.ts}
    onboarding/{flow.ts, copy.ts}  commands/{keywords.ts, handlers.ts}  safety/{care.ts, resources.ts}
    proactive/{due.ts, caps.ts, compose.ts, run.ts}  admin/metrics.ts  billing/{access.ts, links.ts, stripe.ts}
  test/                          # helpers: pglite db, fake clock, fake LLM, fake FDC, fake adapter
```

## 7. Platform choices (details and reasons in DECISIONS.md)
- **Next.js 16.4.3:** App Router, `src/`, Turbopack, `proxy.ts` (middleware is deprecated), Node runtime only, Cache Components **off** (so GET handlers are never frozen at build). Tailwind v4 for the simulator and admin UI.
- **DB:**
  - Neon (Postgres 18, via the Vercel Marketplace) in production, using `pg` + `drizzle-orm/node-postgres` with `attachDatabasePool`.
  - Locally: `npm run db:dev`, which starts a zero-install `pglite-server`, or any Postgres via `DATABASE_URL`.
  - Unit tests use in-process PGlite with a migration snapshot.
  - drizzle-orm stays on 0.45.4, the stable release, not the v1 RC.
- **Storage:** a private Vercel Blob store in production and the local filesystem in dev, behind a `MediaStorage` interface. Only the resized, EXIF-stripped JPEG is kept, and it is purged after `MEDIA_RETENTION_DAYS` (default 30).
- **Cron and the Vercel plan (flagged):** your account is **Hobby**, which runs cron jobs **at most once per day** with ±59-minute precision, so `*/15` fails the deploy. Hobby is also non-commercial only, so taking Stripe payments isn't allowed. The endpoint is built idempotent and catch-up-based so it works with any trigger:
  - (a) Vercel Pro (`*/15`, recommended before real users and required for M7);
  - (b) a free GitHub Actions schedule calling `/api/cron/tick` every 15 minutes (often 5–15 minutes late, which is fine for check-ins);
  - (c) manual or daily runs while developing.

## 8. Milestones (each ends with tests green, a commit, a summary and try-it steps; then I wait)

**M1: Scaffold, schema, simulator, photo description**
- Next.js scaffold, env validation, lint, Vitest, Drizzle and migrations, `npm run db:dev`, core tables (users, inbound/outbound, media, turns, turn state, simulator events).
- Simulator at `/dev/chat` (iMessage look, image upload, typing dots, phone switcher, reset).
- Ingest with dedupe, the media pipeline (HEIC→JPEG, orient, strip EXIF, resize, store), and a minimal agent loop (Sonnet) that describes any photo in plain-text bubbles. Turns run one message at a time; batching comes in M2.
- Tests: dedupe, normalization, `resizedSize` port vs the docs' examples, formatter (markdown strip and bubble split), env parsing.
- Try it: `npm i && cp .env.example .env.local` (add `ANTHROPIC_API_KEY`) → `npm run db:dev` + `npm run db:migrate` → `npm run dev` → open http://localhost:3000/dev/chat and send a photo.

**M2: Meal logging, FDC grounding, day summary, clarifying questions, turn batching**
- FDC client, cache and optional seed (`npm run fdc:seed`).
- Energy chain and macro math.
- `search_foods`, `log_meal`, `edit_or_delete_meal`, `get_day_summary`, `get_history`.
- Draft meals and the clarification rule.
- Default targets (config) until M4 profiles.
- Debounce, lease and the release-recheck loop, plus the stale-turn sweeper.
- `npm run eval` covering meals.
- Tests: macro math, energy chain, uncertainty rule, debounce and batching (fake clock), lease races (real PG), webhook dedupe.

**M3: Menus and supplement stack with UL checks**
- `score_menu_options`, the supplement tools, canonical nutrients and synonyms, unit conversions, and the UL table built from NIH ODS (**needs `ods.od.nih.gov` network access; see §9**).
- Aggregation, duplicate and over-UL flags.
- Synthetic label and menu fixtures plus yours, with eval columns for flags.
- Tests: aggregation, UL scope (total vs supplemental, form-specific), conversions, duplicates.

**M4: Onboarding, consent, profile, commands**
- Deterministic age and consent flow with `policy_versions` and `consent_events`, and pre-consent purge.
- Agent-led profile collection; targets with guardrails (calorie floor, max weekly loss) from config.
- Timezone capture (ask; infer from the area code if skipped and say so).
- STOP/START/HELP/DELETE plus natural-language opt-out; DELETE wipe including blobs.
- Safety triage and care mode; refusal handling.
- Tests: STOP, DELETE, consent determinism, guardrail clamps, keyword engine, care-mode routing.

**M5: Proactive check-ins, back-off, weekly recap, admin**
- `/api/cron/tick`: due selection across timezones and DST, quiet hours, per-user and global caps, back-off, idempotent sends.
- Morning, evening, supplement and weekly composition.
- Media retention purge.
- `/admin` metrics behind Basic auth: send-to-receive ratio, DAU, photos per user per day.
- Tests: back-off, caps, quiet hours, due selection, idempotency.

**M6: Sendblue, webhook verification, Vercel deploy, README**
- SendblueAdapter (send, typing, reactions, upload-file, opt-out sync, group and tapback ignore).
- Webhook route with secret-header and path-token verification.
- Capture real payloads into fixtures.
- Neon and private Blob provisioning, env setup, a cron schedule matched to your plan, and a README setup guide.
- Tests: verification, parsing against captured payloads, dedupe.

**M7: Stripe trial and subscription**
- In-app trial (no card) starting at consent, with `TRIAL_DAYS` from config.
- `getAccess`: full / grace / gated.
- `/pay/<token>` and `/billing/<token>`, which create or reuse a Checkout or Portal session on click (iMessage link previews can't burn them).
- Stripe webhook with signature check, `event.id` dedupe and a subscription re-fetch.
- Graceful gating; DELETE cancels the subscription.
- A fake BillingProvider for the simulator and tests.
- Tests: access matrix, webhook signature, idempotency.

## 9. Open questions (only those without a sensible default)
See the summary message for the short list. Items that block specific milestones:
1. **Vercel plan:** stay on Hobby while building (cron limited), then Pro before real users or M7? Or use the GitHub Actions scheduler meanwhile?
2. **Network and keys for this cloud environment:**
   - allow `api.nal.usda.gov` and `fdc.nal.usda.gov` (M2), `ods.od.nih.gov` (M3: the spec forbids filling ULs from memory), and the Sendblue, Stripe and Vercel docs domains (M6–M7);
   - add `ANTHROPIC_API_KEY` and `FDC_API_KEY` as environment secrets, so I can run the agent and evals here.
3. **Anthropic data handling:** pursue Zero Data Retention or a BAA (flagged content can otherwise be kept up to 2 years)? What monthly API budget should alerts assume?
4. **By M4:** the legal entity name and support contact for HELP and consent copy; approval of the guardrail thresholds and quiet hours (defaults in DECISIONS.md).
5. **By M7:** price, currency, trial length, an annual plan or not, and Terms/refund URLs.
