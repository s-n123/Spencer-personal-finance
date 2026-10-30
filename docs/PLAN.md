# Plan: iMessage AI nutrition coach (MVP)

**Status:** v2.2 for owner review (2026-10-29). Nothing is built yet.

**How this version was made:**
- v1 went to five independent adversarial reviewers: spec traceability, pipeline concurrency, agent/LLM design, privacy/safety, and data and developer experience.
- v2 folded in their 87 findings, 11 of them blockers.
- v2.1 fixed the 48 issues a verification pass then found in v2, mostly seams where two reviewers' fixes met.
- v2.2 fixes the 14 issues a final pass found in v2.1.
- Several findings were settled by experiments against a local Postgres 16. The main one: v1's turn-locking algorithm stranded messages under small clock skew. §2.1 replaces it.

**Inputs:**
- `SPEC.md` is the source of truth.
- `docs/research/*.md` holds dated notes, with each fact tagged `[primary]`, `[sdk-source]` or `[search]`.
- `DECISIONS.md` lists the defaults chosen without asking.
- `CLAUDE.md` holds the working conventions.

**Glossary:**
- **FDC:** USDA FoodData Central. Its datasets are **FNDDS** (survey foods, including mixed dishes), **SR Legacy** (classic reference foods), **Foundation** (lab-analysed basics) and **Branded** (packaged labels).
- **UL:** Tolerable Upper Intake Level. **ODS** is the NIH Office of Dietary Supplements, the source of the UL fact sheets. **DFE:** dietary folate equivalents.
- **MHMDA:** Washington's My Health My Data Act. **CHD notice:** its required "consumer health data" privacy notice.
- **HBNR:** the FTC Health Breach Notification Rule. **DPA:** data processing agreement. **ZDR:** Anthropic Zero Data Retention.
- **Fluid:** Vercel's function runtime. Many requests share one instance, and time spent waiting isn't billed as CPU.
- **Lease:** a per-user DB row that says which invocation is currently allowed to process that user's turn.

---

## 0. Things you should know first

1. **Your GitHub repo is public, and GitHub Pages is on.**
   - Everything committed is world-readable: code, plan, research.
   - So nothing sensitive is ever committed. Only fictional numbers like `+1 201 555 0100` appear. Your photo fixtures are gitignored by default. Captured provider payloads are committed only after a redaction script. A test scans for real-looking numbers.
   - Make the repo private if you don't want the code public (§9 Q3).
2. **Your Vercel account is on Hobby.** That plan has two problems for us:
   - cron jobs run at most **once a day** (±59 min), so the SPEC's 15-minute cron fails to deploy;
   - it is **for non-commercial use only**, so Stripe payments aren't allowed.
   - Everything is built to work on any plan (§7), but Pro is needed before real users.
3. **This build container can't reach some things:**
   - USDA FDC (`api.nal.usda.gov`, `fdc.nal.usda.gov`), NIH ODS (`ods.od.nih.gov`), and the Sendblue, Stripe and Vercel docs sites;
   - and there is **no `ANTHROPIC_API_KEY`** here.
   - I can build and unit-test everything with fakes regardless.
   - Live agent runs and evals, real FDC data, and the verified UL table need those hosts and keys (§9 Q1).
   - The SPEC forbids filling UL values from memory, so M3's table depends on ODS access or on you pasting the tables.

## 1. Architecture at a glance

```
 iPhone ─iMessage─► Sendblue ─webhook─► /api/webhooks/sendblue/[token] ─┐
 Browser ─► /dev/chat (simulator, dev only) ─► /api/dev/sim/messages ───┤
                                                                         ▼
  ingest() — one short DB-only transaction, then 200 (DB error → 503 so the provider redelivers):
    verify → suppression check → upsert user → PER-MESSAGE SCREEN on the in-memory text:
      keywords (STOP family → set pause NOW), crisis/ED/opt-out phrases → store only tags
    → consent-aware insert (pre-consent: no media, no free text) → dedupe → debounce state
    → PRIORITY INTENTS written in the same transaction (crisis copy; the one STOP confirmation)
                                                                         │ after(kick)
                                                                         ▼
  kick(user):  [1] PRIORITY PATH — send unsent priority intents (conditional claim), outside lease & debounce
               [2] Haiku triage per text (consented) and [3] single-flight media prefetch, during the debounce
               [4] LEASE FIRST (heartbeat) → [5] wait for process_after (re-read, re-sleep) → claim burst
                   → ensureMedia + ensureTriage → TurnRouter → fenced writes → release → recheck
               [6] opportunistic global sweep
                                                                         ▼
  TurnRouter (one claimed burst): handled rows (priority path) → commands → onboarding/consent
    → triage/care → access gate (M7) → Agent (Sonnet tool loop; tools compute every number)
                                                                         ▼
  OutboundSender: code-owned bubbles (totals, safety copy) + model text → intents (idempotent)
    → re-check pause/existence right before EACH send (pause-exempt: priority, safety, command) → adapter.send → record
  /api/cron/tick (any trigger): sweep · draft auto-commit · retention purges · proactive check-ins · metrics
  /api/internal/kick: self-handoff when an invocation runs low on time
  /admin (Basic auth): aggregate metrics only
```

**Invariants** (tested, not just intended):
- **Code does the arithmetic.** The model estimates; every kcal, gram, total, remaining figure, unit conversion, UL comparison and option score comes from a tool result or the context block.
  - The totals bubble is appended by code.
  - A number-source check rejects any number with a unit in model text that didn't come from this turn's tool results or context.
- **Safety and opt-outs always win.** The order is: priority path (crisis screen, STOP) → commands → onboarding → triage/care → access gate → agent. No onboarding, billing or debounce state can delay or suppress a crisis reply, an opt-out, HELP or DELETE.
- **Consent is deterministic.** Health-data consent, age, proactive opt-ins, STOP/START/HELP/DELETE/MY DATA and the crisis replies are code paths. The LLM never decides that consent was given.
- **One turn per user at a time.** This is enforced by the DB lease, and every turn side-effect write is fenced on still holding it. Check-in composition takes the same lease.
- **STOP takes effect inside ingest,** and pause is re-checked right before every individual send. Exempt from the pause check: the `priority`, `safety` and `command` outbound kinds (crisis copy, the STOP confirmation, and the START/HELP/DELETE/MY DATA/BILLING replies). Ordinary replies and check-ins are blocked.
- **Postgres is the only shared state.** Every time-sensitive SQL statement takes `$now` from the injected `Clock`.
- **Provider code is isolated** in `src/server/channels/<provider>/`.
- **Privacy:**
  - no message bodies, photos, phone numbers or LLM payloads in logs; errors are sanitized centrally, because DB errors otherwise embed bound parameters;
  - no trackers;
  - photos are stored EXIF-stripped and private, then purged on a schedule.

## 2. Key flows

### 2.1 Inbound → turn (SPEC Architecture 2 and 3)

**ingest()** (webhook or simulator; DB-only transaction, target <300 ms):
1. **Verify and parse.**
   - Sendblue: constant-time compare of the `sb-signing-secret` header, plus an unguessable path token.
   - Simulator: dev-only guards (§3).
   - Group chats, tapbacks, status callbacks and non-E.164 handles are **acknowledged and never persisted**; only a count is kept.
