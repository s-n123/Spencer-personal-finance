# Plan: iMessage AI nutrition coach (MVP)

**Status:** v2 for owner review (2026-10-29). Nothing is built yet.

**How this version was made:**
- v1 was reviewed by five independent adversarial reviewers: spec traceability, pipeline concurrency, agent/LLM design, privacy/safety, data/DX.
- v2 folds in all of their findings, including 11 blockers.
- Several findings were settled by experiments against a local Postgres 16. The headline result: v1's turn-locking algorithm stranded messages under small clock skew, and the design in §2.1 fixes it.

**Inputs:**
- `SPEC.md` is the source of truth.
- `docs/research/*.md` holds dated notes, with every fact tagged `[primary]`, `[sdk-source]` or `[search]`.
- `DECISIONS.md` holds defaults chosen without asking.
- `CLAUDE.md` holds working conventions.

---

## 0. Things you should know first

1. **Your GitHub repo is public, and GitHub Pages is on.**
   - Everything committed is world-readable: code, plan, research.
   - So no real phone numbers, payloads or photos are ever committed. Owner photo fixtures are gitignored by default, and captured provider payloads are redacted by a script. A test scans for real-looking numbers.
   - Make the repo private if you don't want the code public (§9 Q3).
2. **Your Vercel account is on Hobby.**
   - Hobby cron runs at most **once a day** (±59 min), so the SPEC's 15-minute cron fails to deploy.
   - Hobby is **non-commercial only**, so Stripe payments aren't allowed.
   - Everything is built plan-agnostic (§7), but Pro is needed before real users.
3. **This build container can't reach** USDA FDC (`api.nal.usda.gov`, `fdc.nal.usda.gov`), NIH ODS (`ods.od.nih.gov`), or the Sendblue, Stripe and Vercel docs sites. There is also **no `ANTHROPIC_API_KEY`** here.
   - I can build and unit-test everything regardless.
   - Live agent runs and evals, real FDC data and the verified UL table need those hosts and keys (§9 Q1).
   - The SPEC forbids filling UL values from memory, so M3's table depends on ODS access or on you pasting the tables.

## 1. Architecture at a glance

```
 iPhone ─iMessage─► Sendblue ─webhook─► /api/webhooks/sendblue/[token] ─┐
 Browser ─► /dev/chat (simulator, dev only) ─► /api/dev/sim/messages ───┤
                                                                         ▼
  ingest()  — one short DB transaction, then 200:
    verify → per-message keyword check (STOP sets pause HERE) → consent-aware insert (pre-consent: no
    media, no free text) → dedupe (UNIQUE provider+message id) → upsert turn_state.process_after
                                                                         │ after()
                                                                         ▼
  kick(user): per-message crisis screen (instant safety reply) · Haiku triage per text (during debounce)
    · single-flight media prefetch → LEASE FIRST (heartbeat 45 s) → wait until process_after (re-read,
    re-sleep) → claim burst as ONE turn → TurnRouter → release → recheck → opportunistic global sweep
                                                                         ▼
  TurnRouter: commands → onboarding/consent (deterministic) → safety (care / 911 / 988) → access gate (M7)
    → Agent (Sonnet tool loop; tools compute every number) → OutboundSender
                                                                         ▼
  OutboundSender: code-owned bubbles (totals line, safety copy) + model text → intents (idempotent)
    → re-check pause/existence immediately before EACH send → adapter.send → record
  /api/cron/tick (any trigger): sweep stranded turns · proactive check-ins · draft auto-commit · purges · metrics
  /api/internal/kick: self-handoff when an invocation runs low on time
  /admin (Basic auth): aggregate metrics only
```

**Invariants** (these are tested, not just intended):
- **The model estimates; code computes.** Every kcal, gram, total, remaining, UL comparison and menu-fit number comes from a tool result or the context block. The totals bubble is appended by code. Before sending, a number-source check rejects any unit-bearing number in model text that didn't come from this turn's tool results or context.
- **Safety and opt-outs are never suppressed.** No onboarding, billing or debounce state can delay or block an emergency or crisis reply, an opt-out, HELP or DELETE.
- **Consent is deterministic.** Health-data consent, age, proactive opt-ins, STOP/START/HELP/DELETE and emergency replies are code paths. The LLM never decides that consent was given.
- **One turn per user at a time**, enforced by the DB lease. Check-in composition uses the same lease.
- **STOP takes effect immediately.** Pause is set inside the ingest transaction and re-checked right before every individual send.
- **Postgres is the only shared state.** Every time-sensitive SQL statement takes `$now` from the injected `Clock`, so tests can control time.
- **Provider isolation.** All provider-specific code lives in `src/server/channels/<provider>/`.
- **Privacy:**
  - no message bodies, photos, phone numbers or LLM payloads in logs, with errors sanitized centrally (DB errors otherwise embed bound parameters);
  - no trackers;
  - photos EXIF-stripped, stored privately, and purged on a schedule.

## 2. Key flows

### 2.1 Inbound → turn (SPEC §2, §3)

**ingest()** (webhook or simulator; DB-only transaction, target <300 ms; any DB error → 503 so the provider redelivers):
1. **Verify.**
   - Sendblue: constant-time compare of the `sb-signing-secret` header plus an unguessable path token.
   - Simulator: dev-only guards (§3).
   - Parse to normalized events. Group chats, tapbacks, status callbacks and non-E.164 handles are **acknowledged and never persisted**; only a count is kept.
2. **Upsert the user** by `(phone_e164)`, setting `users.line` = the line they texted.
3. **Per-message keyword check** on the whole message (trimmed, case-folded, punctuation stripped):
   - STOP family: set `messaging_paused_at` here, in this transaction.
   - Other keywords are tagged on the row for the router.
   - Keywords are never matched against a merged burst.
4. **Consent-aware insert.**
   - `INSERT inbound_messages … ON CONFLICT (provider, provider_message_id) DO NOTHING RETURNING id`.
   - **Before health-data consent:** text is stored only if the whole message matches the onboarding grammar (an age answer, YES/AGREE, or a command); otherwise it is NULL at insert. No media row and no provider URL are stored; only a `pre_consent_media_count`.
5. **Debounce state:**
   - `INSERT user_turn_state (user_id, process_after, burst_started_at) VALUES ($u, $now+DEBOUNCE, $now) ON CONFLICT DO UPDATE SET process_after = GREATEST(old, new)`.
   - `process_after` is capped at `burst_started_at + MAX_DEBOUNCE` (15 s), so a long stream of messages still gets answered.
6. **Duplicates.** A duplicate delivery whose original row is still pending or processing triggers `after(kick)` again (a free retry). Otherwise return 200.

