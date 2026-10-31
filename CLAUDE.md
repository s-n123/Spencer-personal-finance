# CLAUDE.md: iMessage AI nutrition coach

An AI nutrition coach used entirely over iMessage: meal photos, menus, supplement labels, text questions, opt-in check-ins.

**Status:** M1 (scaffold) complete: simulator, message pipeline, photo handling, an agent that describes photos. Awaiting the owner's go-ahead for M2a. Update this line as milestones complete.

## Read first
- `SPEC.md`: the owner's spec, verbatim. **It is the source of truth.**
- `docs/PLAN.md`: architecture, flows, data model, milestones, open questions.
- `DECISIONS.md`: every default chosen without asking (`D-NNN · decision · reason · status`). Add an entry whenever you make a choice that has a sensible default; never silently change a decision.
- `docs/research/*.md`: dated vendor research. Tags: `[primary]` (read from official docs), `[sdk-source]` (official SDK code/types), `[search]` (search summary only). **Re-verify `[search]` facts against live docs before coding against them.**

## How we work (from SPEC)
- Build milestone by milestone. **Definition of done:**
  - `npm run check` and `npm run test:pg` are green;
  - `.env.example`, `DECISIONS.md` and this file are updated;
  - changes committed and pushed to the feature branch;
  - a short summary plus exact try-it steps;
  - **stop and wait for the owner's go-ahead.**
- Before writing integration code (Anthropic, Sendblue, USDA FDC, Stripe, NIH ODS), read the current docs. If a docs host is blocked, stop and ask; don't code from memory or `[search]` alone.
- **Never fill nutrition reference values (ULs, FDC numbers) from memory.**
- Don't ask the owner about things with sensible defaults: decide, then log in `DECISIONS.md`.
- No secrets in code. Keep `.env.example` in sync (a test enforces key parity with `src/server/config/env.ts`).
- Product tunables (caps, quiet hours, guardrails, debounce, retention, trial) live in `src/server/config/policy.ts`, not env.

## Commands

Rows marked with a milestone don't exist yet.

| Command | What it does |
|---|---|
| `npm run dev` | Loads env, auto-starts the PGlite socket server (127.0.0.1:54330), migrates, runs `next dev` on 127.0.0.1 (`-- -H 0.0.0.0` for the LAN) |
| `npm run check` | typecheck + lint + migration/schema check + unit tests |
| `npm test` | Unit tests only: PGlite, fake LLM, no network (a fake FDC arrives in M2a) |
| `npm run test:pg` | node-postgres suite + race tests on a throwaway PG16 (or `TEST_DATABASE_URL`) |
| `npm run db:generate -- --name <x>` | New migration. Never edit an applied migration |
| `npm run db:migrate` / `db:check` / `db:reset` / `db:studio` | Migration tooling |
| `npm run eval` (all suites) or `npm run eval -- --suite meals\|menus\|labels\|text\|safety` | **(M2b)** Runs fixtures through the agent via the simulator. Costs money and needs `ANTHROPIC_API_KEY` |
| `npm run fdc:seed` / `fdc:record` / `fdc:search -- "<q>"` | **(M2a)** FDC seed import, owner-run fixture recording, CLI search |
| `npm run cron:tick -- --at <ISO>` | **(M5)** Run the proactive/sweep tick at a simulated time (dev only) |
| `npm run fixtures:synthetic` / `fixtures:strip` | **(M2b/M3)** Generate synthetic label and menu images; strip metadata from owner photos |

Scripts run via `tsx --conditions=react-server` and load env through `scripts/_env.ts` (`@next/env`). Plain tsx doesn't load `.env.local`, and `server-only` throws without that condition.

## Architecture invariants (tested; don't break them)
- **The model estimates; code computes.** All kcal, grams, totals, remaining, unit conversions, UL comparisons and option scores come from tools.
  - The totals bubble is appended by code.
  - The number-source check rejects unit-bearing numbers in model text that didn't come from tool results or the context block.
