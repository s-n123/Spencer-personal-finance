# Decisions log

Choices made without asking because they have a sensible default (per SPEC "How to work").

**Format:** ID · decision · reason · status.

**Status values:**
- **active**
- **review**: the owner should look; not blocking
- **counsel**: needs a legal opinion before launch
- **superseded**

Research backing is in `docs/research/` (retrieved 2026-10-29). Plan context is in `docs/PLAN.md`.

## Repo and process

- **D-001 · Build in this repo on branch `claude/imessage-nutrition-coach`.** The pre-existing `index.html` and `privacy.html` (an unrelated personal-finance page served by GitHub Pages) are left untouched and are not this product's policies. · It is the only repo in scope; Next.js ignores root HTML files. · active
- **D-002 · Research notes are committed under `docs/research/` with retrieval dates and tags (`[primary]`, `[sdk-source]`, `[search]`).** · Several docs sites are blocked from the build container. · active
- **D-003 · The repo is public, so nothing sensitive is ever committed.**
  - Owner photo fixtures are gitignored by default (`fixtures/synthetic/` is committed).
  - Provider payloads are committed only through `scripts/capture-payload.ts` redaction.
  - Only fictional `+1NPA55501XX` numbers appear in code, tests and docs.
  - A test scans `src/test/`, `fixtures/` and `docs/` for real-looking numbers and provider media hosts.
  - `eval-results/` is gitignored.
  - · Reason: EXIF GPS, phone numbers, message bodies and live media URLs must not be published. · active
- **D-004 · Milestones are the SPEC's 7 stop points. Larger milestones (M2, M4) have internal a/b checkpoints, which are commits, not stops.** · Respects the owner's review cadence while keeping commits small. · active
- **D-005 · Step 0 of any integration milestone: re-read the live docs and mark every `[search]` fact the code relies on as verified. If a host is still blocked, stop and ask.** · SPEC requires reading current docs, and the research couldn't reach several sites. · active
- **D-006 · CI on GitHub Actions runs `npm run check` plus the node-postgres and race suite against a Postgres service on every push.** · Catches drizzle's silent migration skip, driver type differences and races. · active
- **D-007 · Until M4 turns on the consent gate, simulator users are created as consented (dev-only; refused when `VERCEL_ENV=production`).** · Without this, M1–M3 can't be tried at all; there are no real users before M6. · active

## Stack