**kick(user)** (in `after()`, also called by `/api/internal/kick` and the sweepers). It is idempotent, `me` = a random UUID per call, and the deadline is `D = getDeadline() ?? start+300 s`:
1. **Crisis screen first, per new message**, outside the lease and before any waiting:
   - a deterministic, high-precision keyword/regex list for emergency phrases (chest pain, can't breathe, throat closing, overdose, fainted) and self-harm phrases;
   - a hit sends fixed copy immediately via the safety send path: 911 for emergencies; 988 call/text, plus 911 if in danger, for self-harm;
   - the hit is recorded as a `safety_event` with no text;
   - this works for pre-consent, paused (owner/counsel to confirm, §9) and gated users.
2. **Triage during the debounce** (consented users, messages with text): Haiku 5.5 triage runs per inbound text while waiting. Only the result fields are stored on the row, never a copy of the text.
3. **Media prefetch** (consented users only, own message's media), single-flight:
   - claim: `UPDATE media SET status='downloading', claimed_until=$now+60s WHERE id=$id AND (status='pending' OR (status='downloading' AND claimed_until<$now)) AND attempts<3`;
   - download with a 15 s timeout and a byte cap;
   - sniff the type; HEIC→JPEG in a worker thread;
   - auto-orient, strip EXIF, resize (port of Anthropic's `resizedSize`);
   - put to a deterministic key `users/<uid>/<media_id>.jpg`;
   - `UPDATE … SET status='stored' WHERE status='downloading'`; if 0 rows, delete the blob just written.
4. **Lease first:** `ACQUIRE: UPDATE user_turn_state SET lease_owner=$me, lease_expires_at=$now+45s WHERE user_id=$u AND (lease_owner IS NULL OR lease_expires_at<$now) RETURNING 1`.
   - **Fails with a fresh lease** (expiry more than 25 s away): a live holder exists. It will see our message on its recheck, so return.
   - **Fails with a lease close to expiry:** the holder missed its heartbeats. Sleep until expiry, then retry, at most 3 times.
   - **Heartbeat:** RENEW every 15 s, fenced on `lease_owner=$me`. A failed renew aborts the turn via an `AbortSignal`.
5. **Holder loop:**
   - read `process_after` and pending state;
   - if `process_after > $now`, **sleep until then and re-read**: never exit on an early wake (that was the v1 stranding bug);
   - if `D-now < 150 s`, hand off (self-POST to `/api/internal/kick` with `INTERNAL_KICK_SECRET`) and stop;
   - otherwise **CLAIM**: `UPDATE inbound_messages … SET status='processing', turn_id=$t … WHERE` the lease is still ours AND `process_after <= $now` (gated, so a photo that lands mid-claim waits for its caption);
   - `ensureMedia(msgs)` waits up to 20 s for in-flight downloads, and tells the model when a photo couldn't be loaded;
   - run the turn; mark the rows done; loop.
6. **Release, then recheck:**
   - RELEASE is fenced on `lease_owner`;
   - if pending rows remain, retry acquiring; this closes the release race;
   - finally run an **opportunistic global sweep**: up to 5 users with pending or processing rows older than 30 s whose lease has expired, each handed off (never run inline). Any user's traffic then recovers anyone's stranded turn within seconds, even on Hobby.

**Turn semantics:**
- **Turn clock** = `max(sent_at)` of the claimed messages. It drives `local_date`, "today" and the totals line, so a 23:59:58 snack stays on today.
  - If the turn starts more than 10 min late, the reply acknowledges the delay.
  - If more than 12 h late, no agent run: send a short "sorry I missed this, want me to log it for <day>?", held until quiet hours end.
- **Time budget:**
  - each Anthropic call gets `{signal, timeout: min(60 s, remaining-45 s), maxRetries: remaining>150 s ? 1 : 0}`; the signal also interrupts the SDK's retry-after sleeps;
  - 30 s is reserved for sends (10 s timeout each, `maxRetries 0`);
  - at most 6 tool-loop iterations;
  - `maxDuration = 300` on the turn routes.
- **Turn phases:**
  - `turns.status` moves through `claimed → effects_committed → reply_written → done`;
  - reply bubbles are written as **intents** keyed `reply:<anchor_inbound_id>:<i>` before any send;
  - sends are at-most-once: an ambiguous result becomes `unknown` and is never auto-resent, because Sendblue has no idempotency key.
- **Recovering an orphaned turn:**
  - unsent intents exist: send them;
  - else side effects were committed: send a deterministic recap computed from the DB;
  - else: re-run the turn (safe, since nothing was committed).
- **Merge rule:** if new messages arrive while the turn's model call is running, and no side effect or intent exists yet, abort the call and re-claim everything as one turn.
- **pg Pool:** `max 10, idleTimeoutMillis 5000, connectionTimeoutMillis 3000, query_timeout 10000`, plus `attachDatabasePool`. No transaction or checked-out client ever spans an LLM, provider, blob or sleep await.
- **Errors:** every fire-and-forget promise goes through a catch-and-log helper, so an unhandled rejection can't kill the Fluid instance.

### 2.2 TurnRouter (the order is a safety property)
1. **Commands** (per message, tagged at ingest):

   | Command | Behavior |
   |---|---|
   | STOP family (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT, OPTOUT) | Exactly one confirmation via the priority path, skipping debounce and lease. If the provider rejects it with `OPTED_OUT`, that counts as already confirmed. Revokes every proactive category. If a subscription is active (M7), the confirmation adds "your plan is still active; text BILLING to manage it". |
   | START / UNSTOP | Resumes replies only. Each check-in category needs a fresh opt-in. |
   | HELP | Program name, support contact, how to opt out, how to cancel billing (separately), policy links, FDC attribution. |
   | DELETE → `YES DELETE` | See §2.6. |
   | MY DATA | Records a rights request (manual fulfillment within 45 days for the MVP). |
   | SUBSCRIBE / BILLING | M7. |

   **While paused,** only START, HELP, DELETE (and its confirmation), MY DATA, BILLING and safety replies are answered.
   **Pending prompts** (age, consent, opt-in, delete) are a single state machine. A keyword binds only to the most recent outstanding prompt, and only as the very next message. Anything else clears it.
2. **Onboarding** (deterministic copy from `policy_versions`, pre-split into bubbles of 300 characters or less, never passed through the LLM formatter):
   1. **Unknown number:** the "AI coach, not a doctor" line, plus the neutral question "How old are you?".
      - Answer of 18 or over: store only the derived 18+ boolean.
      - Under 18: decline, delete everything, keep an HMAC(phone) suppression row. This is permanent (no re-ask), and the decline names a support email for mistakes.
   2. **Consent prompt:**
      - it names the 4 MHMDA elements: categories (meals, photos, weight, goals, supplements, and health mentions like medications or pregnancy), purposes, recipient categories (the service providers that run this service: AI, messaging, hosting, payments), and how to withdraw ("text DELETE anytime");
      - it links the privacy policy and a **separate** consumer health data notice (`TODO` URLs via env);
      - it ends "Reply YES to agree".
   3. **Accepted replies:** only YES, Y, AGREE or I AGREE as the whole message. Anything else re-prompts once.
   4. **On YES:** write a `consent_events` row with the timestamp, the policy version IDs, the sha256 of exactly the bubbles sent, all of their outbound provider IDs plus delivery status, and the inbound provider message ID. In M6 the YES is verified by fetching it back from the provider.
   5. **Pre-consent photos are discarded,** with fixed copy: "Got your photo. I need your OK before I can save anything. Send it again after you reply YES."
3. **Safety** (consented users; fed by the triage results computed during the debounce):
   - **Triage outputs:** `ed_risk` (none, possible or high), `self_harm`, `medical_emergency`, `health_context` (pregnant/nursing, rx_meds, condition), `minor_signal`, and `opt_out_scope` (none, all, proactive_all or proactive:<kind>).
   - **Inputs:** the last ~6 messages as text. Triage is skipped for bursts with no text.
   - **Any triage failure** (timeout, refusal, parse error) **fails safe:** the turn suppresses numbers and appends the 988 and helpline line, and never runs the plain agent.
   - **Deterministic rules alongside Haiku:** purge, laxative, diuretic, diet pills, starve, fasting for N days. Computed signals come from a daily job: logged intake below the floor for N days, repeated sub-floor target requests, and a goal weight in the underweight-BMI range (cut-off verified from CDC/NIH before coding).
   - **Care mode** (high ED risk, or a self-harm hit):
     - no numbers or tracking talk;
     - share the National Alliance for Eating Disorders helpline (number held in config with `verified_at`), 988, and "text ALLIANCE to 741741";
     - start `ED_COOLDOWN_DAYS` with no proactive messages and no calorie talk.
     - A long cooldown needs a keyword hit or a second "high" within 7 days. A single "high" gets resources gently.
     - **Exit** requires the cooldown to have elapsed **plus** an explicit deterministic re-opt-in. Nothing resumes on its own.
   - **ED risk "possible":** persisted for 14 days. During that window code suppresses the totals bubble and the agent is gentler. Repeats escalate to care mode.
   - **`health_context`** is persisted as coarse booleans plus a timestamp, never the medication or condition text. While any flag is set, supplement tool results carry `advise_pharmacist: true`, computed in code, and the prompt requires the pharmacist/doctor line.
   - **`minor_signal`,** or `update_profile` with an age under 18, goes to the same decline-and-delete path.
   - **`opt_out_scope`:**
     - `all` = STOP;
     - a scoped value turns off that category and confirms;
     - an ambiguous value gets one confirming question.
   - **After an emergency or self-harm reply,** the turn ends. No logging, no totals.
4. **Access gate (M7):**
   - Gated users get "Your free trial has ended. Reply SUBSCRIBE for a payment link, or DELETE to remove your data." It has **no price and no link**, so it isn't a commercial text, and it is rate-limited to once every 24 h.
   - The `/pay` link goes out only in response to SUBSCRIBE or a clear request to pay.
   - Commands, onboarding, safety, MY DATA and DELETE are never gated.
5. **Agent** (§4).

### 2.3 Meal photo → log (SPEC §4, §5)
1. **Context.** The agent sees the user's images (labelled `img1…`), the caption and a context block containing:
   - local date, time, weekday and timezone source;
   - profile, targets and **precomputed** remaining kcal and protein (floored at 0, with a `low_remaining` flag);
   - today's meals with short handles (`m1, m2…`) and code totals;
   - the open draft, if any, marked "auto-logs at <time>";
   - missing profile fields, the supplement stack summary, and safety flags.
2. **`search_foods({items:[{label, queries:[1–3 FDC-style variants], kind:'generic'|'branded'}]})`** makes one call for all items.
   - **Retrieval:** the local FDC seed, ranked by relevance first. A union of `word_similarity` (pg_trgm) and full-text search, then a data-type boost FNDDS > SR Legacy > Foundation, with near-duplicate concepts merged. The live API is used for Branded items and misses.
   - **Returns** at most 5 candidates per item:
     - `fdc_id`, data type, description;
     - kcal and macros per 100 g (or per 100 ml where the basis is ml);
     - portion options with **code-computed** per-portion kcal and protein (e.g. `p2: 1 cup = 205 kcal, 4.3 g protein`);
     - `includes_added_fat` and `includes_sauce` flags for FNDDS mixed dishes.
3. **`log_meal`** takes `{when: now|earlier_today|yesterday|ISO, title, image_refs, possible_additions: [cooking_oil|butter|dressing|sauce|sugar_or_syrup|milk_or_creamer|none], draft_ref, skip_clarification, option_ref, items: [{fdc_id, label, quantity, quantity_low, quantity_high, unit: g|ml|oz|fl_oz|portion, portion_ref, confidence, extra_beyond_recipe}]}`.
   - **Code converts every quantity to grams,** using FDC portion weights and the food's g/ml basis, so the model never multiplies or converts.
   - **Unknown fdc_ids are rejected.** An `fdc_id` must have come from this turn's `search_foods`, the draft, or today's meals; otherwise the call returns `is_error`. Parallel tool calls therefore can't log guessed IDs.
   - **Double-counted fat is rejected.** An oil or sauce add-on to a mixed dish that already includes added fat needs `extra_beyond_recipe:true`, or the call returns `is_error`.
4. **Code computes** `per100 × grams / 100` per item, using the energy chain 1008 → 2047 → 2048 → kJ/4.184 → Atwater 4/4/9 (marked derived). It snapshots the FDC values onto the item and computes the kcal spread.
5. **Clarification** (code-decided):
   - **Trigger:**
     - the meal's kcal spread is at least `max(CLARIFY_MIN_KCAL_RANGE=150, 25% of the meal)`;
     - or a hidden-calorie candidate is plausible. The category comes **from the FDC record**, not the model's label (fats and oils, dressings, sauces, beverages other than water, black coffee, plain tea or diet soda, and alcohol), plus any `possible_additions`.
   - **Typed question.** Code returns one of `count`, `size_option`, `fat_used`, `drink_type_size` or `ate_all`, with 2–4 options that each map to grams. The model asks ONE short question built from it, never in grams.
   - **Draft lifecycle:**
     - at most one open draft per user (partial UNIQUE index);
     - drafts are excluded from totals until committed;
     - a draft auto-commits at the point estimate, with a code-written "logged lunch with my best guess" note, when a new meal is logged, when the next turn doesn't address it, or after `DRAFT_TTL` (2 h, enforced by the sweeper);
     - the draft's date comes from its `when`.
   - **Limits:**
     - never more than one question per meal;
     - after two "just estimate" replies, stop asking that user for 7 days;
     - the clarification question takes priority over a profile question in the same turn.
6. **The reply is written by code and the model together:**
   - the model writes one line about what was logged, from the code-built `logged_line` (meal title, meal kcal, protein);
   - **OutboundSender appends the totals bubble itself** (e.g. `Today: 1,240 / 2,000 kcal · 82 / 140 g protein`), reserving one of the 3 bubble slots for it;
   - the totals bubble is suppressed in care mode or while ED risk is "possible".

### 2.4 Menus, suggestions and nutrition questions (M3; text Q&A from M2)
- **`evaluate_options({source: menu|suggestion|question, options: [{name, items: [same shape as log_meal items]}]})`** replaces v1's `score_menu_options`.
  - **Returns:** computed macros, ranges and a fit score per option.
  - **Saved** for 6 h with `option_ref`s, so "I got the salmon bowl" logs exactly what was recommended.
  - **Fit** is scored against an effective budget of `max(remaining, MIN_MEAL_KCAL)` and weighted by goal.
  - **Never suggests skipping a meal.**
  - The model drops dishes that conflict with stored restrictions and adds "check with staff" for allergies.
  - An option may be a single FNDDS mixed-dish item.
- **Covers more than menus:** "What should I eat for dinner?", the morning plan's suggestion and "how much protein in 3 eggs?" all go through this tool or `search_foods`.
- **System prompt rule:** never state a food's calories or macros unless they came from a tool result.

### 2.5 Supplement labels (M3)
1. **`save_supplement` (strict)**, one call per product, even across front and back photos:
   - **Product fields:** `product_name`, `brand`, `servings_per_dose`, `frequency` (daily, weekly, every_n_days or as_needed) plus `doses_per_period`, and the label's per-day multiplier.
   - **Per-ingredient fields:**
     - `name` and `amount` (0 when the amount sits inside a blend);
     - `unit` (mg, mcg, IU, g, mcg_DFE, mg_NE, mcg_RAE or other) and `source_compound` ("magnesium oxide");
     - `form` enum (retinol, beta_carotene, folic_acid, methylfolate, d_alpha, dl_alpha, nicotinic_acid, niacinamide, …, unknown);
     - `folic_acid_mcg` (0 if not stated), `pct_as_beta_carotene` (-1 if not stated) and `in_blend`.
   - **Elemental amounts.** Label amounts are always treated as elemental, per 21 CFR 101.36.
   - **Missing usage.** If the label doesn't say how many the user takes or how often, code asks.
2. **Code maps names to canonical nutrient keys** (synonyms table) and converts units:
   - vitamin D: IU→mcg;
   - vitamin E: IU→mg, using the form factor (synthetic when the form is unknown);
   - vitamin A: only preformed retinol counts.
   - **Folate:** the folic-acid UL is checked in **mcg of folic acid**, never DFE. If only DFE is given and the form is folic acid, code uses ×0.6. 5-MTHF is "indeterminate". DFE is for display only.
3. **Code aggregates the average daily dose and the max single-day dose** (so a weekly 50,000 IU vitamin D is caught) and checks them against the UL table. Comparisons are scope-aware:
   - total-intake ULs: "from supplements alone; food adds more";
   - supplemental-only ULs: compared directly;
   - no UL on file: "no verified upper limit on file", never a silent pass.
4. **Plausibility bounds** catch misreads: an amount over about 20× the UL returns `needs_confirmation` naming the unit (the 50 mcg vs 50 mg case).
5. **Duplicate keys:** `nutrient_key` when mapped, otherwise the normalized ingredient name, so two caffeine or melatonin products are caught.
6. **Wording.** The agent words flags in general-wellness language: a UL is not a toxicity line, and it doesn't apply under physician care. The pharmacist line is added whenever `advise_pharmacist` is set.

### 2.6 DELETE, withdrawal and rights (SPEC Safety §2; MHMDA)
1. **The DELETE prompt** clarifies scope: "This deletes your whole account: every meal, photo, supplement and your profile. To remove one meal, say 'remove my last meal'. Our texting and payment providers keep limited records as described at <CHD notice>. Reply YES DELETE within 10 minutes to confirm."
2. **Confirmation works while paused.** In M6 the confirming message is verified by fetching it back from the provider. If the provider blocks sends to an opted-out user, the request is recorded as a rights request and completed through the fallback in §9 Q4.
3. **On confirmation, in this order:**
   1. cancel the Stripe subscription and delete the Customer; on failure, keep a retrying pending-deletion job and never drop the Stripe IDs;
   2. delete the `users` row (cascades);
   3. delete blobs **by prefix** `users/<uid>/`;
   4. write a non-identifying `deletion_receipts` row;
   5. send the final message.
4. **Withdrawal of consent** = DELETE, which keeps the consent copy simple and true.
5. **MY DATA** records a `rights_requests` row with a 45-day clock (`due_at`), shown on /admin, fulfilled manually for the MVP. Appeals go to the support email plus a link to the WA AG complaint page.
6. **Processors:** they are listed in a processor registry, and Sendblue is notified by support ticket when needed. A STOPped user's Sendblue contact is never deleted, because that would erase their opt-out.
7. **Backups and branches:** the Neon restore window is set explicitly (§9 Q4), and preview branches are schema-only.

### 2.7 Proactive check-ins (M5)
1. **Opt-in per category** (morning plan, evening recap, supplement reminder, weekly recap). `set_checkin_preferences` only *stages* a proposal. Code then sends fixed copy, e.g.: "Want a morning plan around 8:00am Pacific? Up to 2 check-ins a day; text STOP anytime. Reply YES to turn it on."
   - Only an exact YES writes `consent_events(proactive:<kind>)` and enables the category, which also confirms the timezone (`timezone_source='user'`).
   - Turning a category off needs no confirmation.
   - Everything defaults to off.
2. **Schedule:** a `proactive_schedule(user_id, kind, next_due_at)` table, computed in code with DST and quiet hours applied whenever preferences or the timezone change, and after each send.
3. **Tick:**
   - select `next_due_at <= $now` within a grace window;
   - **claim before compose,** in one DB-only transaction: insert into `proactive_sends`; a conditional increment of the user's rolling-24 h count (< 2) and of `unanswered_proactive_count` (< 2); a conditional increment of the line's daily counter (< `GLOBAL_DAILY_CAP_PER_LINE`, counted on the provider's day);
   - if any step changes 0 rows, roll back;
   - then take the user's lease, and skip the user if it is held, inbound is pending, or they texted within 10 min;
   - compose, re-check pause, send **once** (at-most-once);
   - fan out with bounded concurrency and stop claiming at `D-60 s`.
4. **Content:**
   - exactly one bubble per check-in;
   - supplement reminders fold into the morning or evening message when due together;
   - Sunday's weekly recap replaces the evening recap;
   - cap priority: weekly > morning > evening > supplement;
   - numbers come from code templates;
   - "adherence" means within ±10% of target, and days below the floor are never counted as success;
   - the weekly recap carries a periodic "text STOP to pause" reminder.
5. **Never sent to:** gated users, users in care-mode cooldown, or users with an unconfirmed timezone. Check-ins never contain pricing, links or upgrade copy.
6. **Back-off:** any inbound resets `unanswered_proactive_count`.

## 3. Channel adapters (SPEC §1)

```ts
// src/server/channels/types.ts (sketch)
type Provider = 'simulator' | 'sendblue' | 'linq' | 'blooio';
interface InboundMessage {
  provider: Provider; providerMessageId: string;   // dedupe key (Sendblue: message_handle, one per attachment)
  fromE164: string; toLine: string | null;          // E.164 via libphonenumber-js; our line
  text: string | null; media: { url: string; mimeType?: string }[];
  sentAt: Date; service?: 'iMessage' | 'SMS' | 'RCS'; providerConversationId?: string;
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
  fetchMedia(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string | null }>;
  sendText(from: string, to: string, text: string, o: { idempotencyKey: string; signal: AbortSignal }): Promise<SendResult>;
  sendImage?(from: string, to: string, img: { bytes: Uint8Array; contentType: string }, o: {...}): Promise<SendResult>;
  startTyping?(from: string, to: string): Promise<void>;          // best-effort; started at claim
  react?(from: string, providerMessageId: string, r: Reaction): Promise<void>;
  fetchMessage?(providerMessageId: string): Promise<{ text: string | null; from: string } | null>; // consent/delete verification
  setOptOut?(to: string, optedOut: boolean): Promise<void>;
}
```
- **SimulatorAdapter (M1):**
  - **UI:** an iMessage-style thread at `/dev/chat` with image upload (the browser downscales; HEIC passes through raw), typing dots, a phone switcher, reset, and a dev **time-travel** control (M5).
  - **Sends** write `outbound_messages`; typing and reactions go to `simulator_events`, which the page polls.
  - **Guards** (a misconfigured env must not expose real users):
    - hard-off when `VERCEL_ENV=production`, whatever `ENABLE_SIMULATOR` says;
    - checked in both `proxy.ts` and every handler;
    - accepts only fictional `+1NPA55501XX` numbers;
    - users are namespaced by provider;
    - reset deletes only simulator users;
    - previews also require admin Basic auth.
- **SendblueAdapter (M6):**
  - **Auth:** headers `sb-api-key-id` / `sb-api-secret-key`; base URL `https://api.sendblue.co`.
  - **Sends:** `maxRetries: 0`, with status reconciliation.
  - **Endpoints:** typing `/api/send-typing-indicator`, reactions `/api/send-reaction`, outbound images via `/api/upload-file` (never public URLs to user photos), opt-out sync via `/api/v2/contacts/opt-out`.
  - **Parsing:** lenient Zod schemas until real payloads are captured. Captures pass through a redaction script before they are committed.
  - **To measure:** inter-webhook gaps, which set the debounce.

## 4. Agent design (SPEC §4)

- **Request shape:**
  - `tools`: sorted and frozen; 1 h `cache_control` on the last one.
  - `system`: static; 1 h `cache_control`.
  - **History** as alternating user/assistant **text-only** messages (the last ~12 exchanges):
    - past photos become code-written summaries (`[photo 12:40: logged chicken teriyaki bowl]`), written from the tool that used the image via `image_refs`;
    - past totals lines become `[totals]`.
  - **Final user message:** the context block, then labelled images, then the caption.
    - Images: re-attach the open draft's images, or the previous turn's images when they are under 30 min old and the new burst has none (20 images max).
  - **Automatic 5-minute `cache_control`** on the request, so loop iterations 2+ read the turn prefix (3 of 4 breakpoints used).
  - **Never replayed:** assistant, thinking or tool blocks from earlier turns.
  - **Images** go as base64 only, with no URL sources and no Files API.
- **Model params:**
  - Model: `MODEL_MAIN=claude-sonnet-5-5`.
  - Never `temperature`, `top_p` or `top_k` (400 on API 2026-10-21).
  - Adaptive thinking. `MODEL_MAIN_EFFORT=medium`, constant within a turn.
  - `max_tokens` 8000; a `max_tokens` stop never runs tools; retry once ×2, then fall back.
  - `tool_choice: auto` only.
  - `strict: true` on the write tools (`log_meal`, `edit_or_delete_meal`, `save_supplement`).
  - `metadata.user_id` = user UUID. SDK OpenTelemetry off.
- **Schemas:**
  - Each tool has a **bound-free wire schema** (plain types, enums, sentinels instead of nullable) used as `input_schema`, and a separate Zod validation schema with the bounds.
  - **A unit test** walks every strict tool's emitted JSON against a keyword allowlist and asserts ≤20 strict tools, ≤24 optional params and ≤16 union params (target ≤12).
  - **No user data** in enum, const or pattern.
  - **A smoke call** with the full tool set runs after any schema change.
- **Tools** (the 9 SPEC tools plus 3):

  | Tool | Purpose |
  |---|---|
  | `search_foods` | FDC candidates with code-computed per-portion values |
  | `log_meal` | convert, compute, log, or return a typed clarification; returns `logged_line` |
  | `edit_or_delete_meal` | by handle `m1`/`last`; scale, replace items, change time, delete |
  | `get_day_summary` | totals, targets, remaining (floored) for today, yesterday or a date |
  | `get_history` | per-day totals, averages, adherence band, over a range |
  | `evaluate_options` | menus, dinner suggestions, nutrition questions (M3; text Q&A from M2) |
  | `save_supplement` / `remove_supplement` / `get_supplement_stack` | stack CRUD plus aggregation, UL, duplicate and pharmacist flags (M3) |
  | `update_profile` | `{value, unit}` for height and weight; appends to `weight_entries`; recomputes targets with guardrails; rejects age <18 (M4) |
  | `set_checkin_preferences` | stages a proposal that code confirms with a deterministic YES prompt (M4/M5) |

- **System prompt** (static, cached) contains:
  - **Texting style** (SPEC): plain text only, 1–3 short bubbles under ~300 characters, friendly, emoji sparingly, one question at a time, the after-logging format.
  - **Safety rules:**
    - AI coach, not a doctor;
    - general wellness only: no diagnosis, treatment, medication or dose advice; FDA-wellness wording;
    - never praise skipping meals, restriction or compensatory exercise;
    - always suggest a real meal even when little is left;
    - pharmacist/doctor line when `advise_pharmacist` is set;
    - call 911 in an emergency;
    - never describe people or faces in photos (biometric data).
  - **Grounding rules:** never state calories or macros unless they came from a tool; never compute totals or remaining; use `logged_line`.
- **OutboundSender pipeline:**
  1. markdown strip;
  2. **number-source check** (one corrective retry, then strip the offending number); the same applies to "logged" claims made without a committed `log_meal`;
  3. append code-owned bubbles (totals, safety copy);
  4. fit 3 bubbles of 300 characters or less by **merging, never dropping**; if still too long, one "shorten" retry;
  5. write intents;
  6. re-check pause right before each send.
- **Stop reasons:**
  - `refusal`: canned caring reply plus resources and a `safety_event`.
  - Context overflow: trimmed-history retry.
  - Spend-cap 429: alert, one "having trouble" reply, no retry.
- **Haiku triage:** `messages.parse` + `zodOutputFormat`, thinking off, `max_tokens 1024`.
- **Latency target** (from last inbound to first bubble):
  - photo log: p50 ≤12 s, p95 ≤25 s (not counting the 4 s debounce);
  - text: ≤8 s.
  - Typing indicator starts at claim. Evals sweep effort (low, medium) and `thinking: between_tools`.
- **Cost estimate** (from anthropic.md prices; to be measured in evals):

  | Turn type | Estimated cost |
  |---|---|
  | photo log | ~$0.03–0.04 |
  | text Q&A | ~$0.01 |
  | menu | ~$0.06 |
  | triage | ~$0.0001 |
  | active user, 3 photos + 3 texts/day | ~$4/month |

## 5. Data model (Postgres + Drizzle)

**Conventions:**
- UUID PKs and `timestamptz`.
- `text` + `CHECK` instead of pgEnum.
- Nutrients stored as `double precision` or integer, never `numeric` (pg returns numeric as strings; PGlite doesn't).
- `casing: 'snake_case'`, with explicit names for keys like `phoneE164`.
- **FK actions:**
  - `user_id → users`: **CASCADE**;
  - parent → child: **CASCADE**;
  - references (`media_id`, `turn_id`, `*_message_id`): **SET NULL**;
  - retention purges null out content but keep the rows.
- **Indexes** on every FK and every hot path.
- **A schema test** asserts every `user_id` column has a cascading FK and an index, and that DELETE leaves 0 rows for the user in every table.

| Table | Key columns (abridged) | M |
|---|---|---|
| `users` | `phone_e164` UQ, `provider`, `line`, `status` (onboarding/active), `is_adult`, `timezone`, `timezone_source` (user/simulator/default), `last_inbound_at`, `messaging_paused_at`, `stop_confirmed_at`, `unanswered_proactive_count`, `proactive_count_24h_window`, `ed_possible_until`, `care_cooldown_until`, `pending_prompt` jsonb (kind, expires_at), `trial_started_at`, `trial_ends_at` | 1 (+4,5,7) |
| `user_turn_state` | `user_id` PK, `process_after`, `burst_started_at`, `lease_owner`, `lease_expires_at` | 1 |
| `inbound_messages` | UQ(`provider`,`provider_message_id`), `user_id`, `to_line`, `text` (nullable), `keyword`, `sent_at`, `received_at`, `status` (pending/processing/done/failed), `turn_id`, `pre_consent`, `pre_consent_media_count`, triage result fields | 1 |
| `media` | `user_id`, `inbound_message_id`, `meal_id`, `supplement_id`, `provider_url` (cleared after download), `status` (pending/downloading/stored/failed/purged), `claimed_until`, `attempts`, `storage_key`, `content_type`, `w`, `h`, `bytes`, `sha256`, `kind`, `summary`, `purge_after` | 1 |
| `turns` | `user_id`, `status` (claimed/effects_committed/reply_written/done/failed), `mode` (agent/onboarding/command/care/gated/safety), `clock_at`, per-iteration latency and token usage (input/cache read/cache write/output), `stop_reason`, `error_code`. **No content.** | 1 |
| `outbound_messages` | `user_id`, `turn_id`, `kind` (reply/proactive/command/onboarding/safety), `proactive_kind`, `from_line`, `text`, `media_id`, `idempotency_key` UQ, `status` (intent/sent/unknown/suppressed/failed), `provider_message_id`, `error_code` | 1 |
| `simulator_events` | `user_id` FK, `type`, `payload` | 1 |
| `dev_clock` | single row: offset (simulator time travel; ignored in production) | 1/5 |
| `fdc_foods` | `fdc_id` PK, `data_type`, `description` (GIN trigram + tsvector), `food_category`, `wweia_category`, `release`, `basis` (g/ml), `per100` jsonb, `energy_source`, `portions` jsonb, `includes_added_fat`, `includes_sauce`, `brand_owner`, `gtin`, `serving_size`, `serving_unit`, `source` (seed/api), `fetched_at` | 2 |
| `fdc_search_cache` | PK(`query_norm`, `data_types`), `fdc_ids[]`, `fetched_at` | 2 |
| `user_profiles` | `goal`, `sex?`, `birth_year?`, `height_cm?`, `goal_weight_kg?`, `activity_level?`, `weekly_rate_kg` (clamped), `diet_prefs[]`, `restrictions[]` (diet and allergies only), `has_rx_meds`, `pregnant_or_nursing`, `has_condition`, `health_context_at`, targets plus `targets_source`, `guardrail_applied` | 2 (defaults)/4 |
| `weight_entries` | `user_id`, `kg`, `measured_at` (source of truth; the profile caches the latest) | 4 |
| `meals` | `user_id`, `status` (draft/logged/deleted), `local_date`, `tz`, `eaten_at`, `meal_type`, `title`, `source`, totals (`kcal`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `sugar_g`, `sodium_mg`), `clarification` jsonb, `auto_commit_at`, `turn_id`; partial UQ(`user_id`) WHERE draft | 2 |
| `meal_items` | `meal_id`, `user_id`, `label`, `fdc_id`, `fdc_data_type`, `fdc_description`, `fdc_release`, `quantity`, `unit`, `grams`, `grams_low`, `grams_high`, `confidence`, `category`, `energy_source`, `per100` snapshot, computed macros; CHECK `grams_low ≤ grams ≤ grams_high` | 2 |
| `evaluated_options` | `user_id`, `source`, `options` jsonb, `expires_at` | 3 |
| `supplements` | `user_id`, `product_name`, `brand`, `servings_per_dose`, `frequency`, `doses_per_period`, `n_days`, `active`, `removed_at` | 3 |
| `supplement_ingredients` | `supplement_id`, `user_id`, `raw_name`, `nutrient_key?`, `dup_key`, `form`, `source_compound`, `amount`, `unit`, `amount_norm`, `unit_norm`, `folic_acid_mcg`, `pct_as_beta_carotene`, `in_blend` | 3 |
| UL reference | **versioned TS data** `src/server/supplements/upper-limits.ts`. Each row: `nutrient_key`, `ul`, `unit`, `applies_to` (total/supplemental_only/specific_form), `counted_forms`, `excluded_forms`, `physician_care_note`, `source_url`, `sheet_updated`, `retrieved_at`, `verified: true`. Only verified rows are included. | 3 |
| `policy_versions` | `kind` (privacy/chd_notice/consent_prompt/age_prompt/optin_prompt/…), `version`, `url`, `bubbles` (pre-split), `sha256`, `effective_at`, `requires_reconsent` | 4 |
| `consent_events` | append-only: `user_id`, `type` (age_18_plus/chd_collection/proactive:<kind>), `action`, `policy_version_ids`, `bubbles_sha256`, `outbound_provider_ids[]`, `delivery_status`, `inbound_provider_message_id`, `matched_keyword`, `verified_by_fetch`, `provider`, `service`, `app_version` | 4 |
| `safety_events` | `user_id`, `kind` (emergency/self_harm/ed_high/ed_possible/refusal/minor), `source` (keyword/triage/signal), `turn_id`. **No text.** | 4 |
| `suppressions` | `phone_hmac` PK, `reason` (minor/deleted_opt_out*), `created_at` (*only if counsel approves, §9) | 4 |
| `rights_requests` | `type` (access/delete), `user_id` (SET NULL), `received_at`, `due_at`, `extended_due_at`, `processors_notified` jsonb, `completed_at`, appeal fields | 4 |
| `deletion_receipts` | `requested_at`, `completed_at`, `blobs_deleted`, `stripe_canceled`; no identifiers | 4 |
| `checkin_preferences` | `user_id` PK; per kind: enabled and local time; weekly on Sunday | 4/5 |
| `proactive_schedule` | (`user_id`, `kind`) PK, `next_due_at` (indexed) | 5 |
| `proactive_sends` | UQ(`user_id`, `kind`, `local_date`), `outbound_message_id`, `answered_at` | 5 |
| `line_daily_counters` | (`line`, `provider_day`) PK, `n` | 5 |
| `metrics_daily` | UTC date, line, `inbound_turns`, `inbound_messages`, `outbound_total`, `outbound_proactive`, `active_users`, `photos` (non-identifying) | 5 |
| `billing_customers`, `subscriptions`, `stripe_events` (`event_id` PK, `type`, `processed_at` only), `pay_links` (`token_hash`, `user_id`, `kind`, `expires_at`, `last_session_id`) | | 7 |

**Retention** (in `policy.ts`, published in the CHD notice):

| Data | Default retention |
|---|---|
| Photos | 30 d (`MEDIA_RETENTION_DAYS`) |
| Message text, inbound and outbound | 90 d (`MESSAGE_TEXT_RETENTION_DAYS`) |
| Users who never consented | deleted after 30 d |
| Ignored events | never stored |

## 6. File layout and scripts

```
SPEC.md CLAUDE.md DECISIONS.md README.md .env.example .nvmrc   .github/workflows/ci.yml
docs/PLAN.md docs/research/*.md
drizzle/                      # migrations (0000 = CREATE EXTENSION pg_trgm)
fixtures/                     # owner photos gitignored by default; synthetic/ committed
  meals/ menus/ labels/ synthetic/   <name>.{jpg,heic} + optional .txt caption, .answers.txt, .profile.json, .expect.json
  text/                       # scripted multi-turn conversations incl. safety.jsonl
scripts/  dev.ts db-dev.ts migrate.ts check-migrations.ts db-reset.ts test-pg.ts eval.ts fdc-seed.ts fdc-record.ts
          fdc-search.ts cron-tick.ts fixtures-synthetic.ts fixtures-strip.ts capture-payload.ts _env.ts
src/
  instrumentation.ts          # eager env validation; onRequestError → sanitizeError
  proxy.ts                    # /admin Basic auth; /dev + /api/dev guards
  app/  page.tsx (minimal landing + policy links + FDC attribution)  dev/chat/  admin/
        api/dev/sim/{messages,media/[id],reset,clock}/  api/internal/kick/  api/cron/tick/
        api/webhooks/sendblue/[token]/ (M6)  api/webhooks/stripe/ (M7)  pay/[token]/ billing/[token]/ (M7)
  server/
    config/{env.ts (lazy getEnv), policy.ts (tunables)}   db/{client.ts, schema/*.ts, sql.ts (sqlNumber)}
    log.ts  errors.ts (sanitizeError)  time.ts (Clock, tz)  safe.ts (fire-and-forget catcher)
    channels/{types.ts, registry.ts, simulator/, sendblue/}
    pipeline/{ingest.ts, keywords.ts, kick.ts, lease.ts, claim.ts, sweep.ts, handoff.ts, router.ts, outbound.ts, recover.ts}
    media/{image.ts, resize.ts, heic-worker.ts, download.ts, storage/{local.ts, vercel-blob.ts}}
    agent/{llm.ts, loop.ts, system-prompt.ts, context.ts, history.ts, format.ts, numbers.ts, triage.ts, tools/}
    nutrition/{fdc/{client,schemas,normalize,search,seed}.ts, energy.ts, convert.ts, macros.ts, clarify.ts, drafts.ts,
               targets.ts, day.ts, options.ts}
    supplements/{nutrients.ts, units.ts, upper-limits.ts, aggregate.ts}
    onboarding/  commands/  safety/{screen.ts, care.ts, signals.ts, resources.ts}  proactive/  admin/  billing/
  test/                       # pglite + pg helpers, fake clock/sleeper, fake LLM, fake FDC (provenance-labelled)
```

**npm scripts:**

| Script | Command / purpose |
|---|---|
| `dev` | `tsx scripts/dev.ts`: loads env, starts the PGlite socket server on 127.0.0.1:54330 if needed, migrates, warns if the FDC seed is empty, runs `next dev` |
| `dev:next` | `next dev` alone |
| `build`, `start` | Next.js build and start |
| `lint` | `eslint .` |
| `typecheck` | `tsc --noEmit` |
| `test` | unit project, PGlite, no network |
| `test:pg` | node-postgres suite plus race tests against a throwaway PG16 or `TEST_DATABASE_URL` |
| `check` | typecheck, lint, `db:check`, test |
| `db:dev`, `db:generate`, `db:migrate`, `db:check`, `db:reset`, `db:studio` | migrate takes an advisory lock and verifies hashes and counts; check confirms schema and migrations match and the journal is monotonic |
| `fdc:seed`, `fdc:record`, `fdc:search` | load the FDC seed; record real FDC responses as fixtures; search from the CLI |
| `eval` | flags `--suite meals\|menus\|labels\|text\|safety`, `--only`, `--repeat`, `--effort`, `--fdc-live` |
| `fixtures:synthetic`, `fixtures:strip` | generate synthetic fixtures; strip metadata from owner photos |
| `cron:tick -- --at <ISO>` | run a tick at a chosen time |

Scripts run via `tsx --conditions=react-server` with `_env.ts` (which uses `@next/env`). **CI** (GitHub Actions) runs `check` plus `test:pg` against a Postgres service container on every push.

## 7. Platform choices (reasons in DECISIONS.md)
- **Next.js 16.4.3:** App Router, `src/`, `proxy.ts`, Node runtime, Cache Components off; Tailwind v4 for the simulator and admin.
- **DB:**
  - Production: Neon Postgres via the Vercel Marketplace, with **schema-only preview branches**; `pg` + `drizzle-orm/node-postgres`, pinned at 0.45.4.
  - Dev: a PGlite socket server started by `npm run dev`, or any Postgres.
  - Tests: PGlite for unit tests; real PG16 for the pg suite and race tests.
- **Storage:** a private Vercel Blob store in production, the local filesystem in dev. Only the resized, EXIF-stripped JPEG is kept. Meal photos may move to a smaller size later based on eval cost data.
- **Background work:** `after()` plus the DB state machine, the opportunistic sweep and self-handoff. Vercel Queues (beta) isn't used; a delayed "watchdog" message is an optional add-on if you stay on Hobby.
- **Cron:** `/api/cron/tick` is idempotent and catch-up-based, so any trigger works:
  - (a) Vercel Pro `*/15` (recommended; required for commercial use);
  - (b) a GitHub Actions schedule every 15 min (often 5–15 min late; schedules disable after 60 days of repo inactivity);
  - (c) `npm run cron:tick` or Hobby's daily run while developing.
  - On Hobby, the daily cron is **not** relied on for turn recovery.

### Config (`src/server/config/policy.ts`; ★ = SPEC asks for owner review)

| Key | Default | Notes |
|---|---|---|
| `DEBOUNCE_MS` / `MAX_DEBOUNCE_MS` | 4000 / 15000 | SPEC; re-measured with Sendblue in M6 |
| `QUIET_HOURS` | 21:00–08:00 local | SPEC. Some states (FL, OK, WA; search-only) use 8 pm for solicitations; ours are opt-in and informational |
| `MAX_PROACTIVE_PER_USER_PER_DAY` | 2 (rolling 24 h) | SPEC |
| `GLOBAL_DAILY_CAP_PER_LINE` | 150 | Sendblue AI Agent plan allows 200 follow-up contacts/line/day (reset 3 AM ET); headroom kept |
| `PROACTIVE_UNANSWERED_PAUSE` | 2 | SPEC |
| ★ `MIN_DAILY_KCAL` | 1200 female / 1500 male / 1500 unspecified | compliance.md §7.2 |
| ★ `MAX_WEEKLY_LOSS_KG` | min(0.9, 1% of body weight); deficit ≤1000 kcal/day | compliance.md §7.3 |
| ★ `UNDERWEIGHT_BMI` | to be verified from CDC/NIH before M4 | no BMI rule ships until verified |
| ★ `ED_COOLDOWN_DAYS` / `ED_POSSIBLE_WINDOW_DAYS` | 14 / 14 | |
| ★ `BELOW_FLOOR_STREAK_DAYS` | 3 | computed ED signal |
| `CLARIFY_MIN_KCAL_RANGE` / `CLARIFY_MIN_FRACTION` | 150 kcal / 0.25 | |
| `DRAFT_TTL` | 2 h | |
| `MIN_MEAL_KCAL` | 400 | floor for suggestion fit |
| `DEFAULT_TARGETS` | 2000 kcal / 100 g protein | until a profile exists |
| `MEDIA_RETENTION_DAYS` / `MESSAGE_TEXT_RETENTION_DAYS` | 30 / 90 | |
| `TRIAL_DAYS` / `PAST_DUE_GRACE_DAYS` | 7 / 7 | M7; USD monthly |
| ★ Helpline | Alliance 1-866-662-1235, Mon–Fri 9–7 ET | sources conflict (662 vs 622); re-verify before M4 ships |

### Env by milestone (kept in `.env.example`; a test asserts that schema keys == example keys)

| Milestone | Variables |
|---|---|
| M1 | `ANTHROPIC_API_KEY`, `MODEL_MAIN`, `MODEL_FAST`, `MODEL_MAIN_EFFORT`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `ENABLE_SIMULATOR`, `MEDIA_STORAGE`, `MEDIA_LOCAL_DIR`, `DEFAULT_TIMEZONE`, `APP_BASE_URL`, `INTERNAL_KICK_SECRET`, `LOG_LEVEL` |
| M2 | `FDC_API_KEY`, `TEST_DATABASE_URL`, `CRON_SECRET` |
| M4 | `PRIVACY_POLICY_URL`, `CHD_NOTICE_URL` (TODO), `SUPPORT_CONTACT`, `PHONE_HMAC_KEY` |
| M5 | `ADMIN_USER`, `ADMIN_PASSWORD` (high-entropy, validated) |
| M6 | `BLOB_READ_WRITE_TOKEN`, `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_SIGNING_SECRET`, `SENDBLUE_WEBHOOK_PATH_TOKEN`, `SENDBLUE_FROM_NUMBER` |
| M7 | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` |

## 8. Milestones
**Definition of done** for every milestone:
- `npm run check` and `npm run test:pg` are green;
- `.env.example`, `DECISIONS.md` and `CLAUDE.md` are updated;
- a commit is pushed to the branch;
- I give a short summary plus try-it steps, then **wait**.

**Step 0** of any milestone with an integration: re-read the live docs. Every `[search]` fact the code relies on is marked verified (or confirmed by one live call). If a host is still blocked, I stop and ask rather than code from `[search]`.

Larger milestones have internal checkpoints (a/b), which are commits, not stops.

**M1: Scaffold, schema, simulator, agent describes photos**
- **Scaffold:** Next.js, CI, lazy env and `.env.example` test, `npm run dev` with the auto-started PGlite server, Drizzle with checked migrations, core tables.
- **Logging and errors:** `log.ts` allowlist, `sanitizeError` with the canary test, fire-and-forget catcher.
- **Simulator:** with its guards.
- **Pipeline:** ingest with per-message keyword tagging and dedupe; `kick` with the heartbeat lease, claim, release-recheck, opportunistic sweep and handoff (all with `DEBOUNCE_MS=0`); outbound intents.
- **Media:** single-flight media pipeline (HEIC worker, EXIF strip, `resizedSize` port).
- **Agent:** minimal Sonnet loop that describes any photo in plain bubbles; formatter.
- **Tests:**
  - dedupe; one message from a new number gives exactly one turn;
  - lease race suite (two concurrent kicks, early wake, holder death);
  - resize vs the docs' examples; EXIF/GPS stripped and orientation applied on a synthetic JPEG; HEIC decode of libheif's sample;
  - formatter; env/example parity; log-canary.
- **Try it:** `npm i` → `cp .env.example .env.local`, then set `ANTHROPIC_API_KEY` → `npm run dev` → open http://localhost:3000/dev/chat.
  - Phone +12015550100: send a JPEG and an iPhone HEIC; each gets 1–3 plain-text bubbles.
  - "Resend" replays the same message ID and gets no second reply.

**M2: Meal logging, FDC grounding, day summary, clarifications, turn batching**
- **M2a, batching and the FDC data layer:**
  - 4 s debounce with a 15 s max; merge rule; turn clock; stale-turn recovery (intent and side-effect aware); cron tick skeleton with sweep and draft auto-commit;
  - FDC client and normalizer (handles spec drift and HTML bodies); `fdc:seed` importer (FNDDS + SR Legacy + Foundation, with the FNDDS added-fat flags); relevance-first search; `fdc:search` CLI; energy chain.
  - Fixtures carry provenance labels: recorded by you via `npm run fdc:record`, third-party captures (shape tests only), or synthetic.
- **M2b, meal logging:**
  - meals schema; `search_foods`, `log_meal` (quantity/unit conversion, ID guard, double-fat guard), `edit_or_delete_meal`, `get_day_summary`, `get_history`;
  - typed clarifications and the draft lifecycle;
  - code-owned totals bubble, number-source check, default targets;
  - text Q&A via `search_foods`;
  - `npm run eval --suite meals` (harness per §8.1).
- **Tests:**
  - macro math, conversions, energy chain, clarify rule, draft transitions;
  - debounce and batching with a fake clock (photo + caption + photo → one turn);
  - real-PG interleavings (early wake, deadline pushed mid-turn, ingest between lease and claim, kill after `log_meal`, kill between bubbles);
  - webhook dedupe; number-source check.
- **Try it:**
  - Photo + caption + photo within 4 s → one reply.
  - `npm run fdc:seed && npm run fdc:search -- "white rice cooked"`.
  - Meal photo → "Logged …" plus the exact totals bubble.
  - Sauced pasta → exactly one question.
  - "Remove my last meal" → totals drop.
  - `npm run eval -- --suite meals`.

**M3: Menus and supplement stack with UL checks**
- **Menus and options:** `evaluate_options` (menus, suggestions, questions) and the option→log flow.
- **Supplements:** the supplement tools and extraction schema, canonical nutrients and synonyms, unit and form conversions, average and max-single-day aggregation, plausibility bounds, duplicate keys.
- **UL table:** built from NIH ODS. Only verified rows go into the production file, and the UL logic is tested against a fake-nutrient fixture.
  - **Done criterion:** ODS reachable, *or* you paste the ODS tables, *or* you explicitly accept a partial table.
- **Fixtures:** synthetic label and menu fixtures (generated) plus yours.
- **Tests:**
  - folic acid in mcg FA (the 1,333 DFE (800 FA) prenatal is not flagged; 600 + 600 FA is flagged; 5-MTHF only is indeterminate);
  - preformed-A only; vitamin E by form;
  - weekly vitamin D single-day flag; duplicates by name; unit-misread confirmation.
- **Try it:** menu photo → 2–3 picks that fit what's left; two labels sharing vitamin D → duplicate flag; a high-dose label → over-UL flag with source-scoped wording.

**M4: Onboarding, consent, profile, commands**
- **M4a, deterministic compliance (no LLM):**
  - the per-message crisis screen;
  - onboarding, the age gate with the minor path, consent with policy versions and pre-split bubbles, pre-consent no-storage;
  - the pending-prompt state machine;
  - STOP/START/HELP/DELETE/MY DATA, including STOP racing an in-flight turn and a cron send, and DELETE while paused;
  - rights requests, suppressions, retention purges.
- **M4b, profile and safety:**
  - agent-led profile (`update_profile` with units); targets with guardrails (and the BMI rule once verified);
  - timezone capture (ask; DEFAULT_TIMEZONE otherwise; re-dating rules on correction);
  - Haiku triage with persisted `health_context`, fail-safe behaviour, care mode and cooldown, computed ED signals, scoped opt-outs;
  - the safety system-prompt rules.
- **Evals:** `npm run eval --suite safety` (synthetic labelled phrases). **A false negative on emergency, self-harm or high ED risk blocks the milestone.**
- **Tests:** consent determinism (no LLM path can write consent), STOP and DELETE flows, minor decline-and-delete, guardrail clamps, care routing for pre-consent and paused users, DELETE leaves zero rows and zero blobs.
- **Try it:**
  - "17" → decline.
  - "34" → consent → YES.
  - Photo before YES → asked to resend, nothing stored.
  - STOP → one reply, then silence.
  - DELETE → "no" → nothing happens.
  - DELETE → YES DELETE → everything gone.
  - An ED-risk text → care reply with no numbers.
  - `npm run eval -- --suite safety`.

**M5: Proactive check-ins, back-off, weekly recap, admin**
- **Check-ins:** deterministic opt-ins; `proactive_schedule`; claim-before-compose with atomic caps and back-off; lease-coordinated composition; folding and priority rules; weekly recap.
- **Time travel:** the dev clock and `npm run cron:tick -- --at`.
- **Housekeeping:** retention and draft jobs; `metrics_daily`.
- **Admin:** `/admin` (aggregates only, Basic auth, `no-store`, rate-limited failed logins) showing send-to-receive ratio, DAU, photos per user per day, open rights-request deadlines, and the media CPU cost.
- **Tests:**
  - back-off; caps with overlapping ticks;
  - quiet hours; DST fall-back (Sunday 2026-11-01 is a weekly-recap day);
  - Sunday with all categories on; STOP during a tick;
  - proactive consent determinism.
- **Try it:**
  - In `/dev/chat`, opt in to a morning plan.
  - `npm run cron:tick -- --at "<tomorrow> 08:05"` → plan arrives; run it again → nothing.
  - `--at 22:00` → nothing.
  - Two unanswered → paused; text anything → resumed.
  - Open `/admin`.

**M6: Sendblue, webhook verification, Vercel deploy, README**
- **Step 0:** confirm with the live docs or Sendblue support: the webhook auth header (or HMAC), STOP auto-reply behaviour, START unblocking, the caption/attachment split.
- **SendblueAdapter:** send, typing, reactions, upload-file, opt-out sync, fetch-back verification, group and tapback ignore.
- **Payloads:** captured through the redaction script.
- **Deploy:** Neon (schema-only previews, restore window set) and private Blob provisioning; env; `vercel.json` cron matched to your plan; build runs `db:migrate && next build`; README setup guide.
- **Launch gate.** The line stays limited to your test numbers until all of these exist:
  - a processor registry with DPAs or terms for Anthropic, Sendblue, Neon, Vercel and Stripe;
  - live privacy policy and CHD notice URLs, reviewed by counsel;
  - an HBNR breach runbook;
  - an Anthropic retention position (ZDR, or disclosed).
- **Tests:** verification, parsing against redacted captures, dedupe, the no-real-numbers guard.

**M7: Stripe trial and subscription**
- **Trial and access:** in-app trial (no card) starting at consent; `getAccess` (full / grace / gated) as a pure function.
- **Payment flow:**
  - SUBSCRIBE → `/pay/<token>`;
  - the route creates or reuses a Checkout session, multi-use within its TTL so iMessage link previews can't burn it;
  - pay pages carry the policy links.
- **Billing management:** BILLING → `/billing/<token>`; cancel-plan flow; the STOP-with-active-plan fact line.
- **Webhook:** signature check, `event.id` dedupe and a subscription re-fetch.
- **DELETE:** cancels the subscription and deletes the Customer.
- **Faking and privacy:** a fake BillingProvider for the simulator and evals. Only the user UUID goes in Stripe metadata.
- **Tests:** access matrix; webhook signature (`generateTestHeaderString`); idempotency; a gated user's crisis text still gets care; a gated "stop texting me" gets no sales text.
- **Try it:** time-travel past the trial → paywall (no price, no link) → SUBSCRIBE → fake checkout → access restored.

### 8.1 Eval harness (`npm run eval`)
- **How it runs:** in-process through SimulatorAdapter → ingest → kick, with `InlineRunner`, debounce 0 and a fixed clock (12:30 local).
- **Per fixture:**
  - a fresh dev-seeded consented user (`+1NPA55501XX`); seeding refuses unless the simulator is enabled outside production;
  - optional `.profile.json`;
  - clarifications answered from `.answers.txt` or with "just estimate", with both turns recorded;
  - users deleted afterwards.
- **FDC:** the local seed only, unless `--fdc-live`. A separate FDC key is used for evals.
- **Output:** the SPEC table:

  | fixture | kind | detected items (FDC description) | grams (low–high, confidence) | kcal/P/C/F | flags | reply text |
  |---|---|---|---|---|---|---|

  The flags column covers clarify, derived energy, over UL, duplicate, guardrail and safety. Then a summary with per-iteration latency, tokens (input, cache read, cache write, output) and estimated $ cost.
- **Repeats:** `--repeat N` adds kcal min/median/max and ask rate.
- **Deterministic checks:**
  - no markdown;
  - ≤3 bubbles of ≤300 characters;
  - the totals bubble equals the code value;
  - every number traces to a tool output;
  - no praise of restriction.
  - `.expect.json` ranges, when present.
- **Results** go to `eval-results/<ts>.json` (gitignored). Suites: meals, menus, labels, text, safety.

## 9. Open questions
**Needed from you to proceed smoothly:**
1. **Network and keys for this cloud environment.**
   - Allow `api.nal.usda.gov` and `fdc.nal.usda.gov` (M2), `ods.od.nih.gov` (M3), and later the Sendblue, Stripe and Vercel docs sites.
   - Add `ANTHROPIC_API_KEY` (and an `FDC_API_KEY` from api.data.gov) as environment secrets.
   - Without these, I build and test everything with fakes; only you can run live agent turns and evals, and M3's UL table waits on ODS access or pasted tables.
2. **Vercel plan:** stay on Hobby while building (cron daily, manual ticks for testing) and move to Pro before any real user or M7? Or use a GitHub Actions scheduler meanwhile? Also, will the project live under your personal account or a team? The team's plan couldn't be read.
3. **Public repo:** keep building here in public, or make it private / move to a new repo? Default: continue here, with nothing sensitive ever committed.

**Before launch (not blocking M1–M5):**

4. **Counsel items:**
   - keeping an HMAC'd consent/opt-out suppression record after DELETE (default: keep nothing);
   - the Neon restore window (proposed: 1 day);
   - DELETE fallback when the provider blocks sends to an opted-out user;
   - sending emergency or crisis replies to STOPped users (default: yes);
   - paywall wording;
   - whether CA SB 243 or NY's AI-companion law applies;
   - neutral Stripe product name and statement descriptor.
5. **Legal entity name and support contact** for HELP, the consent copy and the CHD notice.
6. **Anthropic:** pursue Zero Data Retention or a BAA (flagged content can otherwise be kept up to 2 years)? API tier and monthly budget for alerts?
7. **Review the ★ guardrail values** in §7 (SPEC asks you to).
8. **M6:** which Sendblue plan and how many lines (the AI Agent plan is ~$100/line/month and caps follow-ups at 200/day)?
9. **M7:** the subscription price. Defaults: USD, monthly only, 7-day trial; Terms/refund URLs needed.