- **Deterministic paths:** consent, age gate, proactive opt-ins, STOP/START/HELP/DELETE/MY DATA, emergency and crisis replies. The LLM never decides consent.
- **Order:** per-message screen at ingest (keywords, crisis/ED/opt-out phrases → tags only) → priority path in kick (crisis copy, the one STOP confirmation; outside the lease and debounce) → TurnRouter: handled rows → commands → onboarding → triage/care → access gate → agent. Nothing suppresses a safety reply or an opt-out.
- **Keywords and crisis phrases are matched per inbound message at ingest,** on the in-memory text, never on a batched burst. Re-driven kicks never re-screen. STOP sets the pause inside the ingest transaction, and priority intents (crisis copy, the one STOP confirmation) are written in that same transaction. OutboundSender re-checks pause before every single send; only the `priority`, `safety` and `command` kinds are exempt.
- **One turn per user at a time** via the DB lease (lease-first, heartbeat, fenced on a per-call UUID; never exit on an early wake). Every turn side-effect write is fenced on still holding the lease. Proactive composition takes the same lease.
- **Postgres is the only shared state.** Nothing per-request lives in module scope (Fluid runs many invocations per instance).
- **Time-sensitive SQL takes `$now` from the injected `Clock`.** Never `now()` in comparisons; DB `now()` is only for `created_at` defaults.
- **Provider-specific code stays in `src/server/channels/<provider>/`.**
- **DB pool:** max 10 in production; in dev, max 4 as a `globalThis` singleton (HMR), below the PGlite server's 8 connections.
- **Transactions are DB-only critical sections.** Never hold a transaction or checked-out client across an LLM, provider, blob or sleep await. Inside `db.transaction`, use `tx` only.
- **Wrap fire-and-forget promises** with the catch helper in `src/server/safe.ts`.

## Privacy rules
- **Never log** message bodies, photos, phone numbers, blob keys, LLM prompts or outputs, or raw provider payloads. Use `log.ts` (allowlisted fields) and user UUIDs.
- **Nothing in a log line may reveal a crisis or care inference** (crisis kind, turn mode `safety`/`care`, which priority copy was sent). `log.ts` masks those modes as `handled` (D-142).
- **Errors go through `sanitizeError()`.** Drizzle and pg error messages embed bound parameters ("Failing row contains …").
- **No analytics, pixels or third-party scripts** anywhere.
- **The GitHub repo is PUBLIC:**
  - only fictional numbers `+1NPA55501XX` in code, tests and docs;
  - owner photo fixtures are gitignored, case-insensitively (`fixtures/synthetic/` is committed; a hygiene test rejects any other tracked image under `fixtures/`);
  - provider payloads only through `scripts/capture-payload.ts` redaction;
  - `eval-results/` is gitignored.
- **Pre-consent (from M4):** store no free text (only commands and YES replies; age answers are stored as a tag), no media, no provider URLs. Until M4, simulator users are created as consented (dev-only).
- **Health photos:** private storage only, EXIF stripped, never served at public URLs, never sent to `/admin`.
- **`/admin` shows aggregates only.**
- **Simulator:** hard-off when `VERCEL_ENV=production`; fictional numbers only.

## Anthropic API gotchas (SDK 1.3.0, API version 2026-10-21)
- **Model IDs come from env only:** `MODEL_MAIN` (claude-sonnet-5-5), `MODEL_FAST` (claude-haiku-5-5).
- **Never send `temperature`, `top_p` or `top_k`** (400 on every model).
- **`tool_choice: auto` only.** Sonnet 5.5 rejects `any`/`tool`, including on count_tokens.
- **Strict tools** (`strict: true`, write tools only):
  - unsupported in the emitted schema: `minimum`, `maximum`, `multipleOf`, `minLength`, `maxLength`, `minItems`>1/`maxItems`, recursive or external `$ref`; `pattern` only if simple and free of user data;
  - use the bound-free wire schema plus a separate Zod validation schema;
  - stay within ≤20 strict tools, ≤24 optional params and ≤16 union params (a test checks);
  - no user data in enum, const or pattern.
- **Never replay** earlier turns' assistant, thinking or tool blocks. History is text-only.
- **Caching:** `cache_control` (1 h) on the last tool and on the static system prompt, nothing per-user before them, plus the automatic 5-minute breakpoint. Keep tool order and system text byte-stable. Keep effort and thinking constant within a turn.
- **Every call gets the turn `AbortSignal`** plus a deadline-derived `timeout` and `maxRetries`. The SDK otherwise honours `retry-after` for days, and `timeout` doesn't bound that sleep, so the signal also fires at the deadline (D-140).
- **Non-streaming `max_tokens` must stay ≤ ~21k** (the SDK throws). We use 8000 for Sonnet and 1024 for Haiku.
- **Handle every stop reason:** `refusal` (canned caring reply), `max_tokens` (never run tools from it), `pause_turn`.
- **Images:** base64 JPEG only (HEIC converted first), resized with the `resizedSize` port; no URL sources, no Files API. `metadata.user_id` = user UUID.

