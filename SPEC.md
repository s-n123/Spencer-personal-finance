# Build: iMessage AI nutrition coach (MVP)

First, save this entire prompt verbatim as SPEC.md in the repo root, and create a CLAUDE.md with the project's conventions and commands so future sessions have context.

## Product
An AI nutrition coach people use entirely over iMessage. There is no app and no Apple Health or wearable permissions. Users text a phone number with:
- Meal photos → identify the food, estimate portions, log calories/macros, reply with the running daily totals
- Restaurant menu photos → recommend the 2–3 best orders given their goals and what's left for the day
- Supplement label photos → save their "stack," total nutrients across products, flag duplicates and amounts above established upper limits
It also handles plain-text questions ("what should I eat for dinner?"), opt-in check-ins and a weekly recap. Users always text first; we never cold-message anyone.

## How to work
- Plan before coding. Propose the architecture, file layout, data model and milestone plan, list open questions, and wait for my OK.
- Build in the milestones below. At the end of each one, run tests, commit, give me a short summary and exact steps to try it, then wait for my go-ahead.
- Don't ask me about things that have sensible defaults. Decide, and log the decision in DECISIONS.md.
- Before writing integration code, read the current docs (Anthropic API, Sendblue, USDA FoodData Central, Stripe) rather than relying on memory.
- No secrets in code. Keep .env.example up to date.

## Stack (defaults; change only with a stated reason)
- TypeScript, Next.js (App Router), deployable to Vercel
- Postgres (Neon or Supabase) with Drizzle; Zod for validation; Vitest for tests
- Anthropic TypeScript SDK with a plain Messages API tool-use loop (no Agent SDK). Model IDs come from env: MODEL_MAIN=claude-sonnet-5-5 (vision + agent), MODEL_FAST=claude-haiku-5-5 (cheap classification). Use prompt caching for the system prompt and tool definitions.
- Image storage: Vercel Blob or S3

## Architecture
1. Channel adapter interface. Inbound messages are normalized to: phone (E.164), text, media URLs, provider message ID, timestamp. Outbound supports text and images, plus typing indicators and reactions where the provider supports them. Implementations:
   - SimulatorAdapter: a local page at /dev/chat that looks like an iMessage thread and supports image upload, so the whole product works without a provider account. Build this first.
   - SendblueAdapter (milestone 6). I may switch to Linq or Blooio, so keep all provider-specific code inside the adapter.
2. Webhooks: verify authenticity per the provider's docs, dedupe on provider message ID, return 200 immediately, and process in the background.
3. Turn batching: people send a photo, then a caption, then another photo. Debounce about 4 seconds per user and process the burst as one turn. Never process two turns for the same user at the same time.
4. Agent context: system prompt + user profile/goals + today's log + recent messages. Tools, at minimum: log_meal, edit_or_delete_meal, get_day_summary, get_history, save_supplement, remove_supplement, get_supplement_stack, update_profile, set_checkin_preferences. All arithmetic (macros, totals, remaining targets, nutrient sums) happens in code, never in the model.
5. Nutrition grounding: the model identifies foods and estimates grams with a confidence level. Macros are computed in code from USDA FoodData Central per-100g values × grams. If confidence is low on something that matters (portion size, oil/sauce, a drink), ask ONE short question before logging. Cache FDC lookups.
6. Supplements: extract product name, serving size, and each ingredient's amount and unit into structured JSON. Build a reference table of adult Tolerable Upper Intake Levels for common supplement nutrients from the NIH Office of Dietary Supplements fact sheets:
   - Look the values up; don't rely on memory.
   - Store the source URL for each row.
   - Note when a UL applies only to supplemental forms (e.g., magnesium, niacin, folic acid).
   - Flag totals over the UL and duplicate ingredients across products.
7. Media: download inbound images promptly (provider URLs can expire), store them, and resize per Anthropic's vision guidance before sending them to the model.

## Texting style (put this in the agent's system prompt)
- Plain text only, because iMessage doesn't render markdown. No bullet walls.
- 1–3 short bubbles per turn, each under ~300 characters. Friendly coach tone, emoji sparingly.
- After logging a meal: one line on what was logged, then the day's calories and protein vs. target.
- One question at a time.

## Safety and compliance
- Onboarding (first message from an unknown number):
  - Say it's an AI coach, not a doctor, and confirm the user is 18+.
  - Get explicit opt-in consent to store health and nutrition data; record the timestamp and policy version.
  - Link the privacy policy and a separate consumer health data notice (Washington My Health My Data Act, Nevada SB 370). Use TODO placeholder URLs; I'll write those.
  - Then collect goal, optional height/weight, dietary preferences/restrictions, timezone and check-in preferences. Everything is skippable.
- Commands: STOP pauses all outbound, START resumes, HELP explains, DELETE wipes all of the user's data after a confirmation.
- General wellness only: no diagnosing or treating conditions. If the user mentions prescription meds, pregnancy or a medical condition, suggest checking supplement changes with a pharmacist or doctor. For a medical emergency, tell them to call 911.
- Eating-disorder guardrails:
  - Enforce a minimum calorie target and a maximum weekly loss rate. Put the thresholds in config and flag them for my review.
  - Never praise skipping meals or extreme restriction.
  - If the user shows signs of disordered eating, drop the tracking talk, respond with care, and share the National Alliance for Eating Disorders helpline.
- Never sell or share health data. No ad pixels or third-party trackers. Keep message bodies and photos out of application logs.

## Proactive messaging (this also keeps our number from being flagged as spam)
- Opt-in only: morning plan, evening recap, supplement reminders, and a weekly recap on Sundays.
- A cron endpoint runs every 15 minutes and picks users who are due in their local time. Flag it if my Vercel plan can't run that often.
- Config values: quiet hours (default 9pm–8am local), max proactive messages per user per day (default 2), and a global daily cap per sending number.
- Back-off: after 2 unanswered proactive messages, pause proactive messages to that user until they text again.
- A password-protected /admin page showing send-to-receive ratio, daily active users and photos per user per day.

## Testing and evals
- Unit tests for: macro math, supplement aggregation and UL checks, debounce/batching, back-off, STOP/DELETE, webhook dedupe.
- A fixtures/ folder for test photos (I'll add my own meals, menus and labels). "npm run eval" runs every fixture through the agent via the simulator and prints a table: detected items, grams, macros, flags and the reply text.

## Milestones
1. Scaffold, schema, simulator at /dev/chat, and an agent that describes any photo
2. Meal logging with FDC grounding, day summary, clarifying questions, turn batching
3. Menus, plus the supplement stack with UL checks
4. Onboarding, consent, profile, commands
5. Proactive check-ins with back-off, weekly recap, admin page
6. Sendblue adapter, webhook verification, Vercel deploy, README setup guide
7. Stripe: free trial, then a subscription via a Checkout link sent by text; when the trial ends, gate access gracefully
