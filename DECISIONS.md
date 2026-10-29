# Decisions log

Choices made without asking because they have a sensible default (per SPEC "How to work").
Format: ID · decision · reason · status. Status values: **active**, **review** (owner should look; not blocking), **superseded**.
Research backing each item is in `docs/research/` (retrieved 2026-10-29).

## Repo and process

- **D-001 · Build in this repo on branch `claude/imessage-nutrition-coach`.** The pre-existing `index.html` and `privacy.html` (an unrelated personal-finance page) stay untouched; Next.js ignores root HTML files. · Only repo in scope; no reason to disturb existing files. · active
- **D-002 · Research notes are committed under `docs/research/` with retrieval dates and verification tags.** · Several docs sites are blocked from the build container, so facts are tagged by how they were verified. Integration code re-checks `[search]` facts before relying on them. · active

## Stack

- **D-010 · Next.js 16.4.3 (latest), App Router, `src/` directory, Turbopack, npm.** · Current stable. A `src/` directory separates app routes from server modules. · active
- **D-011 · Cache Components off.** · With it on, GET route handlers that read no request data are prerendered at build and silently frozen. That is a trap for webhooks and the cron. · active
- **D-012 · `proxy.ts` (not `middleware.ts`), Node runtime everywhere, no Edge.** · Next 16 deprecates middleware and the Edge runtime; sharp and pg need Node. · active
- **D-013 · Postgres driver: `pg` + `drizzle-orm/node-postgres` with `attachDatabasePool`.** Rejected: neon-http (no interactive transactions) and postgres.js (pipelining issues behind transaction poolers; `attachDatabasePool` can't hook it). · Neon's own recommendation for Vercel Fluid compute is TCP plus a pool, and it gives one code path for Neon, Supabase and local Postgres. · active
- **D-014 · Neon (via the Vercel Marketplace) is the production database.** · Native Vercel integration that injects pooled and unpooled URLs, with preview branching. Supabase also works with the same code (set `prepare:false` is not needed with pg). · active
- **D-015 · drizzle-orm 0.45.4 and drizzle-kit 0.31.11, pinned; not the v1 RC.** · Stable. The Drizzle docs now default to v1 syntax, so CLAUDE.md warns about it. A CI check enforces increasing journal timestamps, because the 0.45 migrator silently skips out-of-order migrations. · active
- **D-016 · Local dev DB: `npm run db:dev` starts `pglite-server` (zero install), or any Postgres ≥16 via `DATABASE_URL`. Unit tests use in-process PGlite; race tests run against a real server when `TEST_DATABASE_URL` is set.** · The owner can run everything without Docker or cloud accounts. PGlite's single connection can't reproduce races, hence the separate suite. · active
- **D-017 · Zod v4 for all validation; tool `input_schema` is generated with `z.toJSONSchema()`.** · One schema source for tool definitions and runtime validation. · active
- **D-018 · Anthropic TypeScript SDK 1.3.0, plain `messages.create` tool loop (no tool runner, no Agent SDK).** · Per SPEC. · active

## Anthropic usage

- **D-020 · Never send `temperature`, `top_p` or `top_k`.** · API version 2026-10-21, which SDK 1.x sends, returns 400 for them. · active
- **D-021 · Never use forced `tool_choice` on Sonnet 5.5; use `auto` plus `strict: true` on critical tools.** · Sonnet 5.5 rejects `any` and `tool` with 400. · active
- **D-022 · Never replay assistant, thinking or tool blocks from previous turns; history is plain text (inbound text, our replies, one-line photo summaries).** · Avoids preserved-thinking 400s, keeps prompts small and keeps the shared cache prefix stable. · active
- **D-023 · Cache tools and the static system prompt with a 1 h TTL; everything per-user goes after the breakpoint.** · Traffic is bursty and sparse; 1 h writes cost 2x base but a single read costs 0.05x. · active
- **D-024 · `MODEL_MAIN_EFFORT` defaults to `medium`, tuned with `npm run eval`.** · Texting needs low latency; sampling params are unavailable, so effort is the main lever. · active
- **D-025 · Anthropic client: `timeout` 60 s, `maxRetries` 1, inside a 240 s turn budget (300 s `maxDuration`).** · The SDK retries timeouts, so the retry count must fit the function's deadline. · active
- **D-026 · `metadata.user_id` = our opaque user UUID; never the phone number. SDK OpenTelemetry disabled.** · Privacy. · active

## Pipeline

- **D-030 · Background work uses Next `after()` plus DB state: a `process_after` debounce deadline, a per-user lease (`UPDATE … RETURNING` fenced on `lease_owner`), and a stale-turn sweeper. Vercel Queues not used for now.** · Queues is public beta with experimental concurrency keys. Session advisory locks break behind Neon's PgBouncer. A lease row works on every driver and pooler. The runner sits behind an interface so Queues can be swapped in later. · active
- **D-031 · Lease TTL 330 s, longer than `maxDuration` (300 s).** · A live invocation must never lose its lease mid-turn; a crashed one is recovered after expiry. · active
- **D-032 · Debounce: 4 s (`DEBOUNCE_MS`), measured from the newest message in the burst.** · Per SPEC. Sendblue sends one webhook per attachment, so batching is required. · active
- **D-033 · Group chats, tapbacks, outbound echoes and non-E.164 handles (Apple ID emails) are acknowledged with 200 and ignored.** · MVP scope; SPEC normalizes to E.164. · active
- **D-034 · Outbound sends carry our own idempotency key; Sendblue sends use `maxRetries: 0` plus status reconciliation.** · The Sendblue SDK auto-retries non-idempotent POSTs, which could double-text. · active

## Media

- **D-040 · Keep only the resized, auto-oriented, EXIF-stripped JPEG; originals are not stored. Purge after `MEDIA_RETENTION_DAYS` (default 30).** · Data minimization: EXIF can hold GPS location, and photos are only needed to process the turn. · review
- **D-041 · Resize with a port of Anthropic's published `resizedSize` algorithm at the high-res tier (≤2,576 px long edge, ≤4,784 visual tokens).** · Labels and menus need resolution; one size keeps the pipeline simple. Meal-photo downsizing can be revisited with eval cost data. · active
- **D-042 · HEIC→JPEG via `heic-convert` (WASM libheif, LGPL-3.0) when the sniffed type is HEIC.** · Prebuilt sharp cannot decode HEVC-encoded HEIC, and the Claude API accepts only JPEG, PNG, GIF and WebP. LGPL is fine for server-side use. · active
- **D-043 · Private Vercel Blob in production, local filesystem in dev, behind `MediaStorage`.** · Health photos must not be at public URLs. Outbound images go via Sendblue `/api/upload-file`, never via public links to user photos. · active

## Nutrition

- **D-050 · Two-step grounding: `search_foods` returns FDC candidates, the model picks fdcIds and grams, then `log_meal` computes.** · Never trust search hit #1; keyword search relevance is weak and Branded floods results. · active
- **D-051 · Source priority for generic foods: FNDDS > SR Legacy > Foundation; Branded only for packaged items.** · FNDDS covers mixed dishes and portion weights, and has energy for every food. · active
- **D-052 · Energy chain 1008 → 2047 → 2048 → kJ/4.184 → Atwater 4/4/9, recording the source on each item.** · Foundation foods often lack 1008. · active
- **D-053 · Snapshot fdc_id, data type, description, release and per-100 g values on each logged item.** · FDC IDs and values change between releases. · active
- **D-054 · Local FDC seed (`npm run fdc:seed`: FNDDS + SR Legacy + Foundation, about 13.6k foods) plus the live API for Branded and misses. Caches: fdcId → record indefinitely; query → candidates 30 days.** · Stays under the 1,000 requests/hour key limit, lowers latency and makes evals repeatable. · active
- **D-055 · Clarification rule in code: ask when a low-confidence item's kcal range ≥ `CLARIFY_MIN_KCAL_RANGE` (default 150), or when it is a hidden-calorie category. Max one question per meal.** · Makes "ask ONE short question before logging" deterministic and testable. · review
- **D-056 · Default targets before a profile exists: 2,000 kcal and 100 g protein (config).** · M2 meal logging needs targets before M4 onboarding collects a profile. · active

## Supplements

- **D-060 · The UL reference table is a versioned TypeScript data file with `source_url`, the sheet's updated date and `retrieved_at` per row. Only rows verified against the live NIH ODS page are seeded.** · Reviewable in diffs and testable. SPEC forbids values from memory. · active
- **D-061 · Adult (19+) ULs are applied to all users, including 18-year-olds.** · A single adult table is simpler; the 14–18 band differs only slightly and users are 18+. · review

## Safety, consent and messaging

- **D-070 · Consent and age gating are deterministic code paths; the LLM never decides that consent was given.** · MHMDA requires a clear affirmative act, which carries litigation risk under WA's private right of action. · active
- **D-071 · Age is asked neutrally ("How old are you?"), not as "reply YES if 18+".** · Neutral age screens are the recommended practice. · active
- **D-072 · Pre-consent message content is transient: no LLM, no media download, and text is nulled right after the onboarding turn.** · "Do not persist health content before YES", while still allowing dedupe and debounce. · review
- **D-073 · STOP sends exactly one confirmation and then nothing except replies to START, HELP and DELETE.** · CTIA and FCC allow one confirmation; SPEC says STOP pauses all outbound. · active
- **D-074 · DELETE is confirmed with a YES within 10 minutes.** · Prevents accidental wipes. · active
- **D-075 · Quiet hours default 21:00–08:00 local, per SPEC.** Some state mini-TCPA laws (reported for FL, OK and WA; search-verified only) use 8 pm for solicitations; our check-ins are opt-in and non-marketing. · Kept SPEC default; flagged. · review
- **D-076 · Eating-disorder guardrail defaults (config): minimum daily kcal 1,200 (female), 1,500 (male), 1,500 (unspecified); maximum weekly loss min(0.9 kg, 1% of body weight).** · Commonly cited clinical heuristics; SPEC asks for owner review. · review
- **D-077 · The helpline number lives in config with a `verified_at` date; it is re-verified before M4 ships.** · Sources show conflicting digits (1-866-662-1235 vs 622). A wrong digit is a safety defect. · active

## Platform

- **D-080 · The cron endpoint is idempotent and catch-up based, so any trigger works: Vercel Pro every 15 minutes, GitHub Actions, or manual.** · The owner's account is Hobby (once-daily cron, non-commercial only). · review
- **D-081 · `/admin` uses app-level HTTP Basic auth (`ADMIN_USER` / `ADMIN_PASSWORD`, timing-safe) in `proxy.ts`, re-checked in handlers.** · Vercel Password Protection isn't on Hobby and protects whole deployments, which would block webhooks. · active
- **D-082 · No analytics, pixels or third-party scripts on any page.** · SPEC; FTC health-data enforcement history. · active