## Drizzle gotchas (pinned drizzle-orm 0.45.4 / drizzle-kit 0.31.11)
- **The online Drizzle docs show v1-RC syntax.** Don't copy `migrate(db)` without config, `defineRelations`, `drizzle-orm/zod`, or the journal-less folder layout. Check snippets against the installed `.d.ts`.
- **`casing: 'snake_case'` in both `drizzle()` and `drizzle.config.ts`.** Keys with a digit after a capital letter get split (`phoneE164` → `phone_e_164`), so give those columns explicit names.
- **Migrations:**
  - always `--name`; never edit an applied migration;
  - journal `when` values must increase (after a rebase, delete and regenerate your migration);
  - new NOT NULL columns need a default or a backfill;
  - no `push` except against a throwaway DB;
  - drizzle-kit needs a relative `out` path and can exit 0 after an error, so `db:check` parses its output.
- **Types:**
  - `text` + CHECK, not pgEnum;
  - nutrients are `double precision` or integer, never `numeric`;
  - wrap aggregates in `sqlNumber()`: pg returns count/sum/numeric as strings, PGlite returns numbers.
- **FKs:**
  - `user_id → users` CASCADE; parent → child CASCADE; references (`media_id`, `turn_id`, `*_message_id`) SET NULL;
  - index every FK column (Postgres doesn't do it automatically);
  - a schema test enforces this.
- **No PG18-only SQL** (local PG16 vs Neon/PGlite PG18).

## Next.js 16 gotchas
- **Routing and runtime:**
  - `proxy.ts`, not `middleware.ts`; Node runtime only;
  - Cache Components off;
  - `await` params and headers;
  - `next lint` is removed; use `eslint .`.
- **Background work:**
  - `after()` throws outside a request scope; call background work through the Runner interface (tests use `InlineRunner`);
  - `maxDuration = 300` on the turn routes (Hobby maximum).
- **Webhooks:** keep webhook routes out of the proxy matcher; read the raw body (`await req.text()`) before parsing, for signature checks.
- **Request bodies:**
  - max 4.5 MB on Vercel; the simulator downscales client-side;
  - with `proxy.ts` present, Next buffers bodies only up to 10 MB and silently truncates the rest (the simulator caps posts at 9.5 MB).
- **No CSRF protection in route handlers.** State-changing dev routes must call `isCrossSiteRequest()`.
- **`next dev` serves client bundles to `localhost` only** unless the host is in `allowedDevOrigins` (127.0.0.1 is). Otherwise the page renders but never hydrates.
- **Docs:** bundled under `node_modules/next/dist/docs`.

## Tests
- **`npm test` never touches the network.** Fakes live in `src/test/` (clock and sleeper, LLM, adapter, memory storage; FDC from M2a).
- **FDC fixtures carry provenance:**
  - `recorded`: owner-run `fdc:record`;
  - `third-party-capture <url>`: shape tests only;
  - `synthetic`: never used as expected nutrition values.
- **Vitest runs with `TZ` set to an odd zone,** so host-timezone reliance fails tests.
- **Evals call real APIs and cost money.** Never run them in CI.

## Build-container notes (Claude Code cloud sessions)
- **Unreachable here:** `api.nal.usda.gov`, `fdc.nal.usda.gov`, `ods.od.nih.gov`, and the Sendblue, Stripe, Vercel and Next.js docs sites (unless the owner allowlists them).
- **Reachable:** platform.claude.com docs, the npm registry, GitHub.
- **No Docker daemon. A PostgreSQL 16 binary is at `/usr/lib/postgresql/16/bin`.** `initdb` refuses to run as root, so use `runuser -u postgres -- …` and a unique port with `-k /tmp`; other sessions may hold common ports. `scripts/test-pg.ts` automates this.
- **`ANTHROPIC_API_KEY` is not set here** unless the owner adds it as an environment secret, so live evals are owner-run.
- **Vercel:** the owner's account is on Hobby: cron at most daily, non-commercial use only. See `DECISIONS.md` D-100.