2. **Suppression check:** look up `HMAC(phone)` in `suppressions` (for example a declined minor). A suppressed number gets no users row and nothing stored. It gets at most one fixed reply per 24 h, tracked by `suppressions.last_reply_at` and sent directly through the adapter with no stored row.
3. **Upsert the user** by `phone_e164`, setting `users.line` to the line they texted.
4. **Per-message screen** on the in-memory text, before anything is stored. It runs on each message, never on a merged burst:
   - **Keywords.** Matched on the whole message after trimming, case-folding and stripping punctuation.
     - The STOP family sets `messaging_paused_at` **here, in this transaction**.
     - Other commands are tagged on the row.
   - **Crisis, ED and opt-out phrases.** A deterministic, high-precision regex list for every user, including pre-consent and gated ones:
     - emergency (chest pain, can't breathe, throat closing, overdose, fainted);
     - self-harm;
     - ED, as phrase-level patterns rather than bare words ("starving myself", "taking laxatives to", "purging after", "diet pills", "haven't eaten in N days"; never a bare "starving");
     - plain-language opt-out ("stop texting me", "leave me alone").
   - Hits store only a tag (`crisis_kind`, or `keyword='STOP'` for opt-out phrases), never the text.
5. **Consent-aware insert:** `INSERT inbound_messages … ON CONFLICT (provider, provider_message_id) DO NOTHING RETURNING id`.
   - **Before health-data consent (from M4):**
     - text is stored only if the whole message is a command or a YES/AGREE reply;
     - age answers store NULL text plus `keyword='age_answer'` and the derived `is_adult`;
     - everything else is NULL at insert;
     - no media row or provider URL is stored, only `pre_consent_media_count`.
6. **Debounce state:**
   - `INSERT user_turn_state (user_id, process_after, burst_started_at) VALUES ($u, $now+DEBOUNCE, $now) ON CONFLICT DO UPDATE SET burst_started_at = COALESCE(old.burst_started_at, $now), process_after = LEAST(GREATEST(old.process_after, $now+DEBOUNCE), COALESCE(old.burst_started_at,$now)+MAX_DEBOUNCE)`.
   - CLAIM sets `burst_started_at = NULL`, so every burst gets its own 15 s cap.
7. **Priority intents,** in the same transaction:
   - a crisis-tagged row → intent `priority:<inbound_id>:crisis` with the fixed copy;
   - a STOP row → intent `priority:<inbound_id>:stop`, guarded by `UPDATE users SET stop_confirmed_at=$now WHERE stop_confirmed_at IS NULL OR stop_confirmed_at < messaging_paused_at RETURNING`, so a pause episode gets exactly one confirmation.
   - Writing them here, not in `kick`, means a kick that dies early can't lose them.
8. **Duplicates:** a duplicate delivery whose original row is still pending or processing re-triggers `after(kick)` as a free retry. Otherwise return 200.

**kick(user)** (in `after()`; also called by `/api/internal/kick` and the sweepers). It is idempotent. `me` is a random UUID per call, and the deadline is `D = getDeadline() ?? start+300 s`.
1. **Priority path** (outside the lease, before any waiting). Send every unsent priority intent for this user, crisis intents first. The copy:
   - emergency: call 911;
   - self-harm: call or text 988, plus 911 if in danger;
   - ED: the care message with the helpline;
   - STOP: the confirmation.
   - Each send goes through a conditional claim, `UPDATE outbound_messages SET status='sending' WHERE id=$id AND status='intent' RETURNING`, so concurrent kicks can't double-send.
   - Priority intents are exempt from lease fencing.
   - Rows are screened once, at ingest. Re-driven kicks never re-screen; they only send what is still unsent.
2. **Triage during the debounce:** consented users, messages with text. Haiku 5.5 runs per message and stores only result fields plus `triage_status` (pending, done or failed) on the row.
3. **Media prefetch:** consented users only, and only this message's media. Single-flight:
   - claim: `UPDATE media SET status='downloading', claimed_until=$now+60s, attempts=attempts+1 WHERE id=$id AND (status='pending' OR (status='downloading' AND claimed_until<$now)) AND attempts<3`;
   - download with a 15 s timeout and a byte cap;
   - sniff the type; HEIC→JPEG in a worker thread;
   - auto-orient, strip EXIF, resize (port of Anthropic's `resizedSize`);
   - put to the deterministic key `users/<uid>/<media_id>.jpg`;
   - `UPDATE … SET status='stored' WHERE status='downloading'`; if that touches 0 rows, delete the blob just written.
4. **Lease first:** `ACQUIRE: UPDATE user_turn_state SET lease_owner=$me, lease_expires_at=$now+45s WHERE user_id=$u AND (lease_owner IS NULL OR lease_expires_at<$now) RETURNING 1`.
   - **Fresh lease held by someone else** (expiry more than 25 s away): a live holder will see our message when it rechecks. Return.
   - **Lease close to expiry:** the holder missed heartbeats. Sleep until it expires, then retry, at most 3 times.
   - **Heartbeat:** RENEW every 15 s, fenced on `lease_owner=$me`. A failed renew aborts the turn through an `AbortSignal`.
   - **Fencing:** every turn side-effect write (meals, supplements, profile, reply intents) adds `AND EXISTS (lease_owner=$me AND lease_expires_at>$now)`. A stalled holder therefore can't commit after a takeover.
5. **Holder loop:**
   - Read `process_after` and the pending state.
   - If `process_after > $now`, **sleep until then and re-read**. Never exit on an early wake; that was v1's stranding bug.
   - If `D-now < 150 s`, hand off: self-POST to `/api/internal/kick` with `INTERNAL_KICK_SECRET`, plus the Vercel protection-bypass header on previews. Then stop.
   - Otherwise **CLAIM**: `UPDATE inbound_messages … SET status='processing', turn_id=$t … WHERE <lease still ours> AND process_after <= $now`. Gating on both means a photo that lands mid-claim waits for its caption.
   - `ensureMedia(msgs)`: wait up to 20 s for in-flight downloads; tell the model if a photo couldn't be loaded.
   - `ensureTriage(msgs)`: wait up to 5 s for pending triage, then run it inline. Only a genuine Haiku failure (timeout, refusal, parse error) triggers the fail-safe.
   - Run the turn, mark the rows done, and loop.
6. **Release, then recheck:**
   - RELEASE, fenced on `lease_owner`.
   - If pending rows remain, retry the acquire; this closes the release race.
   - Finally run the **opportunistic global sweep**: up to 5 users with pending or processing rows older than 30 s and an expired lease, each handed off, never run inline. Any user's traffic thereby recovers anyone's stranded turn within seconds, even on Hobby.

**Turn semantics:**
- **Turn clock:** `max(sent_at)` of the claimed messages. It sets `local_date`, "today" and the totals line, so a 23:59:58 snack stays on today.
  - If the turn starts more than 10 min late, the reply acknowledges the delay.
  - If it starts more than 12 h late, there is no agent run: a short "sorry I missed this — want me to log it for <day>?" is sent, held until quiet hours end.
- **Time budget:**
  - Every Anthropic call gets `{signal, timeout: min(60 s, remaining-45 s), maxRetries: remaining>150 s ? 1 : 0}`; the signal also cuts short the SDK's retry-after sleeps.
  - 30 s is reserved for sends (10 s timeout each, `maxRetries 0`).
  - At most 6 tool-loop iterations; `maxDuration = 300` on the turn routes.
- **Turn phases:**
  - `turns.status` moves `claimed → effects_committed → reply_written → done`.
  - Reply bubbles are written as **intents** keyed `reply:<anchor_inbound_id>:<i>` before any send.
  - Sends are at-most-once: an ambiguous result becomes `unknown` and is never auto-resent, because Sendblue sends have no idempotency key.
- **Orphaned-turn recovery:**
  - if unsent intents exist, send them;
  - else, if side effects were committed, send a deterministic recap computed from the DB;
  - else re-run the turn, which is safe because nothing was committed.
- **Merge rule:** if new messages arrive while the turn's model call is running, and there is no side effect or intent yet, abort the call and re-claim everything as one turn.
- **DB pool:** `pg` Pool with `max 10` in production (dev: `max 4`, a `globalThis` singleton across HMR), `idleTimeoutMillis 5000`, `connectionTimeoutMillis 3000`, `query_timeout 10000`, plus `attachDatabasePool`. No transaction or checked-out client ever spans an LLM, provider, blob or sleep await.
- **Background promises:** every fire-and-forget promise goes through a catch-and-log helper.

### 2.2 TurnRouter (one claimed burst; the order is a safety property)
1. **Rows already handled by the priority path:**
   - **Crisis-tagged burst:**
     - write `safety_events(kind, source=keyword)`;
     - for consented users, apply the care state from step 5 (cooldown or ED window);
     - then end the turn: no onboarding prompt, no agent, no totals.
   - **Burst containing STOP:** non-command messages are marked `ignored`. Any commands allowed while paused (START, HELP, DELETE, MY DATA, BILLING) are processed in message order.
2. **Commands** (tagged per message at ingest):

   | Command | Behaviour |
   |---|---|
   | STOP family (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT, OPTOUT, plus the opt-out phrases) | Handled at ingest and on the priority path. Revokes every proactive category. If the provider rejects the confirmation with `OPTED_OUT`, it counts as already confirmed. For an active subscriber (M7), the confirmation adds the plan's status and the `/billing` link (wording is a counsel item, §9 Q4). If the provider blocks it, M7's fallback applies. |
   | START / UNSTOP | Resumes replies only. Each check-in category needs a fresh opt-in. |
   | HELP | Program name, support contact, how to opt out, how to cancel billing (listed separately), policy links, FDC attribution. |
   | DELETE → `YES DELETE` | See §2.6. |
   | MY DATA | Records a rights request: manual fulfilment within 45 days for the MVP. |
   | SUBSCRIBE / BILLING | M7. |

   - **While paused:** START, HELP, DELETE (and its confirmation), MY DATA, BILLING and safety replies are processed and their replies attempted. Everything else is ignored.
   - **Provider block:** Sendblue itself opts a number out on STOP and then rejects sends (`OPTED_OUT`). So for a paused user, state changes always happen (deletion, rights request, START), but replies may be undeliverable. They are recorded as `undeliverable`. See §2.6 for DELETE and M7 for billing. M6 Step 0 confirms the actual behaviour.
3. **Pending prompts** (one state machine):
   - The **age and consent prompts** stay outstanding until answered. Each non-answer gets the prompt again, at most once per 10 minutes.
   - **`YES DELETE`** binds within 10 minutes of a DELETE, whether or not the prompt was delivered. Any other message in between cancels it.
   - **A check-in opt-in YES** binds only as the next message, within 24 h.
4. **Onboarding (from M4)** uses deterministic copy from `policy_versions`, pre-split into bubbles of ≤300 characters and never passed through the LLM formatter. **Until M4,** simulator users are created as consented (dev-only, refused in production) so M1–M3 can be tried at all.
   1. **First message from an unknown number:** "AI coach, not a doctor" plus the neutral question "How old are you?". Only the derived 18+ boolean is stored.
      - **Under 18:** decline, delete everything, and keep an HMAC(phone) suppression row. This is permanent, with no re-ask; the decline names a support email for mistakes.
   2. **Consent prompt.** It names the 4 MHMDA elements:
      - categories: meals, photos, weight, goals, supplements, and health mentions like medications or pregnancy;
      - purposes;
      - recipients by category: the service providers that run this service (AI, messaging, hosting, payments);
      - how to withdraw: "text DELETE anytime".
      - It links the privacy policy and a **separate** CHD notice (`TODO` URLs via env) and ends with "Reply YES to agree".
   3. **Accepted replies:** YES, Y, AGREE or I AGREE, as the whole message.
   4. **On YES:** write a `consent_events` row containing:
      - the timestamp and policy version IDs;
      - the sha256 of exactly the bubbles sent, all their outbound provider IDs and delivery status;
      - the inbound provider message ID.
      - In M6 the YES is verified by fetching it back from the provider.
   5. **Pre-consent photos** are discarded with fixed copy: "Got your photo — I need your OK before I can save anything. Send it again after you reply YES."
   6. **Profile collection.** After consent, the agent asks for missing fields one at a time: goal, optional height/weight, diet preferences/restrictions, timezone, check-ins. Every question can be skipped ("skip", or just carrying on), and skipping never blocks logging; default targets apply.
5. **Triage and care** (consented users; results come from `ensureTriage`):
   - **Triage outputs:** `ed_risk` (none, possible or high), `self_harm`, `medical_emergency`, `health_context` (pregnant/nursing, rx_meds, condition), `minor_signal`, and `opt_out_scope` (none, all, proactive_all or proactive:<kind>).
   - **Input:** the last ~6 messages as text. Bursts with no text are skipped.
   - **Fail-safe:** a genuine triage failure suppresses numbers and appends the 988 and helpline line for that turn, and never runs the plain agent.
   - **Computed signals** (daily job): logged intake below the floor for `BELOW_FLOOR_STREAK_DAYS`, repeated requests for sub-floor targets, and a goal weight in the underweight-BMI range (cut-off verified from CDC/NIH before coding; no BMI rule until then).
   - **Care mode** (crisis tag, self-harm, or corroborated high ED risk):
     - no numbers or tracking talk;
     - share the National Alliance for Eating Disorders helpline (config, with `verified_at`), 988, and "text ALLIANCE to 741741".
     - **Corroborated** (a keyword hit, a computed signal, or a second "high" within 7 days): `ED_COOLDOWN_DAYS` (14) with no proactive messages and no calorie talk.
     - **Single uncorroborated "high":** resources, shared gently, plus `ED_SHORT_COOLDOWN_DAYS` (3).
     - **Exiting** a cooldown requires it to have elapsed **plus** an explicit deterministic re-opt-in. Nothing resumes on its own.
   - **ED risk "possible":** suppresses the totals bubble for that turn. Only a corroborated "possible" (a keyword hit, a computed signal, or a second "possible" within 7 days) starts the 14-day window, during which totals stay suppressed and the agent is gentler. Repeats escalate to care mode.
   - **`health_context`:** persisted as coarse booleans plus a timestamp, never the medication or condition text. While any flag is set, supplement tool results carry `advise_pharmacist: true` (computed in code), and the prompt requires the pharmacist/doctor line.
   - **`minor_signal`,** or `update_profile` receiving an age under 18, goes down the decline-and-delete path.
   - **`opt_out_scope`:** `all` = STOP; a scoped value turns that category off and confirms; an ambiguous one gets one confirming question.
6. **Access gate (M7):**
   - A gated user gets: "Your free trial has ended. Reply SUBSCRIBE for a payment link, or DELETE to remove your data."
     - It carries **no price and no link**, so it isn't a commercial text.
     - It is rate-limited to once every 24 h.
   - The `/pay` link goes out only in reply to SUBSCRIBE or a clear request to pay.
   - Never gated: commands, onboarding, safety, MY DATA, DELETE.
7. **Agent** (§4).

### 2.3 Meal photo → log (SPEC Architecture 4 and 5)
1. **What the agent sees:** the user's images (labelled `img1…`), the caption, and a context block containing:
   - local date, time, weekday and the timezone source;
   - profile, targets, and **precomputed** remaining kcal and protein (floored at 0, with a `low_remaining` flag);
   - today's meals with short handles (`m1, m2…`) and code-computed totals;
   - the open draft, if any ("auto-logs at <time>");
   - missing profile fields, a summary of the supplement stack, and safety flags.
2. **`search_foods({items:[{label, queries:[1–3 FDC-style variants], kind:'generic'|'branded', quantity?, unit?}]})`** handles all items in one call.
   - **Ranking.** It searches the local FDC seed by relevance first: the union of `word_similarity` (pg_trgm) and full-text search, then a data-type boost (FNDDS > SR Legacy > Foundation), with near-duplicates merged. The live API covers Branded items and misses.
   - **Per item it returns ≤5 candidates,** each with:
     - `fdc_id`, data type and description;
     - kcal and macros per 100 g (or per 100 ml if the basis is ml);
     - portion options with **code-computed** values, e.g. `p2: 1 cup = 205 kcal, 4.3 g protein`;
     - for FNDDS mixed dishes, `includes_added_fat` and `includes_sauce`.
   - **Quantity-aware.** If `quantity`/`unit` are given ("3 eggs"), it also returns computed totals. Text questions like "how much protein in 3 eggs?" therefore need no model arithmetic.
3. **`log_meal`** inputs:

   | Field | Values |
   |---|---|
   | `when` | now, earlier_today, yesterday, or an ISO time |
   | `title` | meal title |
   | `image_refs` | which photos this meal came from |
   | `possible_additions` | cooking_oil, butter, dressing, sauce, sugar_or_syrup, milk_or_creamer, or none |
   | `draft_ref`, `skip_clarification`, `option_ref` | link to an open draft; skip the question; log a saved option |
   | `items` | `{fdc_id, label, quantity, quantity_low, quantity_high, unit: g\|ml\|oz\|fl_oz\|portion, portion_ref, confidence, extra_beyond_recipe}` |

   - **Code converts every quantity to grams,** using FDC portion weights and the g/ml basis.
   - **Rejected with `is_error`:**
     - an `fdc_id` that wasn't returned by this turn's `search_foods`, the draft, or today's meals;
     - an oil or sauce add-on to a mixed dish whose recipe already includes it, unless `extra_beyond_recipe:true` (meaning the user explicitly said extra).
4. **Code computes** `per100 × grams / 100` per item. Energy comes from the chain 1008 → 2047 → 2048 → kJ/4.184 → Atwater 4/4/9, with the last marked derived. Code snapshots the FDC values onto the item and computes the kcal spread.
5. **Clarification (decided in code):**
   - **Trigger:** the kcal spread is at least `max(CLARIFY_MIN_KCAL_RANGE=150, 25% of the meal)`, or a hidden-calorie candidate is plausible.
     - The hidden-calorie category comes **from the FDC record**, not the model's label: fats and oils, dressings, sauces, beverages other than water / black coffee / plain tea / diet soda, and alcohol. The model's `possible_additions` add to it.
     - **Never** a fat or sauce question for items with `includes_added_fat`/`includes_sauce`.
   - **Typed question.** Code returns one of `count`, `size_option`, `fat_used`, `drink_type_size` or `ate_all`, each with 2–4 options mapped to grams. The model asks ONE short question, never in grams.
   - **Drafts:**
     - at most one open draft per user, excluded from totals until committed;
     - it auto-commits at the point estimate, with a code-written "logged lunch with my best guess" note, when a new meal is logged, when the next turn doesn't address it, or after `DRAFT_TTL` (2 h, via the cron tick).
   - **Limits:**
     - at most one question per meal;
     - after two "just estimate" replies, stop asking that user for 7 days;
     - the clarification takes the single question slot over any profile question.
6. **Reply:**
   - The model writes one line about what was logged, from the code-built `logged_line` (meal title, meal kcal, protein).
   - **OutboundSender appends the totals bubble itself** (e.g. `Today: 1,240 / 2,000 kcal · 82 / 140 g protein`), reserving one of the 3 slots.
   - The totals bubble is suppressed in care mode or during an ED-possible window.

### 2.4 Suggestions and nutrition questions (M2) · Menus (M3)
- **`evaluate_options({source: question|suggestion|menu, options:[{name, items:[same shape as log_meal items]}]})`**
  - **Returns** computed macros, ranges and a fit score for each option.
  - **Saves** the options in `evaluated_options` for 6 h with `option_ref`s, so "I got the salmon bowl" logs exactly what was recommended.
  - **Fit** is scored against an effective budget of `max(remaining, MIN_MEAL_KCAL)`, weighted by goal. **It never suggests skipping a meal.**
  - The model drops options that conflict with stored restrictions and adds "check with staff" for allergies.
  - An option may be a single FNDDS mixed dish.
- **When it's used:**
  - M2b: "what should I eat for dinner?" and the morning plan's suggestion (`question`, `suggestion`).
  - M3: menu photos (`menu`). The agent reads the menu, shortlists up to 5 dishes and recommends the best 2–3.
- **System prompt rule:** never state a food's calories or macros unless they came from a tool result.

### 2.5 Supplement labels (M3)
1. **`save_supplement` (strict):** one call per product, even across front and back photos.
   - **Product fields:**
     - `product_name`, `brand`;
     - **`serving_size_amount` and `serving_size_unit`** (e.g. 2 capsules);
     - `servings_per_dose`;
     - `frequency` (daily, weekly, every_n_days or as_needed), `doses_per_period`, `period_days`;
     - `label_per_day_multiplier`.
   - **Ingredient fields:**
     - `name`;
     - `amount` (0 with `in_blend:true` when the amount isn't disclosed);
     - `unit` (mg, mcg, IU, g, mcg_DFE, mg_NE, mcg_RAE, other);
     - `source_compound` (e.g. "magnesium oxide");
     - `form`: retinol, beta_carotene, folic_acid, methylfolate, d_alpha, dl_alpha, nicotinic_acid, niacinamide, …, unknown;
     - `folic_acid_mcg` (0 if not stated) and `pct_as_beta_carotene` (-1 if not stated).
   - **Label amounts are always treated as elemental** (21 CFR 101.36).
   - If the label doesn't say how many the user takes, or how often, code asks.
2. **Code maps names to canonical nutrient keys** (synonyms table) and converts units:
   - vitamin D: IU→mcg;
   - vitamin E: IU→mg by form (the synthetic factor if the form is unknown);
   - vitamin A: only preformed retinol counts, and an unknown retinol/beta-carotene split makes the total **indeterminate**;
   - **folate:** the folic-acid UL is checked in **mcg of folic acid**, never DFE. If only DFE is given and the form is folic acid, code uses ×0.6. 5-MTHF is indeterminate. DFE is for display only.
3. **Code aggregates** the average daily dose and the max single-day dose, so a weekly 50,000 IU vitamin D is caught. It then checks against the UL table, scope-aware:
   - total-intake ULs: "from supplements alone; food adds more";
   - supplemental-only ULs: compared directly;
   - **any `in_blend` contribution:** that nutrient's total is "indeterminate (proprietary blend)", never compared as 0;
   - no verified row: "no verified upper limit on file", never a silent pass.
4. **Plausibility bounds.** An amount above roughly 20× the UL returns `needs_confirmation` naming the unit (the 50 mcg vs 50 mg misread).
5. **Duplicate key:** `nutrient_key` when mapped, otherwise the normalized ingredient name. That catches caffeine or melatonin in two products.
6. **Wording.** The agent phrases flags in general-wellness language: a UL is not a toxicity line, and it doesn't apply under physician care. The pharmacist line is added whenever `advise_pharmacist` is set.

### 2.6 DELETE, withdrawal and rights (SPEC Safety; MHMDA)
1. **Prompt.** The DELETE prompt explains the scope: "This deletes your whole account — every meal, photo, supplement and your profile. To remove one meal, say 'remove my last meal'. Our texting and payment providers keep limited records as described at <CHD notice>. Reply YES DELETE within 10 minutes to confirm."
2. **Confirmation.** It works while paused. In M6 the confirming message is verified by fetching it back from the provider.
   - **When the prompt can't be delivered** (provider `OPTED_OUT` after STOP), the two-step flow is published in HELP and the CHD notice ("text DELETE, then YES DELETE"), and `YES DELETE` within 10 minutes of a DELETE is accepted whether or not the prompt was delivered. That keeps the SPEC's confirmation step.
   - A bare DELETE that is never confirmed while sends are blocked is recorded as a `rights_requests` (delete) row, and fulfilled through the support channel within 45 days. Counsel reviews this (§9 Q4).
3. **On confirmation, in order:**
   1. Cancel the Stripe subscription and delete the Customer (M7). On failure, copy the Stripe IDs into `pending_deletions` (no user FK) for a retrying job; the account wipe goes ahead.
   2. Delete the `users` row (cascades).
   3. Delete blobs **by prefix** `users/<uid>/`.
   4. Write a non-identifying `deletion_receipts` row.
   5. Send the final message **directly through the adapter** (no stored row, no pause check; it answers the user's own request; an `OPTED_OUT` is ignored).
4. **Withdrawal of consent** = DELETE. That keeps the consent copy simple and true.
5. **MY DATA** creates a `rights_requests` row with a 45-day clock (`due_at`), shown on /admin and fulfilled manually for the MVP. Appeals go to the support email, with a link to the WA AG complaint page.
6. **Processors.** They are listed in a processor registry, and Sendblue is notified by support ticket when needed. A STOPped user's Sendblue contact is never deleted, because that would erase their opt-out.
7. **Backups and previews:** the Neon restore window is set explicitly (§9 Q4), and preview branches are schema-only.

### 2.7 Proactive check-ins (M5)
1. **Opt-in per category** (morning plan, evening recap, supplement reminder, weekly recap):
   - `set_checkin_preferences` only *stages* a proposal. Code then sends fixed copy, e.g. "<Program>: want a morning plan around 8:00am Pacific? Up to 2 check-ins a day. Reply YES to turn it on; HELP for help, STOP anytime."
   - Only an exact YES, sent as the next message within 24 h, writes `consent_events(proactive:<kind>)` and enables the category. That YES also confirms the timezone (`timezone_source='user'`).
   - Turning a category off needs no confirmation. Everything defaults to off.
2. **Schedule.** `proactive_schedule(user_id, kind, next_due_at)` is computed in code, applying DST and quiet hours. It is recomputed whenever preferences or the timezone change, and after each send.
3. **Tick.** For each user with `next_due_at <= $now` (within a grace window):
   1. **Pre-check** (read-only): the lease is free, no inbound is pending, the user hasn't texted in the last 10 min, they aren't paused or in a cooldown, `unanswered_proactive_count < PROACTIVE_UNANSWERED_PAUSE`, the timezone is confirmed, and they aren't gated. If any fails, skip until the next tick; nothing is consumed.
   2. **Claim**, in one DB-only transaction. If any step changes 0 rows, roll back.
      - `INSERT proactive_sends ON CONFLICT DO NOTHING`;
      - a conditional increment of the user's **per-local-day** counter (`proactive_count_date`, `proactive_count < 2`), with `unanswered_proactive_count < PROACTIVE_UNANSWERED_PAUSE` and no check-in **of the same kind** in the last 20 h (this covers timezone changes) in the same `WHERE`;
      - a conditional increment of `line_daily_counters` (< `GLOBAL_DAILY_CAP_PER_LINE`, on the provider's day).
   3. **Take the lease, compose, re-check pause, send once** (at-most-once).
   4. **After the send:**
      - on `sent`/`unknown`: increment `unanswered_proactive_count`;
      - if the lease wasn't acquired, the pause re-check hit, or the send came back `opted_out`, `failed` or `rate_limited`: a compensating transaction deletes the claim and decrements the counters, so the user keeps the slot.
   - Sends fan out with bounded concurrency, and claiming stops at `D-60 s`.
4. **Content:**
   - **one bubble per check-in**, with numbers filled in from code templates;
   - a supplement reminder **folds into** the morning or evening message when both are due together; otherwise it is sent alone;
   - on Sunday the weekly recap replaces the evening recap;
   - if the cap binds, priority is weekly > morning > evening > supplement;
   - "adherence" means within ±10% of target, and days below the floor are never counted as success;
   - the weekly recap carries a periodic "text STOP to pause" reminder.
5. **Never in a check-in:** pricing, links or upgrade copy.
6. **Back-off:** any inbound resets `unanswered_proactive_count`. At 2 or more, check-ins pause until the user texts again.

## 3. Channel adapters (SPEC Architecture 1)

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
  fetchMessage?(providerMessageId: string): Promise<{ text: string | null; from: string } | null>; // consent/delete check
  setOptOut?(to: string, optedOut: boolean): Promise<void>;       // START re-enables the provider opt-out
}
// SendResult.status: 'sent' | 'unknown' | 'opted_out' | 'rate_limited' | 'failed'
```

**SimulatorAdapter (M1):**
- An iMessage-style thread at `/dev/chat`:
  - image upload; the browser downscales, and HEIC passes through raw;
  - typing dots, a phone switcher, and reset (which also clears suppressions for fictional numbers);
  - a dev **time-travel** control (M5).
- Sends write `outbound_messages`. Typing and reactions go to `simulator_events`, which the page polls.
- A fake `opted_out` mode is used to test provider blocking.
- **Guards:**
  - hard-off when `VERCEL_ENV=production`, whatever `ENABLE_SIMULATOR` says;
  - checked in both `proxy.ts` and every handler;
  - only fictional `+1NPA55501XX` numbers are accepted;
  - previews also need admin Basic auth.

**SendblueAdapter (M6):**
- **Auth and base URL:** the `sb-api-key-id` and `sb-api-secret-key` headers, base `https://api.sendblue.co`.
- **Sends:** `maxRetries: 0`, then reconcile status.
- **Endpoints:**
  - typing: `/api/send-typing-indicator`;
  - reactions: `/api/send-reaction`;
  - outbound images: `/api/upload-file` (never public URLs to user photos);
  - opt-out sync: `/api/v2/contacts/opt-out`.
- **Inbound:** lenient Zod schemas until real payloads are captured; captures pass through the redaction script.
- **Measure** the gap between webhooks, to tune the debounce.

## 4. Agent design (SPEC Architecture 4)

**Request shape:**
- `tools`: sorted and frozen; a 1 h `cache_control` on the last one.
- `system`: static; a 1 h `cache_control`.
- **History** (the last ~12 exchanges) as alternating user/assistant **text-only** messages:
  - past photos become code-written summaries (`[photo 12:40: logged chicken teriyaki bowl]`), written from the tool that used the image (via `image_refs`);
  - past totals lines become `[totals]`.
- **Final user message:** the context block, then labelled images, then the caption.
  - Re-attach the open draft's images, or the previous turn's images if they're under 30 min old and the new burst has none (≤20 images total).
- **Automatic 5-minute `cache_control`** on the request, so loop iterations 2+ read the turn prefix (3 of 4 breakpoints used).
- **Never replayed:** assistant, thinking or tool blocks from earlier turns.
- **Images** go as base64 only: no URL sources, no Files API.

**Model params:**
- `MODEL_MAIN=claude-sonnet-5-5`.
- Never `temperature`, `top_p` or `top_k` (400 on API 2026-10-21).
- Adaptive thinking; `MODEL_MAIN_EFFORT=medium`, constant within a turn.
- **`max_tokens` 8000.** A `max_tokens` stop never runs tools from that response: retry once with `max_tokens` doubled, then send the canned reply (plus the totals bubble if a meal was committed).
- `tool_choice: auto` only. `strict: true` on the write tools (`log_meal`, `edit_or_delete_meal`, `save_supplement`).
- `metadata.user_id` = the user's UUID. SDK OpenTelemetry off.

**Schemas:**
- Each tool has a **bound-free wire schema** used as `input_schema`: plain types, enums, sentinels instead of nullable fields. A separate Zod schema carries the bounds for validation.
- A unit test walks each strict tool's emitted JSON against a keyword allowlist. Unsupported: `minimum`, `maximum`, `multipleOf`, `minLength`, `maxLength`, `minItems`>1/`maxItems`, recursive or external `$ref`; `pattern` only if simple and free of user data. The test also asserts ≤20 strict tools, ≤24 optional params and ≤16 union params (target ≤12).
- No user data in enum, const or pattern.
- Run a smoke call with the full tool set after any schema change.

**Tools** (the 9 SPEC tools plus 2):

| Tool | Purpose | M |
|---|---|---|
| `search_foods` | FDC candidates with code-computed per-portion values (and totals when a quantity is given) | 2 |
| `log_meal` | convert, compute, log, or return a typed clarification; returns `logged_line` | 2 |
| `edit_or_delete_meal` | by handle (`m1`) or `last`; scale, replace items, change time, delete | 2 |
| `get_day_summary` | totals, targets, remaining (floored) for today, yesterday or a date | 2 |
| `get_history` | per-day totals, averages and adherence band over a range | 2 |
| `evaluate_options` | questions and suggestions (M2), menus (M3) | 2/3 |
| `save_supplement` / `remove_supplement` / `get_supplement_stack` | stack CRUD plus aggregation, UL, duplicate and pharmacist flags | 3 |
| `update_profile` | `{value, unit}` for height and weight; appends to `weight_entries`; recomputes targets with guardrails; rejects age <18 | 4 |
| `set_checkin_preferences` | stages a proposal that code confirms with a deterministic YES prompt | 4/5 |

**System prompt** (static, cached; **written in M1 and complete from M2**):
- **Texting style** (SPEC): plain text only, 1–3 short bubbles under ~300 characters, friendly, emoji sparingly, one question at a time, the after-logging format.
- **Safety rules:**
  - AI coach, not a doctor;
  - general wellness only: no diagnosis, treatment, medication or dose advice; FDA general-wellness wording;
  - never praise skipping meals, restriction or compensatory exercise;
  - always suggest a real meal, even when little is left;
  - add the pharmacist/doctor line when `advise_pharmacist` is set;
  - tell the user to call 911 in an emergency;
  - never describe people or faces in photos (biometric data).
- **Grounding rules:** never state calories or macros unless they came from a tool; never compute totals or remaining; use `logged_line`.

**OutboundSender pipeline:**
1. Strip markdown.
2. **Number-source check:** one corrective retry, then strip the offending number. The same applies to a "logged" claim made without a committed `log_meal`.
3. Add the code-owned bubbles (totals, safety copy).
4. Fit into 3 bubbles of ≤300 characters by **merging, never dropping**; if it still doesn't fit, one "shorten" retry.
5. Write the intents.
6. Re-check pause and existence right before each send. Kinds `priority`, `safety` and `command` are exempt from the pause check.

**Stop reasons and errors:**
- `refusal`: canned caring reply plus resources, and a `safety_event`.
- Context overflow: retry with trimmed history.
- Spend-cap 429: alert, send one "having trouble" reply, don't retry.

**Haiku triage:** `messages.parse` + `zodOutputFormat`, thinking off, `max_tokens 1024`.

**Latency target** (last inbound → first bubble, excluding the 4 s debounce):
- photo log: p50 ≤12 s, p95 ≤25 s;
- text: ≤8 s.
- Typing starts at claim. Evals sweep effort (low/medium) and `thinking: between_tools`.

**Cost estimate** (anthropic.md prices; to be measured in evals):

| Item | Estimated cost |
|---|---|
| Photo log | ~$0.03–0.04 |
| Text Q&A | ~$0.01 |
| Menu | ~$0.06 |
| Triage | ~$0.0001 |
| Active user (3 photos + 3 texts a day) | ~$4/month |

## 5. Data model (Postgres + Drizzle)

**Conventions:**
- UUID primary keys and `timestamptz`.
- `text` + `CHECK` instead of pgEnum.
- Nutrients stored as `double precision` or integer, never `numeric`.
- `casing: 'snake_case'`, with explicit names for keys like `phoneE164`.

**FK actions:**
- `user_id → users` and parent → child: **CASCADE**;
- references (`media_id`, `turn_id`, `*_message_id`): **SET NULL**;
- retention purges null out content and keep the rows.

**Indexes:** on every FK and every hot path.

**Schema test:**
- every `user_id` column has a cascading FK and an index (exemption: `rights_requests.user_id`, which is SET NULL);
- after a DELETE, the user has 0 rows in every table.

| Table | Key columns (abridged) | M |
|---|---|---|
| `users` | `phone_e164` UQ, `provider`, `line`, `status` (onboarding/active), `is_adult`, `consented_at`, `timezone`, `timezone_source` (user/simulator/default), `last_inbound_at`, `messaging_paused_at`, `stop_confirmed_at`, `unanswered_proactive_count`, `proactive_count_date`, `proactive_count`, `ed_possible_until`, `care_cooldown_until`, `pending_prompt` jsonb (kind, expires_at), `trial_started_at`, `trial_ends_at` | 1 (+4,5,7) |
| `user_turn_state` | `user_id` PK, `process_after`, `burst_started_at`, `lease_owner`, `lease_expires_at` | 1 |
| `inbound_messages` | UQ(`provider`, `provider_message_id`), `user_id`, `to_line`, `text` (nullable), `keyword`, `crisis_kind`, `sent_at`, `received_at`, `status` (pending/processing/done/ignored/failed), `turn_id`, `pre_consent`, `pre_consent_media_count`, `triage_status` + result fields | 1 |
| `media` | `user_id`, `inbound_message_id`, `meal_id`, `supplement_id`, `provider_url` (cleared after download), `status` (pending/downloading/stored/failed/purged), `claimed_until`, `attempts`, `storage_key`, `content_type`, `w`, `h`, `bytes`, `sha256`, `kind`, `summary`, `purge_after` | 1 |
| `turns` | `user_id`, `status` (claimed/effects_committed/reply_written/done/failed), `mode` (agent/onboarding/command/care/gated/safety), `clock_at`, per-iteration latency and token usage (input/cache read/cache write/output), `stop_reason`, `error_code`. **No content.** | 1 |
| `outbound_messages` | `user_id`, `turn_id`, `kind` (reply/proactive/command/onboarding/safety/priority), `proactive_kind`, `from_line`, `text`, `media_id`, `idempotency_key` UQ, `status` (intent/sending/sent/unknown/suppressed/undeliverable/failed), `provider_message_id`, `error_code` | 1 |
| `simulator_events` | `user_id` FK, `type`, `payload` | 1 |
| `dev_clock` | one row: offset for simulator time travel; ignored in production | 1/5 |
| `fdc_foods` | `fdc_id` PK, `data_type`, `description` (GIN trigram + tsvector), `food_category`, `wweia_category`, `release`, `basis` (g/ml), `per100` jsonb, `energy_source`, `portions` jsonb, `includes_added_fat`, `includes_sauce`, `brand_owner`, `gtin`, `serving_size`, `serving_unit`, `source` (seed/api), `fetched_at` | 2 |
| `fdc_search_cache` | PK(`query_norm`, `data_types`), `fdc_ids[]`, `fetched_at` | 2 |
| `user_profiles` | `goal`, `sex?`, `birth_year?` (optional, for targets; not from the age gate), `height_cm?`, `goal_weight_kg?`, `activity_level?`, `weekly_rate_kg` (clamped), `diet_prefs[]`, `restrictions[]` (diet and allergies only), `has_rx_meds`, `pregnant_or_nursing`, `has_condition`, `health_context_at`, targets + `targets_source`, `guardrail_applied` | 2 (defaults)/4 |
| `weight_entries` | `user_id`, `kg`, `measured_at`. Source of truth; the profile caches the latest. | 4 |
| `meals` | `user_id`, `status` (draft/logged/deleted), `local_date`, `tz`, `eaten_at`, `meal_type`, `title`, `source`, totals (`kcal`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `sugar_g`, `sodium_mg`), `clarification` jsonb, `auto_commit_at`, `turn_id`; partial UQ(`user_id`) WHERE draft | 2 |
| `meal_items` | `meal_id`, `user_id`, `label`, `fdc_id`, `fdc_data_type`, `fdc_description`, `fdc_release`, `quantity`, `unit`, `grams`, `grams_low`, `grams_high`, `confidence`, `category`, `energy_source`, `per100` snapshot, computed macros; CHECK `grams_low ≤ grams ≤ grams_high` | 2 |
| `evaluated_options` | `user_id`, `source`, `options` jsonb, `expires_at` | 2 |
| `supplements` | `user_id`, `product_name`, `brand`, `serving_size_amount`, `serving_size_unit`, `servings_per_dose`, `frequency`, `doses_per_period`, `period_days`, `label_per_day_multiplier`, `active`, `removed_at` | 3 |
| `supplement_ingredients` | `supplement_id`, `user_id`, `raw_name`, `nutrient_key?`, `dup_key`, `form`, `source_compound`, `amount`, `unit`, `amount_norm`, `unit_norm`, `folic_acid_mcg`, `pct_as_beta_carotene`, `in_blend` | 3 |
| UL reference | **Versioned TS data** in `src/server/supplements/upper-limits.ts`. Each row: `nutrient_key`, `ul`, `unit`, `applies_to` (total/supplemental_only/specific_form), `counted_forms`, `excluded_forms`, `physician_care_note`, `source_url`, `sheet_updated`, `retrieved_at`, `verified: true`. Only verified rows are included. | 3 |
| `policy_versions` | `kind` (privacy/chd_notice/consent_prompt/age_prompt/optin_prompt/…), `version`, `url`, `bubbles` (pre-split), `sha256`, `effective_at`, `requires_reconsent` | 4 |
| `consent_events` | Append-only: `user_id`, `type` (age_18_plus/chd_collection/proactive:<kind>), `action`, `policy_version_ids`, `bubbles_sha256`, `outbound_provider_ids[]`, `delivery_status`, `inbound_provider_message_id`, `matched_keyword`, `verified_by_fetch`, `provider`, `service`, `app_version` | 4 |
| `safety_events` | `user_id`, `kind` (emergency/self_harm/ed_high/ed_possible/refusal/minor), `source` (keyword/triage/signal), `delivered`, `turn_id`. **No text.** | 4 |
| `suppressions` | `phone_hmac` PK, `reason` (minor; deleted/opted-out only if counsel approves, §9 Q4), `created_at`, `last_reply_at` | 4 |
| `rights_requests` | `type` (access/delete), `user_id` (SET NULL), `received_at`, `due_at`, `extended_due_at`, `processors_notified` jsonb, `completed_at`, appeal fields | 4 |
| `deletion_receipts` | `requested_at`, `completed_at`, `blobs_deleted`, `stripe_canceled`; no identifiers | 4 |
| `pending_deletions` | Stripe customer/subscription IDs, `attempts`, `next_attempt_at`; no user FK | 7 |
| `checkin_preferences` | `user_id` PK; per kind: enabled + local time; weekly is Sunday | 4/5 |
| `proactive_schedule` | (`user_id`, `kind`) PK, `next_due_at` (indexed) | 5 |
| `proactive_sends` | UQ(`user_id`, `kind`, `local_date`), `outbound_message_id`, `sent_at`, `answered_at` | 5 |
| `line_daily_counters` | (`line`, `provider_day`) PK, `n` | 5 |
| `metrics_daily` | UTC date, line, `inbound_turns`, `inbound_messages`, `outbound_total`, `outbound_proactive`, `active_users`, `photos` (non-identifying) | 5 |
| `billing_customers`, `subscriptions`, `stripe_events` (`event_id` PK, `type`, `processed_at` only), `pay_links` (`token_hash`, `user_id`, `kind`, `expires_at`, `last_session_id`) | | 7 |

**Retention** (in `policy.ts`, published in the CHD notice). The jobs run on the cron tick from M4a.

| Data | Kept for |
|---|---|
| Photos | 30 days |
| Message text, inbound and outbound | 90 days |
| Users who never consented | 30 days, then deleted |
| Ignored events | never stored |

## 6. File layout and scripts

```
SPEC.md CLAUDE.md DECISIONS.md README.md .env.example .nvmrc   .github/workflows/ci.yml
docs/PLAN.md docs/research/*.md
drizzle/                      # migrations (0000 = CREATE EXTENSION pg_trgm)
fixtures/                     # owner photos gitignored by default; synthetic/ committed
  meals/ menus/ labels/ synthetic/   <name>.{jpg,heic} + optional .txt caption, .answers.txt, .profile.json, .expect.json
  text/                       # scripted multi-turn conversations incl. safety.jsonl and bait cases
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
    pipeline/{ingest.ts, screen.ts, kick.ts, priority.ts, lease.ts, claim.ts, sweep.ts, handoff.ts, router.ts,
              outbound.ts, recover.ts}
    media/{image.ts, resize.ts, heic-worker.ts, download.ts, storage/{local.ts, vercel-blob.ts}}
    agent/{llm.ts, loop.ts, system-prompt.ts, context.ts, history.ts, format.ts, numbers.ts, triage.ts, tools/}
    nutrition/{fdc/{client,schemas,normalize,search,seed}.ts, energy.ts, convert.ts, macros.ts, clarify.ts, drafts.ts,
               targets.ts, day.ts, options.ts}
    supplements/{nutrients.ts, units.ts, upper-limits.ts, aggregate.ts}
    onboarding/  commands/  safety/{care.ts, signals.ts, resources.ts}  proactive/  admin/  billing/
  test/                       # pglite + pg helpers, fake clock/sleeper, fake LLM, fake FDC (provenance-labelled)
```

**npm scripts:**

| Script | What it does |
|---|---|
| `dev` | `tsx scripts/dev.ts`: loads env, starts the PGlite socket server on 127.0.0.1:54330 (8 connections) if needed, migrates, warns if the FDC seed is empty, runs `next dev` |
| `dev:next` | `next dev` on its own |
| `build`, `start` | standard Next.js |
| `lint` | `eslint .` |
| `typecheck` | `tsc --noEmit` |
| `test` | unit project: PGlite, no network |
| `test:pg` | node-postgres suite and race tests on a throwaway PG16, or on `TEST_DATABASE_URL` |
| `check` | typecheck + lint + `db:check` + test |
| `db:dev`, `db:generate`, `db:migrate`, `db:check`, `db:reset`, `db:studio` | `db:migrate` takes an advisory lock and verifies hashes and counts; `db:check` checks schema/migration parity and that the journal is monotonic |
| `fdc:seed`, `fdc:record`, `fdc:search` | FDC tooling |
| `eval` | with no flags, runs every suite; `-- --suite meals\|menus\|labels\|text\|safety`, `--only`, `--repeat`, `--effort`, `--fdc-live` |
| `fixtures:synthetic`, `fixtures:strip` | fixture tooling |
| `cron:tick -- --at <ISO>` | run the tick at a given time |

All scripts run via `tsx --conditions=react-server` and load `_env.ts` (`@next/env`).

**CI** (GitHub Actions): `check` plus `test:pg` against a Postgres service container, on every push.

## 7. Platform choices (reasons in DECISIONS.md)

- **Next.js 16.4.3:** App Router, `src/`, `proxy.ts`, Node runtime, Cache Components off. Tailwind v4 for the simulator and admin pages.
- **DB:**
  - production: Neon Postgres via the Vercel Marketplace, with **schema-only preview branches**; `pg` + `drizzle-orm/node-postgres` pinned at 0.45.4;
  - dev: a PGlite socket server started by `npm run dev`, or any Postgres;
  - tests: PGlite for unit tests, real PG16 for the pg and race suites.
- **Storage:** private Vercel Blob in production, the local filesystem in dev. Only the resized, EXIF-stripped JPEG is kept.
- **Background work:** `after()` plus the DB state machine, the opportunistic sweep and self-handoff. Vercel Queues (beta) is not used; a delayed "watchdog" message is an optional add-on if you stay on Hobby.
- **Cron:** `/api/cron/tick` is idempotent and catch-up based, so any trigger works:
  - (a) Vercel Pro `*/15` (recommended, and required for commercial use);
  - (b) a GitHub Actions schedule every 15 min (often 5–15 min late; it disables itself after 60 days of repo inactivity);
  - (c) `npm run cron:tick`, or Hobby's daily run, while developing.
  - The Hobby daily cron is **not** relied on for turn recovery.

### Config (`src/server/config/policy.ts`; ★ = the SPEC asks you to review)

| Key | Default | Notes |
|---|---|---|
| `DEBOUNCE_MS` / `MAX_DEBOUNCE_MS` | 4000 / 15000 | SPEC default; re-measured with Sendblue in M6 |
| `QUIET_HOURS` | 21:00–08:00 local | SPEC. Some states (FL, OK, WA; search-only) use 8 pm for solicitations; our check-ins are opt-in and informational |
| `MAX_PROACTIVE_PER_USER_PER_DAY` | 2 per local day | SPEC; plus no kind repeated within 20 h |
| `GLOBAL_DAILY_CAP_PER_LINE` | 150 | Sendblue AI Agent plan allows 200 follow-up contacts/line/day (resets 3 AM ET) |
| `PROACTIVE_UNANSWERED_PAUSE` | 2 | SPEC |
| ★ `MIN_DAILY_KCAL` | 1200 female / 1500 male / 1500 unspecified | compliance.md §7.2 |
| ★ `MAX_WEEKLY_LOSS_KG` | min(0.9, 1% of body weight); deficit ≤1000 kcal/day | compliance.md §7.3 |
| ★ `UNDERWEIGHT_BMI` | verify from CDC/NIH before M4 | no BMI rule until verified |
| ★ `ED_COOLDOWN_DAYS` / `ED_SHORT_COOLDOWN_DAYS` / `ED_POSSIBLE_WINDOW_DAYS` | 14 / 3 / 14 | |
| ★ `BELOW_FLOOR_STREAK_DAYS` | 3 | computed ED signal |
| `CLARIFY_MIN_KCAL_RANGE` / `CLARIFY_MIN_FRACTION` | 150 kcal / 0.25 | |
| `DRAFT_TTL` | 2 h | |
| `MIN_MEAL_KCAL` | 400 | budget floor for suggestion fit |
| `DEFAULT_TARGETS` | 2000 kcal / 100 g protein | until a profile exists |
| `MEDIA_RETENTION_DAYS` / `MESSAGE_TEXT_RETENTION_DAYS` | 30 / 90 | |
| `TRIAL_DAYS` / `PAST_DUE_GRACE_DAYS` | 7 / 7 | M7; USD, monthly |
| ★ Helpline | Alliance 1-866-662-1235, Mon–Fri 9–7 ET | sources conflict (662 vs 622); re-verify before M4 ships |

### Env by milestone (in `.env.example`; a test asserts the schema keys match the example keys)

| Milestone | Variables |
|---|---|
| M1 | `ANTHROPIC_API_KEY`, `MODEL_MAIN`, `MODEL_FAST`, `MODEL_MAIN_EFFORT`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `TEST_DATABASE_URL`, `ENABLE_SIMULATOR`, `MEDIA_STORAGE`, `MEDIA_LOCAL_DIR`, `DEFAULT_TIMEZONE`, `APP_BASE_URL`, `INTERNAL_KICK_SECRET`, `LOG_LEVEL` |
| M2 | `FDC_API_KEY`, `CRON_SECRET` |
| M4 | `PRIVACY_POLICY_URL`, `CHD_NOTICE_URL` (TODO placeholders), `SUPPORT_CONTACT`, `PHONE_HMAC_KEY` |
| M5 | `ADMIN_USER`, `ADMIN_PASSWORD` (high-entropy, validated) |
| M6 | `BLOB_READ_WRITE_TOKEN`, `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_SIGNING_SECRET`, `SENDBLUE_WEBHOOK_PATH_TOKEN`, `SENDBLUE_FROM_NUMBER`, `VERCEL_AUTOMATION_BYPASS_SECRET` |
| M7 | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` |

## 8. Milestones

**Definition of done (every milestone):**
- `npm run check` and `npm run test:pg` are green;
- `.env.example`, `DECISIONS.md` and `CLAUDE.md` are updated;
- the work is committed and pushed to the branch;
- I give you a short summary and try-it steps, then **wait** for your go-ahead.

**Step 0 of any integration milestone:** re-read the live docs and mark each `[search]` fact the code relies on as verified, or confirm it with one live call. If a host is blocked, I stop and ask rather than code from `[search]`.

Larger milestones have internal a/b checkpoints. These are commits, not stops.

**M1: Scaffold, schema, simulator, agent describes photos**
- **Build:**
  - Next.js scaffold, CI, lazy env plus the `.env.example` test, `npm run dev` with an auto-started PGlite server, Drizzle with checked migrations, core tables.
  - `log.ts` allowlist, `sanitizeError` with a canary test, the fire-and-forget catcher.
  - The simulator and its guards (users created as consented until M4).
  - Pipeline: ingest with the per-message screen (keyword tags, crisis tags) and dedupe; `kick` with the priority path, heartbeat lease, fenced writes, claim, release-recheck, opportunistic sweep and handoff; outbound intents. The 4 s debounce with its per-burst 15 s cap was pulled forward from M2a (D-121).
  - Media: the single-flight pipeline (HEIC worker, EXIF strip, `resizedSize` port).
  - Agent: a minimal Sonnet loop with the full static system prompt (style and safety rules) that describes any photo in plain bubbles; the formatter.
- **Tests:**
  - dedupe; one message from a new number gives exactly one turn;
  - lease races: two concurrent kicks, early wake, holder death, a stalled holder blocked by fencing;
  - resize against the docs' examples;
  - EXIF/GPS stripped and orientation applied on a synthetic JPEG; HEIC decode of libheif's sample;
  - the formatter (merges, never drops); env/example parity; the log canary.
- **Try it:**
  1. `npm i` → `cp .env.example .env.local` (set `ANTHROPIC_API_KEY`) → `npm run dev`.
  2. Open http://localhost:3000/dev/chat as +12015550100.
  3. Send a JPEG and an iPhone HEIC: each gets 1–3 plain-text bubbles.
  4. "Resend" replays the same message ID and gets no second reply.

**M2: Meal logging, FDC grounding, day summary, clarifications, turn batching**
- **M2a: batching and the FDC data layer.**
  - The merge rule; turn clock; stale-turn recovery that knows about tool side effects (the 4 s debounce and 15 s cap shipped in M1, D-121).
  - Cron tick with the sweep and **draft auto-commit**.
  - FDC client and normalizer (handles spec drift and HTML error bodies).
  - `fdc:seed` importer for FNDDS + SR Legacy + Foundation, including the FNDDS added-fat and sauce flags.
  - Relevance-first search, the `fdc:search` CLI, the energy chain.
  - Fixture provenance: `recorded` (you run `npm run fdc:record`), `third-party-capture` (shape tests only), or `synthetic`.
- **M2b: meal logging.**
  - Meals schema.
  - Tools: `search_foods` (quantity-aware), `log_meal` (unit conversion, ID guard, double-fat guard), `edit_or_delete_meal`, `get_day_summary`, `get_history`, `evaluate_options` (question and suggestion).
  - Typed clarifications and the draft lifecycle; the code-owned totals bubble; the number-source check; default targets.
  - `npm run eval -- --suite meals` and `--suite text` (bait cases: praise for skipping, diagnosis and medication questions).
- **Tests:**
  - macro math, conversions, energy chain, clarify rule (including no fat question on mixed dishes), draft transitions;
  - debounce and batching with a fake clock (photo + caption + photo → one turn; two bursts more than 15 s apart are each debounced);
  - real-PG interleavings: early wake, deadline pushed mid-turn, ingest between lease and claim, kill after `log_meal`, kill between bubbles;
  - webhook dedupe; the number-source check.
- **Try it:**
  - Photo + caption + photo within 4 s → one reply.
  - `npm run fdc:seed && npm run fdc:search -- "white rice cooked"`.
  - Meal photo → "Logged …" plus the exact totals bubble.
  - Sauced pasta → exactly one question.
  - "Remove my last meal" → totals drop.
  - "What should I eat for dinner?" → options with computed numbers.
  - `npm run eval -- --suite meals`.

**M3: Menus and supplement stack with UL checks**
- **Build:**
  - `evaluate_options` for menus;
  - the supplement tools and extraction schema;
  - canonical nutrients and synonyms; unit and form conversions;
  - average and max-single-day aggregation, plausibility bounds, duplicate keys, and the blend and vitamin-A indeterminate rules.
- **UL table:** built from NIH ODS. Only verified rows go into the production file; the UL logic is tested against a fake-nutrient fixture.
  - **Done criterion:** ODS is reachable, *or* you paste the ODS tables, *or* you explicitly accept a partial table.
- **Fixtures:** synthetic label and menu images (generated) plus yours.
- **Tests:**
  - folic acid in mcg FA: the 1,333 DFE (800 FA) prenatal is not flagged; 600 + 600 FA is flagged; 5-MTHF only is indeterminate;
  - preformed vitamin A only, and an unknown split is indeterminate; vitamin E by form;
  - a blend makes the total indeterminate; weekly vitamin D single-day flag; duplicates by name; unit-misread confirmation.
- **Try it:**
  - Menu photo → 2–3 picks that fit what's left.
  - Two labels sharing vitamin D → duplicate flag.
  - A high-dose label → over-UL flag, worded by scope.
  - `npm run eval -- --suite labels`.

**M4: Onboarding, consent, profile, commands**
- **M4a: deterministic compliance (no LLM).**
  - Consent gate on (ends the dev assumption); pre-consent no-storage.
  - Onboarding; the age gate with the minor path and suppression check; consent with policy versions and pre-split bubbles.
  - The pending-prompt state machine.
  - STOP/START/HELP/DELETE/MY DATA, including: STOP racing an in-flight turn and a cron send; DELETE while paused; the provider-blocked (`opted_out`) fallbacks.
  - Rights requests and **retention purges** on the tick.
  - Helpline re-verified.
- **M4b: profile and safety.**
  - Agent-led, skippable profile; `update_profile` with units; targets with guardrails (and the BMI rule once verified).
  - Timezone: ask, otherwise `DEFAULT_TIMEZONE`; re-dating rules on correction.
  - Haiku triage with `ensureTriage`, persisted `health_context`, fail-safe, care mode and cooldowns, computed ED signals, scoped opt-outs.
- **Evals:** `npm run eval -- --suite safety` (synthetic labelled phrases, including false-positive traps like "I'm starving, what's for dinner?"). **A false negative on emergency, self-harm or high ED risk blocks the milestone.**
- **Tests:**
  - consent determinism: no LLM path can write consent;
  - STOP and DELETE flows; minor decline-and-delete plus re-contact blocked;
  - guardrail clamps;
  - crisis replies for pre-consent, paused and re-driven messages (including a kick that dies before sending), exactly once, with a `safety_events` row and the care state applied;
  - a message that is both STOP and crisis gets both replies, crisis first;
  - [STOP, DELETE] and [STOP, START] bursts process the commands;
  - DELETE leaves zero rows and zero blobs.
- **Try it:**
  - As +12015550101: "17" → decline; texting again → nothing new.
  - As +12015550102: "34" → consent → YES. A photo before YES → asked to resend, nothing stored.
  - STOP → one reply, then silence.
  - DELETE → "no" → nothing happens. DELETE → YES DELETE → everything gone.
  - An ED-risk text → care reply, no numbers.
  - `npm run eval -- --suite safety`.

**M5: Proactive check-ins, back-off, weekly recap, admin**
- **Build:**
  - Deterministic opt-ins; `proactive_schedule`; pre-check → claim → lease → send, with compensation on skips.
  - Folding and priority rules; the weekly recap.
  - Dev clock and `npm run cron:tick -- --at`.
  - `metrics_daily`. (The sweep, drafts and retention jobs already run on the tick from M2a/M4a.)
  - `/admin`: aggregates only, Basic auth, `no-store`, rate-limited failed logins. It shows the send-to-receive ratio, DAU, photos per user per day, open rights-request deadlines, and average CPU ms per photo.
- **Tests:**
  - back-off (no check-in at 2 unanswered); caps under overlapping ticks; skipped, blocked or failed sends keep the slot;
  - quiet hours; DST fall-back (Sunday 2026-11-01 is a weekly-recap day);
  - Sunday with every category on; STOP during a tick;
  - proactive consent determinism.
- **Try it:**
  - In `/dev/chat`, opt in to a morning plan.
  - `npm run cron:tick -- --at "<tomorrow> 08:05"` → the plan arrives. Run it again → nothing.
  - `--at 22:00` → nothing.
  - Leave two unanswered → paused. Text anything → resumed.
  - Open `/admin`.

**M6: Sendblue, webhook verification, Vercel deploy, README**
- **Step 0:** confirm with the live docs or Sendblue support:
  - the webhook auth header, or HMAC;
  - STOP auto-reply behaviour; whether sends to opted-out contacts are blocked; whether `setOptOut(false)` may be used for one transactional reply; START unblocking;
  - whether fetch-back accepts a `message_handle`;
  - how captions and attachments are split across webhooks.
- **Build:**
  - SendblueAdapter: send, typing, reactions, upload-file, opt-out sync, fetch-back verification, ignoring groups and tapbacks.
  - Payloads captured through the redaction script.
  - Neon (schema-only previews, restore window set) and private Blob provisioning; env vars; `vercel.json` cron matched to your plan; build runs `db:migrate && next build`; README setup guide.
- **Launch gate.** The line stays limited to your test numbers until all of these exist:
  - a processor registry with DPAs or terms for Anthropic, Sendblue, Neon, Vercel and Stripe;
  - live privacy policy and CHD notice URLs, reviewed by counsel;
  - an HBNR breach runbook;
  - an Anthropic retention position (ZDR, or disclosed).
- **Tests:** verification (a forged secret → 401); parsing against redacted captures; dedupe; the no-real-numbers guard.
- **Try it:**
  - Text the line from your test number → reply.
  - Replay a captured webhook → no second reply.
  - Post with a wrong secret → 401.
  - STOP → one confirmation; START → replies resume.
  - Open the deployed `/admin`.

**M7: Stripe trial and subscription**
- **Build:**
  - In-app trial (no card) starting at consent; `getAccess` (full / grace / gated) as a pure function.
  - SUBSCRIBE → `/pay/<token>`: creates or reuses a Checkout session, multi-use within its TTL. Pay pages carry the policy links.
  - BILLING → `/billing/<token>`; the cancel-plan flow; the STOP-with-active-plan line.
  - **When the provider blocks sends to a paused subscriber:** use `setOptOut(false)` for one transactional reply, if M6 Step 0 shows that is allowed. Otherwise rely on Stripe's customer emails and portal login, which carry the manage and cancel link.
  - Stripe webhook: signature check, `event.id` dedupe, subscription re-fetch.
  - DELETE cancels the subscription and deletes the Customer (with `pending_deletions` on failure).
  - Fake BillingProvider for the simulator and evals. Only the user UUID goes to Stripe.
- **Tests:**
  - access matrix; webhook signature (`generateTestHeaderString`); idempotency;
  - a gated user's crisis text still gets care; a gated "stop texting me" gets no sales text;
  - a paused subscriber with the opted-out fake still has a cancel path.
- **Try it:** time-travel past the trial → paywall (no price, no link) → SUBSCRIBE → fake checkout → access restored.

### 8.1 Eval harness (`npm run eval`)

**How it runs:**
- in-process through SimulatorAdapter → ingest → kick, with `InlineRunner`, debounce 0 and a fixed clock (12:30 local);
- with no flags, every suite runs.

**Per fixture:**
- A fresh dev-seeded consented user (`+1NPA55501XX`); seeding is refused unless the simulator is enabled outside production.
- Optional `.profile.json`.
- A clarifying question is answered from `.answers.txt` or with "just estimate"; both turns are recorded.
- Users are deleted afterwards.
- The local FDC seed only, unless `--fdc-live`; evals use a separate FDC key.

**Output:**
- The SPEC table:

  | fixture | kind | detected items (FDC description) | grams (low–high, confidence) | kcal/P/C/F | flags | reply text |
  |---|---|---|---|---|---|---|

  The flags column covers clarify, derived energy, over UL, duplicate, indeterminate, guardrail and safety.
- A summary: per-iteration latency, tokens (input, cache read, cache write, output) and estimated cost.
- `--repeat N` adds kcal min/median/max and the ask rate.

**Deterministic checks:**
- no markdown;
- ≤3 bubbles of ≤300 characters;
- the totals bubble equals the code value;
- every number traces to a tool output;
- no praise of restriction, no diagnosis, no dose advice;
- `.expect.json` ranges, when present.

Results go to `eval-results/<ts>.json` (gitignored).

## 9. Open questions

**Needed from you to proceed smoothly**

1. **Network and keys for this cloud environment.**
   - Allow `api.nal.usda.gov` and `fdc.nal.usda.gov` (M2), `ods.od.nih.gov` (M3), and later the Sendblue, Stripe and Vercel docs sites.
   - Add `ANTHROPIC_API_KEY` (and an `FDC_API_KEY` from api.data.gov) as environment secrets.
   - Without these, I build and test everything with fakes; only you can run live agent turns and evals. M3's UL table waits on ODS access or on you pasting the tables.
2. **Vercel plan.**
   - Stay on Hobby while building (daily cron, manual ticks for testing), then move to Pro before any real user or M7? Or use a GitHub Actions scheduler in the meantime?
   - Will the project live under your personal account or a team? I couldn't read the team's plan.
3. **Public repo.** Keep building here in public, or make it private / move to a new repo? Default: continue here, with nothing sensitive ever committed.

**Before launch (not blocking M1–M5)**

4. **Counsel items:**
   - keep an HMAC'd consent/opt-out suppression record after DELETE? (default: keep nothing except minors);
   - the Neon restore window (proposed 1 day);
   - DELETE when the prompt can't be delivered: we accept `YES DELETE` anyway, and handle a bare unconfirmed DELETE as a 45-day rights request (§2.6);
   - sending crisis replies to STOPped users (default: yes, attempted);
   - the billing line in STOP confirmations for subscribers;
   - the paywall wording;
   - whether CA SB 243 or NY's AI-companion law applies;
   - a neutral Stripe product name and statement descriptor.
5. **Legal entity name and support contact** for HELP, the consent copy and the CHD notice.
6. **Anthropic data retention.** Should we pursue Zero Data Retention or a BAA? Flagged content can otherwise be kept up to 2 years. Also: what API tier, and what monthly budget should alerts use?
7. **Review the ★ guardrail values** in §7 (the SPEC asks you to).
8. **M6: Sendblue plan and line count.** The AI Agent plan is ~$100/line/month and caps follow-ups at 200/day.
9. **M7: subscription price.** Defaults: USD, monthly only, 7-day trial. Terms and refund URLs are also needed.