- **D-010 · Next.js 16.4.3 (latest stable), App Router, `src/` directory, Turbopack, npm, Node ≥22.12 (`.nvmrc` 22).** Vitest 5 requires Node ≥22.12, which raised the floor from Next's ≥20.9. · Current stable version; `src/` separates routes from server modules. · active
- **D-011 · Cache Components off.** · With it on, GET route handlers that read no request data are prerendered at build and frozen, a trap for the cron and polling routes. · active
- **D-012 · `proxy.ts` (not `middleware.ts`), Node runtime everywhere, no Edge. `proxy.ts` is never the only auth layer; handlers re-check.** · Next 16 deprecates middleware and Edge; sharp and pg need Node. · active
- **D-013 · Postgres driver: `pg` + `drizzle-orm/node-postgres` with `attachDatabasePool`.**
  - Pool: `max 10, idleTimeoutMillis 5000, connectionTimeoutMillis 3000, query_timeout 10000`.
  - Rejected: neon-http (no interactive transactions) and postgres.js (pipelining issues behind transaction poolers, and `attachDatabasePool` can't hook it).
  - · Reason: Neon recommends TCP plus a pool on Vercel Fluid. This gives one code path for Neon, Supabase and local Postgres, and a connect timeout so a saturated pool can't hang webhooks. · active
- **D-014 · Neon via the Vercel Marketplace is the production database, with schema-only preview branches.** · Native integration that injects pooled and unpooled URLs. Default preview branches would copy production health data that DELETE can't reach. · active
- **D-015 · drizzle-orm 0.45.4 and drizzle-kit 0.31.11, pinned (not the v1 RC).**
  - `scripts/migrate.ts` takes an advisory lock and then asserts applied-row count and file hashes.
  - `db:check` asserts schema and migrations match and that journal timestamps increase.
  - · Reason: 0.45 is stable. Its migrator silently skips out-of-order migrations, so the checks are mandatory. · active
- **D-016 · Local and test databases:**
  - dev: `npm run dev` auto-starts a PGlite socket server on 127.0.0.1:54330 (8 connections, pg_trgm; the dev pool is capped at 4 and kept as a `globalThis` singleton across HMR), or any Postgres via `DATABASE_URL`;
  - unit tests: in-process PGlite;
  - the node-postgres project plus race tests: real PG16 (`npm run test:pg` starts a throwaway cluster, or uses `TEST_DATABASE_URL`).
  - · Reason: zero install for the owner. PGlite serializes everything (races are invisible there) and returns different raw types than pg, so the pg suite is required for milestone sign-off. The research suggested `-m 1`, but the reviewer verified that a single PGlite connection resets any second client (migrate, seed, eval), so we override it. Port 5432 collides with local Postgres installs. · active
- **D-017 · Zod v4 for validation. Each tool has a bound-free wire schema for `input_schema` and a separate validation schema with bounds.** · Strict tools reject `minimum`, `maximum` and similar keywords, which Zod emits. A unit test enforces the keyword allowlist and the strict budgets. · active
- **D-018 · Anthropic TypeScript SDK 1.3.0, plain `messages.create` tool loop (no tool runner, no Agent SDK).** · Per SPEC. · active
- **D-019 · Columns use `text` + CHECK instead of pgEnum. Nutrient values are `double precision` or integer, never `numeric`. Aggregates use `sqlNumber()` (`.mapWith(Number)`). App code is typed against the base `PgDatabase`. Columns whose keys have a digit after a capital letter get explicit SQL names.** · Value sets change each milestone. pg returns numeric and bigint aggregates as strings while PGlite returns numbers. `casing: snake_case` turns `phoneE164` into `phone_e_164`. · active
- **D-020 · Product tunables live in `src/server/config/policy.ts`; env holds only secrets and wiring. Env is validated lazily (`getEnv()`), eagerly in `instrumentation.ts`, and a test asserts schema keys equal `.env.example` keys.** · Owner-reviewable diffs. Import-time validation would break `next build`, tests and scripts. · active

## Anthropic usage

- **D-030 · Never send `temperature`, `top_p` or `top_k`.** · API version 2026-10-21, which SDK 1.x sends, returns 400. · active
- **D-031 · Never use forced `tool_choice` on Sonnet 5.5; use `auto` plus `strict: true` on the write tools only (`log_meal`, `edit_or_delete_meal`, `save_supplement`).** · Sonnet 5.5 rejects `any`/`tool`. Strict budgets are ≤20 tools, ≤24 optional params and ≤16 unions, and the first use of a schema pays grammar-compile latency. · active
- **D-032 · Never replay earlier turns' assistant, thinking or tool blocks. History is alternating text-only user/assistant messages, with code-written photo summaries and `[totals]` in place of past totals lines.** · Avoids preserved-thinking 400s, keeps the cache prefix stable, and stops the model copying stale numbers. · active
- **D-033 · Caching: 1 h `cache_control` on the last tool and on the static system prompt, plus an automatic 5-minute breakpoint on each request.** · The shared prefix is reused across users at sparse traffic, and loop iterations reuse the turn prefix. This cuts the estimated photo-turn cost from ~$0.065 to ~$0.04. · active
- **D-034 · `MODEL_MAIN_EFFORT` defaults to `medium`, constant within a turn, tuned by eval sweeps (effort low/medium, plus thinking `between_tools`). `max_tokens` 8000 for Sonnet, 1024 for Haiku.** · Latency matters for texting. Changing effort mid-turn invalidates the cache. The SDK refuses non-streaming calls above about 21k `max_tokens`. · active
- **D-035 · One invocation deadline `D` drives every timeout.**
  - Each Anthropic call gets an `AbortSignal`, `timeout = min(60 s, remaining − 45 s)` and `maxRetries` of 1 only when more than 150 s remain.
  - 30 s is reserved for sends.
  - A turn doesn't start with less than 150 s left (hand off instead).
  - · Reason: SDK 1.3.0 honours `retry-after` up to about 24 days, and only an abort signal interrupts it. · active
- **D-036 · `metadata.user_id` = opaque user UUID; SDK OpenTelemetry disabled; `ANTHROPIC_LOG` cannot be debug in production.** · Privacy. · active
- **D-037 · Images go as base64 blocks only: no URL sources, no Files API.** · URL sources would need public URLs to health photos, and the Files API isn't ZDR-eligible. · active
- **D-038 · ~~No server-side refusal fallback.~~ Superseded 2026-10-30: requests use the beta endpoint with `fallbacks: "default"` (`server-side-fallback-2026-07-01`), toggled by `ANTHROPIC_FALLBACKS`. A `refusal` that still comes back gets a canned caring reply with resources.** · Anthropic's current guidance is to enable the fallback by default for Sonnet 5.5. It only retries `cyber` and `frontier_llm` declines, so it rarely matters here, but it costs nothing when unused. Our likely category (`general_harms`) still gets the canned reply. · active
- **D-039 · Haiku triage uses `messages.parse` + `zodOutputFormat` with thinking off. It runs during the debounce wait, and only its result fields are stored.** · Takes it off the latency critical path; stores no extra copy of the text. · active

## Pipeline

- **D-040 · Background work runs in `after()` over a DB state machine:**
  - a heartbeat lease (45 s TTL, renewed every 15 s, fenced on a per-call random UUID);
  - lease-first, then wait for `process_after` by re-reading and re-sleeping, never exiting on an early wake;
  - a claim gated on `process_after <= $now` and lease ownership;
  - release, then recheck;
  - an opportunistic global sweep at the end of every kick;
  - self-handoff via `/api/internal/kick` when time runs low.
  - Vercel Queues is not used (public beta).
  - · Reason: in the reviewer's PG16 simulation, v1's "exit if no lease row" design stranded messages (1 in 7 runs with zero clock skew; ~80% of messages with 3 ms skew). The lease-first design stranded 0 with no split bursts or overlapping turns. · active
- **D-041 · Every time-sensitive SQL statement takes `$now` from the injected Clock; DB `now()` is used only for `created_at` defaults.** · Fake-clock tests for debounce, lease, quiet hours and DST become possible. Skew between instances is milliseconds, and the D-040 algorithm tolerates it by re-reading. · active
- **D-042 · Debounce `DEBOUNCE_MS=4000` from the newest message, capped at `MAX_DEBOUNCE_MS=15000` from the burst's first message.** · SPEC value. The cap stops a long stream from delaying the reply indefinitely. Re-measured against real Sendblue webhook gaps in M6. · active
- **D-043 · The dedupe row commits before the 200; a DB failure returns 503. A duplicate delivery of a still-pending message re-kicks.** · Provider redelivery is the only path back for an unrecorded message, and it doubles as a free retry. · active
- **D-044 · Reply sends are at-most-once.**
  - Bubbles are written as intents keyed `reply:<anchor_inbound_id>:<i>` before sending.
  - An ambiguous result becomes `unknown` and is never auto-resent.
  - Sendblue `maxRetries: 0`.
  - Orphaned turns recover as: send unsent intents; else send a deterministic recap if side effects were committed; else re-run.
  - · Reason: Sendblue send has no idempotency key. A rare missing bubble beats duplicate texts and double-logged meals. · active
- **D-045 · Turn clock = `max(sent_at)` of the burst; it drives `local_date` and "today".**
  - Turns more than 10 min late acknowledge the delay.
  - Turns more than 12 h late ask before logging, and are held until quiet hours end.
  - · Reason: midnight correctness and stale re-drives. · active
- **D-046 · Mid-turn messages become the next turn under the same lease. Exception: if no side effect or intent exists yet, the model call is aborted and everything is re-claimed as one turn.** · Keeps the tool loop append-only while fixing late-arriving captions. · active
- **D-047 · Group chats, tapbacks, outbound echoes and non-E.164 handles (Apple ID emails) are acknowledged and never persisted; only counts are kept.** · MVP scope; avoids storing third parties' messages. · active
- **D-048 · No transaction or checked-out client spans an LLM, provider, blob or sleep await. Every fire-and-forget promise goes through a catch-and-log helper.** · Pool starvation and unhandled rejections affect every invocation on a Fluid instance. · active
- **D-049 · Every turn side-effect write (meals, supplements, profile, outbound intents) is fenced on still holding the lease. `ensureMedia` and `ensureTriage` wait briefly for in-flight work, then do it inline under the lease.** · A stalled holder can't commit after a takeover, and turns never run without their photo or triage result. · active

## Media

- **D-050 · Keep only the resized, auto-oriented, EXIF-stripped JPEG. Purge after `MEDIA_RETENTION_DAYS=30`; purging keeps the row and nulls the key.** · Data minimization: EXIF can hold GPS. Purges must not cascade into meal history. · review
- **D-051 · Resize with a port of Anthropic's `resizedSize` at the high-res tier (≤2,576 px, ≤4,784 visual tokens) for everything at first.** · Labels and menus need it. A lower meal-photo budget (~1,568 tokens) will be decided from eval cost and accuracy data. · active
- **D-052 · HEIC→JPEG via libheif WASM (`heic-convert`/`heic-decode`, LGPL-3.0) in a `worker_threads` pool.** · Prebuilt sharp can't decode HEVC HEIC. The decode is synchronous and CPU-heavy, so it must not block the shared event loop. LGPL is fine for server-side use. · active
- **D-053 · Media download is single-flight (a claim with `claimed_until`), uses deterministic keys (`users/<uid>/<media_id>.jpg`), has a 15 s timeout and a byte cap. The turn waits up to 20 s for in-flight downloads.** · Prevents duplicate downloads, orphan blobs and photo-less turns. · active
- **D-054 · Private Vercel Blob in production, local filesystem in dev. Outbound images go via Sendblue `/api/upload-file`, never via public links to user photos. A nightly orphan GC removes blobs with no user or media row.** · Health photos must never be at public URLs. · active

## Nutrition

- **D-060 · Two-step grounding: `search_foods` returns candidates, the model picks `fdc_id` + quantity + unit, and code converts and computes. `log_meal` rejects `fdc_id`s not returned by this turn's search, the draft, or today's meals.** · Keyword search is weak and Branded floods results. The guard also stops parallel tool calls from logging guessed IDs. · active
- **D-061 · Items are `{quantity, unit: g|ml|oz|fl_oz|portion, portion_ref}`; code converts using FDC portion weights and the food's g/ml basis.** · SPEC: all arithmetic in code. Count × portion and oz → g are arithmetic. · active
- **D-062 · Search ranks by relevance first: the union of pg_trgm `word_similarity` and full-text search, then a data-type boost (FNDDS > SR Legacy > Foundation; Branded only for packaged items), with near-duplicates merged.** · Reviewer experiment: plain `similarity()` with data-type-first ordering drops the correct records. · active
- **D-063 · Energy chain 1008 → 2047 → 2048 → kJ/4.184 → Atwater 4/4/9 (marked derived), with the source recorded per item. The FDC record is snapshotted on each item.** · Foundation foods often lack 1008. 2047 matches FNDDS. FDC IDs and values change between releases. · active
- **D-064 · Local FDC seed (FNDDS + SR Legacy + Foundation, about 13.6k foods) plus the live API for Branded and misses. FNDDS mixed dishes get `includes_added_fat` and `includes_sauce` flags at seed time, and add-ons need `extra_beyond_recipe`.** · Rate limits, latency, reproducible evals, and no double-counting of oil. · active
- **D-065 · FDC fixtures carry provenance: `recorded` (owner-run `npm run fdc:record`), `third-party-capture <url>` (shape tests only), or `synthetic` (never used as expected nutrition values).** · FDC hosts are unreachable from the build container, and the SPEC forbids memory-sourced data. · active
- **D-066 · Clarification is decided in code.**
  - Trigger: kcal spread ≥ max(150 kcal, 25% of the meal), or a hidden-calorie category taken from the FDC food category plus the model's `possible_additions`.
  - Code returns a typed question with 2–4 options mapped to grams; the model never asks in grams.
  - One question per meal. Asking backs off for 7 days after two "just estimate" replies.
  - · Reason: makes "ask ONE short question" deterministic and testable without trusting self-reported confidence. · review
- **D-067 · At most one open draft per user, excluded from totals. It auto-commits at the point estimate on a new meal, when the next turn doesn't address it, or after 2 h.** · Defined lifecycle; no orphan drafts. · active
- **D-068 · The totals bubble is appended by code. A number-source check rejects any unit-bearing number in model text that didn't come from tool results or context (one corrective retry, then strip).** · SPEC: arithmetic never happens in the model, and the model shouldn't be the one printing totals. · active
- **D-069 · Default targets before a profile exists: 2,000 kcal and 100 g protein. Suggestions are fit against `max(remaining, MIN_MEAL_KCAL=400)` and never suggest skipping.** · M2 needs targets before M4. The fit rule enforces the "never praise restriction" spirit. · active
- **D-069a · Text questions and dinner suggestions use `evaluate_options` (from M2) or quantity-aware `search_foods`, so answers like "protein in 3 eggs" never need model arithmetic. Profile questions after consent are asked one at a time and are all skippable; skipping never blocks logging.** · SPEC: all arithmetic in code; everything in onboarding is skippable. · active

## Supplements

- **D-070 · The UL table is versioned TypeScript data. Each row has `source_url`, the sheet's updated date, `retrieved_at` and `verified: true`; only rows verified against the live NIH ODS page are included.** · Reviewable diffs. SPEC forbids values from memory. A nutrient with no verified row gets "no verified upper limit on file". · active
- **D-071 · The folic-acid UL is checked in mcg of folic acid, never DFE.** 5-MTHF counts as "indeterminate". Only preformed retinol counts for vitamin A. Vitamin E IU uses the synthetic factor when the form is unknown. Label amounts are treated as elemental (21 CFR 101.36). · Avoids false alarms on standard prenatals and false negatives on mineral salts. · active
- **D-072 · Aggregation reports both the average daily dose and the max single-day dose. Duplicates are keyed on `nutrient_key`, or else the normalized ingredient name.** · Weekly megadoses and unmapped ingredients (caffeine, melatonin) are caught. · active
- **D-073 · Adult (19+) ULs apply to all users, including 18-year-olds.** · Simpler, and users are 18+. The 14–18 band has lower ULs for some nutrients; the exact values are re-checked on ODS in M3, and that band can be applied if a user gives an age of 18. · review

## Safety, consent and messaging

- **D-080 · Consent, age, proactive opt-ins, STOP/START/HELP/DELETE/MY DATA and the emergency and crisis replies are deterministic code paths. The LLM never decides consent.** · MHMDA "clear affirmative act"; WA private right of action; TCPA. · active
- **D-081 · Order: per-message screen at ingest (keywords; crisis, ED and opt-out phrases; tags only) → priority path in kick (crisis copy and the one STOP confirmation, outside the lease and debounce) → TurnRouter: handled rows → commands → onboarding → triage/care → access gate → agent. No onboarding, billing or debounce state can suppress a safety reply or an opt-out.** · Emergency, ED and opt-out handling must reach gated and pre-consent users too. · active
- **D-082 · Keywords and crisis, ED and opt-out phrases are matched per inbound message at ingest, on the in-memory text, never on a batched burst. ED patterns are phrase-level, never bare words like "starving". Priority intents (crisis copy, the one STOP confirmation) are written in the ingest transaction, keyed `priority:<id>:crisis` / `priority:<id>:stop`, and sent through a conditional claim, exempt from lease fencing. Re-driven kicks never re-screen. The `priority`, `safety` and `command` outbound kinds are exempt from the pause check. STOP sets the pause inside the ingest transaction, and OutboundSender re-checks pause right before every individual send.** · Batching would swallow STOP; in-flight replies and check-ins would go out after STOP. · active
- **D-083 · STOP revokes every proactive category and sends exactly one confirmation; a provider `OPTED_OUT` on that confirmation counts as already confirmed. START resumes replies only; each check-in category needs a fresh opt-in. CANCEL stays in the STOP family.** · FCC/CTIA. Stricter than the per-category option in FCC 26-67. · active
- **D-084 · Natural-language opt-outs are classified with a scope (all, proactive_all, proactive:<kind>). "All" = STOP; scoped ones toggle a category; ambiguous ones get one confirming question.** · FCC: revocation by any reasonable means. Avoids over-pausing on "stop the morning texts". · active
- **D-085 · Age is asked neutrally ("How old are you?"). The age answer is stored as NULL text plus `keyword='age_answer'`, and only the 18+ boolean is kept. Birth year may be asked later, optionally, for targets. Under 18: decline, delete everything, keep an HMAC(phone) suppression row that ingest checks before creating a user; permanent, no re-ask.** · Neutral age screen; COPPA caution. · active
- **D-086 · From M4, before consent, text is stored only for commands and YES/AGREE replies (age answers are stored as a tag); no media rows or URLs are stored, and photos are discarded with a "send it again after YES" reply.** · MHMDA requires consent before collection. (Supersedes v1's "store then null".) · active
- **D-087 · Consent copy is stored pre-split in `policy_versions`. The consent event hashes exactly the bubbles sent and stores all of their outbound IDs and delivery status. Accepted replies: YES, Y, AGREE or I AGREE (whole message). In M6 the YES is verified by fetching it back from the provider.** · The record must prove what the user actually saw. Sendblue's webhook secret is static. · active
- **D-088 · Withdrawal of consent = DELETE. MY DATA records a rights request with a 45-day clock (manual fulfillment for the MVP).** · MHMDA access and deletion rights; simple, true consent copy. · active
- **D-089 · DELETE is confirmed with "YES DELETE" within 10 minutes (an intervening message cancels it), and works while paused.**
  - The prompt states the scope (whole account vs one meal) and the provider-record limits.
  - Order: cancel and delete in Stripe (on failure, the IDs go to `pending_deletions` for retry and the wipe proceeds) → delete the users row → delete blobs by prefix → write the receipt → send the final message directly through the adapter (no stored row).
  - If the prompt can't be delivered (provider `OPTED_OUT`), `YES DELETE` within 10 minutes of a DELETE is still accepted; the two-step flow is published in HELP and the CHD notice. A bare DELETE that is never confirmed while sends are blocked becomes a 45-day rights request, fulfilled through support. This keeps the SPEC's confirmation step.
  - · Reason: distinct from consent YES and from "delete that meal". FTC §5 accuracy. · active (fallback: counsel)
- **D-090 · Medical context is kept as coarse persistent booleans (rx meds, pregnant/nursing, condition), never free text. Conditions never change targets. Supplement results carry a code-computed `advise_pharmacist`.** · SPEC pharmacist rule across turns; FDA general-wellness boundary. · active
- **D-091 · Triage failure (timeout, refusal, parse error) fails safe: numbers are suppressed and resources appended, never the plain agent. Only a genuine Haiku failure counts; a still-pending triage is first awaited or run inline (`ensureTriage`). A long care cooldown (14 days) needs corroboration: a keyword hit, a computed signal, or a second "high" within 7 days. A single "high" gets a 3-day short cooldown. "Possible" suppresses totals for that turn; only a corroborated "possible" starts the 14-day window. Exiting a cooldown needs an explicit re-opt-in.** · Safety without one-off false positives locking a user out. · active
- **D-092 · ED guardrail defaults (config): kcal floor 1,200 female / 1,500 male / 1,500 unspecified; max weekly loss min(0.9 kg, 1% of body weight) with deficit ≤1,000 kcal/day; cooldown 14 d (short cooldown 3 d); "possible" window 14 d; below-floor streak 3 d; the underweight-BMI rule waits until the cut-off is verified from CDC/NIH.** · Commonly cited heuristics; SPEC asks for owner review. · review
- **D-093 · The helpline is held in config with `verified_at`: National Alliance for Eating Disorders 1-866-662-1235 (sources also show 622), plus 988 and "text ALLIANCE to 741741". Re-verified before M4 ships.** · A wrong digit is a safety defect. · active
- **D-094 · Quiet hours default to 21:00–08:00 local, per SPEC.** Some state laws (FL, OK, WA; search-only) use 8 pm for solicitations; our check-ins are opt-in and informational. · Kept the SPEC default; flagged. · review
- **D-095 · Proactive check-ins:**
  - opt-in per category via a deterministic YES prompt (next message, within 24 h), which also confirms the timezone; default off;
  - one bubble each;
  - order: read-only pre-check (lease free, no pending or recent inbound, unanswered < 2) → atomic claim (per-local-day counter < 2, unanswered < 2, no check-in of the same kind within 20 h, line counter) → lease → send once;
  - `unanswered_proactive_count` is incremented only after a `sent`/`unknown` result; a lease miss, a pause hit, or `opted_out`/`failed`/`rate_limited` is compensated;
  - priority weekly > morning > evening > supplement; a supplement reminder folds into the morning or evening message when due together, and is otherwise sent alone;
  - never sent to gated users, users in cooldown, or users without a confirmed timezone;
  - never contain pricing or links.
  - · Reason: TCPA prior express consent. The reviewer's experiment showed count-then-send caps are exceeded under overlapping ticks. The per-local-day counter matches SPEC's "per user per day"; a single counter column cannot represent a rolling 24 h window. · active
- **D-096 · `GLOBAL_DAILY_CAP_PER_LINE=150`, counted on the provider's day.** · Sendblue's AI Agent plan allows 200 follow-up contacts per line per day (reset 3 AM ET). · review
- **D-097 · Timezone resolution: the user's stated timezone, then the simulator's browser timezone, then `DEFAULT_TIMEZONE`. No area-code inference. If a guessed timezone is corrected, meals are re-dated (never days before today when the earlier value was user-set). `meals` stores `local_date` and `tz`.** · libphonenumber-js ships no timezone data, and area codes are weak signals for mobile numbers. · active
- **D-098 · Retention: message text 90 days; photos 30 days; users who never consented deleted after 30 days.** · Data minimization; MHMDA and FTC retention expectations. · review
- **D-099 · Default: keep nothing after DELETE except non-identifying receipts; no hashed suppression record for opted-out or deleted users until counsel approves (minors excepted).** · MHMDA has no explicit exemption. · counsel

## Platform and ops

- **D-100 · The cron endpoint is idempotent and catch-up based, so any trigger works (Vercel Pro `*/15`, GitHub Actions, manual). The Hobby daily cron is not relied on for recovery; the opportunistic sweep and handoff handle that.** · The owner's account is Hobby (daily cron, non-commercial only). · review
- **D-101 · `/admin`: app-level HTTP Basic auth (`ADMIN_USER`/`ADMIN_PASSWORD`, high-entropy and validated, timing-safe), aggregates only (no phone numbers, text, photos or per-user drilldown), `Cache-Control: no-store`, rate-limited failed logins. Metrics come from a non-identifying `metrics_daily` table plus today's live counts. "Receive" means inbound turns.** · Vercel Password Protection isn't on Hobby. Least privilege. Purges must not rewrite history. · active
- **D-102 · The simulator is hard-off when `VERCEL_ENV=production`, whatever the flag says. It accepts only fictional `+1NPA55501XX` numbers and needs admin auth on previews. Users are unique by phone across providers, so a provider switch keeps them.** · A misconfigured env must not expose real users' threads. · active
- **D-103 · Errors are sanitized centrally (a wrapper on every route and `after()` task, plus `onRequestError`): only name, SQLSTATE, constraint and table are logged. A CI canary test enforces it.** · `DrizzleQueryError.message` embeds bound parameters and pg errors include "Failing row contains (…)". · active
- **D-104 · No analytics, pixels or third-party scripts on any page, including the pay pages.** · SPEC; FTC health-data enforcement history. · active
- **D-105 · Launch gate (end of M6): the Sendblue line stays limited to the owner's test numbers until processor DPAs/terms, live counsel-reviewed policy and CHD notice URLs, an HBNR breach runbook and an Anthropic retention position exist.** · MHMDA processor contracts; FTC HBNR readiness. · review

## Milestone 1 build choices

- **D-120 · `LLM_PROVIDER=fake` runs a deterministic offline model that describes what it received (photo count, dimensions) without calling the API.** · Lets the owner try the full simulator → pipeline → reply loop without an Anthropic key. Tests use a separate scripted fake. · active
- **D-121 · The full 4 s debounce and lease algorithm ships in M1; M2 adds the batching-specific tests and tuning.** · It is the same code either way, and a debounced M1 behaves like the real product. (The plan had said `DEBOUNCE_MS=0` in M1.) · active
- **D-122 · No `next/font/google`: the system font stack only.** · No third-party requests at build or run time (SPEC: no trackers), and the build container can't reach Google Fonts. · active
- **D-123 · The simulator posts one inbound event per attached image plus one for the text.** · Mirrors Sendblue's one-webhook-per-attachment behaviour, so turn batching is exercised in dev. · active
- **D-124 · Pipeline modules receive media and agent entry points through `deps.pipeline` (contracts in `src/server/pipeline/contracts.ts`).** · Each module can be built and tested in isolation, and tests stub the others. · active
- **D-125 · `package.json` is `"type": "module"`; all scripts run through `tsx --conditions=react-server` with `scripts/_env.ts` loading `.env.local` via `@next/env`.** · `server-only` throws without that condition, and plain tsx doesn't load env files. · active

## Billing (M7)

- **D-110 · The trial lives in our DB (7 days from consent, no card, no Stripe objects). USD, monthly plan only. Stripe objects are created at Checkout.** · Avoids card-network trial rules. Price is an owner question. · review
- **D-111 · Links are our own `/pay/<token>` and `/billing/<token>` routes. They create or reuse a Checkout or Portal session on click and are multi-use within their TTL.** · Checkout sessions expire within 24 h, and iMessage link previews would otherwise burn them. · active
- **D-112 · The paywall reply carries no price and no link ("Reply SUBSCRIBE for a payment link"). Links go out only on an explicit request. Check-ins never carry commercial content.** · RCW 19.190 commercial-text consent; TCPA advertisement rules. · counsel
- **D-113 · Only the user UUID goes into Stripe metadata and `client_reference_id`. `stripe_events` stores only event ID, type and processed time.** · No health data at processors that don't need it. · active
