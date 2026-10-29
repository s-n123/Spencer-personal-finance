# Anthropic Messages API for the iMessage nutrition coach

Retrieved: 2026-10-29

**TL;DR.** `claude-sonnet-5-5` and `claude-haiku-5-5` both exist as current, dateless, pinned model IDs. Both have a 1M-token context, 128K max output, image input and adaptive thinking that is on by default. List prices per MTok are $2 / $10 for Sonnet 5.5 and $0.10 / $0.50 for Haiku 5.5 on prompts up to 100K tokens. Cache reads cost $0.10 on Sonnet 5.5 and $0.01 on Haiku 5.5. The minimum cacheable prompt is 512 tokens on both. Five facts shape our design:

1. **Sonnet 5.5 returns a 400 for forced `tool_choice` (`any` or `tool`).** Use `auto`, plus `strict: true` and prompt steering. Haiku 5.5 does accept forced tool choice.
2. **Sampling parameters are gone.** SDK 1.x sends API version `2026-10-21`, which rejects `temperature`, `top_p` and `top_k` on every model.
3. **Thinking blocks are tied to the prefix.** On accounts created after 2026-08-31, replaying a thinking block after any edit to `system`, `tools` or earlier messages returns a 400. To avoid this, each inbound iMessage turn should start a fresh, append-only `messages` array and never replay earlier turns' thinking blocks.
4. **Images are billed at the high-resolution tier.** Both models allow up to 2,576 px on the long edge and 4,784 visual tokens, at `ceil(w/28)×ceil(h/28)` tokens per image. Only JPEG, PNG, GIF and WebP are accepted, so iPhone HEIC photos must be converted first.
5. **A refusal is an HTTP 200.** It comes back as `stop_reason: "refusal"` with a `stop_details.category`. Haiku 5.5 has no server-side fallback, and Sonnet 5.5's fallback covers only the `cyber` and `frontier_llm` categories.

For the SDK, use `@anthropic-ai/sdk@1.3.0` with `client.messages.create` in a hand-written loop. It retries 408, 409, 429 and 5xx (including 529) twice by default, with exponential backoff from 0.5 s to 8 s, and honors `retry-after`. Its only non-beta Zod helper is `zodOutputFormat`, which is for structured outputs; `betaZodTool` belongs to the beta tool runner.

Tag legend: **[primary]** = read from a platform.claude.com page myself. **[sdk-source]** = read from the `@anthropic-ai/sdk@1.3.0` tarball (`src/`), pulled with `npm pack` on 2026-10-29. **[search]** = not verified on a primary page; re-verify before coding.

---

## 0. Conflicts and staleness found during research

| Topic | Source A | Source B | Resolution |
|---|---|---|---|
| Sonnet 5.5 cache-read price | Bundled `claude-api` skill (cached 2026-10-06): $0.20/MTok | Pricing page, Sonnet 5.5 model page and What's-new page: **$0.10/MTok**, a 0.05× multiplier [primary] | Use **$0.10**. The skill is stale. |
| Cache diagnostics | Skill: beta, needs `cache-diagnosis-2026-04-07` | Docs: **GA**, and "the beta header is no longer required" [primary]. SDK 1.3.0 has `diagnostics?: DiagnosticsParam` on non-beta `MessageCreateParamsBase` [sdk-source] | GA. Use the non-beta client. |
| TS non-streaming timeout | TS SDK docs page: the default timeout scales up to 60 min with `max_tokens` | SDK 1.3.0 `calculateNonstreamingTimeout()` **throws** `AnthropicError("Streaming is required…")` when `60min × max_tokens / 128000 > 10min`, i.e. `max_tokens > 21,333`. It skips the check if a `timeout` is set on the client or request, or if streaming [sdk-source]. The Thinking page agrees: "The SDK requires streaming when `max_tokens` is greater than 21,333" [primary] | Trust the source. Keep non-streaming `max_tokens ≤ 21,333`, or set an explicit `timeout`. |
| Caches are model-scoped | Bundled skill: "caches are model-scoped" | Not stated explicitly on the primary prompt-caching page I read | Treat Haiku and Sonnet caches as separate [search]. In practice they are separate anyway, because the prompts differ. |

---

## 1. Models

### 1.1 IDs, limits, prices

| | `claude-sonnet-5-5` (MODEL_MAIN) | `claude-haiku-5-5` (MODEL_FAST) | Source |
|---|---|---|---|
| Exists / status | Active (latest). Released 2026-09-28 | Active (latest). Released 2026-10-07 | [primary] model pages |
| ID form | Dateless pinned snapshot. The alias equals the ID. Never append a date | Same: "a fixed model ID with no date suffix and no separate alias" | [primary] overview, Haiku migration guide |
| Retirement | Not sooner than 2027-09-28 | Not sooner than 2027-10-07 | [primary] overview |
| Context window | 1M tokens | 1M tokens | [primary] |
| Max output (sync) | 128K tokens (300K on Batches with `output-300k-2026-03-24`) | 128K (300K on Batches with the same beta) | [primary] |
| Input → output | Text and images → text (vision supported) | Text and images → text (vision supported) | [primary] |
| Base input | $2 / MTok | $0.10 / MTok for prompts ≤100K tokens; **$0.50** for prompts >100K | [primary] pricing |
| Output | $10 / MTok | $0.50 (≤100K); $2.50 (>100K) | [primary] |
| 5-min cache write (1.25×) | $2.50 / MTok | $0.125 (≤100K); $0.625 (>100K) | [primary] |
| 1-hour cache write (2×) | $4 / MTok | $0.20 (≤100K); $1 (>100K) | [primary] |
| Cache read / refresh | **$0.10 / MTok (0.05×)** | $0.01 (≤100K); $0.05 (>100K), at the standard 0.1× | [primary] |
| Batch API | 50% off ($1 / $5) | 50% off ($0.05 / $0.25 for ≤100K) | [primary] |
| Long-context pricing | Flat across the 1M window | Priced per request by **total prompt length, including cache reads and writes**. Over 100K, the whole request pays the higher rate | [primary] pricing, "Long context pricing" |
| Tokenizer | Same as Sonnet 5 (the newer tokenizer introduced with Opus 4.7, about 30% more tokens than pre-4.7 models) | Same newer tokenizer, about 30% more tokens than Haiku 4.5 | [primary] |
| Min cacheable prompt | **512 tokens** | **512 tokens** | [primary] prompt-caching "Cache limitations" |
| Tool-use system prompt overhead | 286 tokens (`auto`/`none`). `any`/`tool` are not supported | 286 (`auto`/`none`); 406 (`any`/`tool`) | [primary] pricing, "Tool use pricing" |
| `inference_geo: "us"` | 1.1× on all token categories | 1.1× | [primary] pricing |
| Priority Tier | Not supported (per the bundled skill) [search] | Not supported | Haiku: [primary] migration guide |

No deprecations affect these two models. The pricing page notes that Sonnet 5's $2 / $10 introductory price became its standard price, and the scheduled increase to $3 / $15 will not happen; that note is about Sonnet 5, not Sonnet 5.5 [primary].

### 1.2 Model-specific parameters that matter in a tool loop

| Parameter | Sonnet 5.5 | Haiku 5.5 | Source |
|---|---|---|---|
| `thinking` omitted | Adaptive thinking (on) | Adaptive thinking (on) | [primary] thinking, "Configuring thinking" |
| `{type:"adaptive"}` | OK. `display`: `"summarized"` or `"omitted"`; the default is `"omitted"`, which returns an empty `thinking` string and a `signature` | OK, default `"omitted"` | [primary] |
| `{type:"enabled", budget_tokens}` | **400** | **400** | [primary] |
| `{type:"disabled"}` | **400** (the error message points to `between_tools`) | OK at `low`, `medium` or `high` effort. **400** at `xhigh` or `max` | [primary] |
| `{type:"between_tools"}` | OK at effort ≤ `high`. Turns off up-front thinking; progress notes still come back as `thinking` blocks. Takes **no other field** (`display`, `budget_tokens` or `block_binding` with it is a 400). Per-message effort changes are a 400 | **400** | [primary] What's-new Sonnet 5.5, thinking table |
| `output_config.effort` | `low`, `medium`, `high`, `xhigh`, `max`. **Default `high`.** Levels are recalibrated versus Sonnet 5. Docs: "For agentic coding and multistep tool use, start at `medium`… For chat and other latency-sensitive work, start at `medium` or `low`" | Same five levels. **Default `medium`.** "Use `low`… for chat, short tool tasks, and simple, high-volume requests" | [primary] effort page |
| `temperature` / `top_p` / `top_k` | 400 for non-default values. **Under API version `2026-10-21` (sent by SDK 1.x), any value is a 400 on every model** | Same | [primary] thinking, "Sampling parameters"; versioning |
| Assistant prefill (last message `assistant`) | 400 | 400, even with thinking off | [primary] |
| `tool_choice` `any` / `tool` | **400**: `tool_choice: type "tool" and "any" are not supported for this model.` The same applies to `count_tokens` and Batches. `auto` (the default) and `none` are fine. `disable_parallel_tool_use` still works with `auto` (at most one call) | **Accepted**, but the forced response "starts with the tool call and has no `thinking` block" | [primary] Sonnet What's-new; Haiku migration guide; define-tools |
| Text between tool calls | Notes longer than a sentence or two come back as **progress-update `thinking` blocks** (empty under the default `display`). Shorter remarks stay `text` | Not called out | [primary] |
| Thinking counts toward `max_tokens` | Yes. A small `max_tokens` can end with `stop_reason:"max_tokens"` after only a `thinking` block | Yes (same warning) | [primary] Haiku migration guide; Sonnet prompting guide |
| Prior-turn thinking kept in context | Keep-all (Sonnet 4.6+) | Keep-all (new for Haiku 5.5) | [primary] thinking, "Thinking block preservation by model" |
| Preserved-thinking prefix check | Yes (see §6) | Yes | [primary] |
| Thinking blocks bound to the producing account | Yes | Yes | [primary] |
| Mid-conversation `role:"system"` messages | Supported (GA, no header) | Supported | [primary] mid-conversation system messages; skill |
| Refusal categories | `cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms` | `cyber`, `frontier_llm`, `bio`, `general_harms` (Haiku prompting guide); the SDK enum includes all five | [primary]; [sdk-source] `RefusalStopDetails` |
| Server-side fallback | Beta (`fallbacks: "default"` with header `server-side-fallback-2026-07-01`). Retries **only `cyber` and `frontier_llm`**, on Sonnet 5 | **None.** `"default"` leaves a refusal standing; an explicit list returns a 400. Refusals carry no fallback credit | [primary] |
| `max_tokens: 0` pre-warm | Allowed, except with `stream:true`, `thinking.type:"enabled"`, `output_config.format`, forced `tool_choice`, or inside Batches | Same | [primary] prompt-caching "Pre-warming" |

---

## 2. API version and wire basics (SDK 1.3.0)

- The SDK sends **`anthropic-version: 2026-10-21`**, hard-coded in `src/client.ts` [sdk-source]. Version history for `2026-10-21` [primary, versioning]:
  - Messages: `temperature`, `top_p` and `top_k` are removed (400 on every model).
  - A `document` block inside an `assistant` message is a 400.
  - A user `text` block with non-empty `citations` is a 400.
- The SDK sends the API key as **`Authorization: Bearer <key>`** instead of `X-Api-Key`; the API accepts either [primary, migration-2026-10-21]. Relevant if we ever stub, proxy or log headers.
- A client holds **one credential**. With no credential passed, the SDK resolves `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → a profile → Workload Identity Federation [primary, migration-2026-10-21]. For Vercel, set only `ANTHROPIC_API_KEY`.
- `MessageParam` is now the union `UserMessageParam | AssistantMessageParam | SystemMessageParam`. A literal with an explicit `role` still type-checks. You can't `interface X extends Anthropic.MessageParam`; use a type alias [primary].
- Endpoints we use:
  - `POST /v1/messages`
  - `POST /v1/messages/count_tokens`: free, with its own requests-per-minute limit. It returns an estimate and doesn't apply caching [primary].
  - `GET /v1/models/{id}` for capability discovery: returns `max_input_tokens`, `max_tokens`, and `capabilities` including `thinking.types.disabled/between_tools` [primary, models overview].
- Request size limits: Messages and count_tokens 128 MB; Batches 256 MB; Files 500 MB. Over the limit you get a **413 `request_too_large`**, returned by Cloudflare [primary, errors].
- Response headers: `request-id` (the SDK exposes it as `message._request_id` and `APIError.requestID`), `anthropic-organization-id`, `anthropic-workspace-id`, plus the rate-limit headers in §8 [primary; sdk-source].
- **Data retention:** "Conversation content (your prompts and Claude's outputs) is not retained by default; the exception is Covered Models". The Covered Models are Fable and Mythos only, not Sonnet 5.5 or Haiku 5.5. Even so, flagged content and legal holds can be retained for **up to 2 years**. ZDR is per organization through sales [primary, api-and-data-retention].

---

## 3. Vision

### 3.1 Inputs

- Images go in an `image` content block, with `source` set to one of [primary, vision; sdk-source `ImageBlockParam`]:
  - `{type:"base64", media_type, data}`
  - `{type:"url", url}`
  - `{type:"file", file_id}` (Files API)
- Optional block fields: `cache_control`, and `transformations: {oversized_image: "downsize" | "error"}`.
- **Formats:** `image/jpeg`, `image/png`, `image/gif`, `image/webp`. Only the first frame of an animation is used [primary]. **HEIC/HEIF is not supported.** iPhone photos often arrive as HEIC, so convert them to JPEG or WebP server-side. Whether Sendblue already converts them is open; see the Sendblue research.
- **Limits** [primary]:
  - Per image: 10 MB base64-encoded on the Claude API. Maximum dimensions 8000×8000 px.
  - Images per request: up to 600 (100 for 200K-context models).
  - If a request has **more than 20 image blocks** (including resent images and images inside `tool_result`), a stricter per-image limit applies. To stay safe, keep both sides ≤2000 px or send ≤20 images.
- **URL sources:** Anthropic fetches the URL. A rotating signed URL is fine for preserved thinking as long as it returns the same bytes [primary, preserved-thinking table]. A URL whose bytes change between requests breaks thinking and the cache.
- **Files API:** GA, no beta header, `client.files.*`.
  - Files persist until deleted or until `expires_in_seconds` (3,600 to 7,776,000) passes. Files API is **not ZDR-eligible**.
  - Limits: 500 MB per file, 1 TB per organization, about 500 file requests per minute [primary, files].
  - Recommendation: don't use it. It stores health photos at a third party, and we don't need it because images appear only in the current turn.
- **Image metadata (EXIF) is not read by Claude** [primary FAQ]. Correct orientation ourselves (`sharp().rotate()`) before resizing; the docs list "rotated" images among accuracy risks.

### 3.2 Token cost and resizing

- Cost per image = `⌈width/28⌉ × ⌈height/28⌉` visual tokens; one token is a 28×28 patch [primary].
- **Tiers** [primary]:
  - **High-resolution tier**: "Claude 4.7 and later models", which includes both Sonnet 5.5 and Haiku 5.5. Long edge ≤ **2,576 px**, ≤ **4,784** visual tokens. Automatic, no opt-in.
  - Standard tier: older models. 1,568 px and 1,568 tokens.
  - The Haiku 5.5 migration guide confirms Haiku 5.5 uses the high-res tier.
- **Server-side resize rule:** the largest aspect-preserving size where `ceil(w/28)*28 ≤ maxEdge`, `ceil(h/28)*28 ≤ maxEdge` and `tokens ≤ maxTokens`. The image is then padded to a multiple of 28 on the bottom and right [primary, vision-coordinates].
  - For photos, the **token limit** usually binds before the edge limit.
  - The docs include a reference `resizedSize(width, height, maxEdge, maxTokens)` in TypeScript. It does a binary search on the long edge and uses round-half-to-even, not `Math.round`. Port it verbatim.
- Example costs from the docs table [primary]:
  - 1000×1000: 1,296 tokens
  - 1920×1080: 2,691 tokens (high-res, not resized)
  - 2000×1500: 3,888 tokens
  - 3840×2160: downsized to 2576×1449, 4,784 tokens
  - The 4,784-token cap means a full-resolution image costs about $0.0096 on Sonnet 5.5 and about $0.0005 on Haiku 5.5 (my arithmetic).
- **Guidance** [primary]:
  - "If you don't need the additional fidelity… downsample images before sending to control token costs."
  - "prefer resizing images before uploading them" (latency).
  - Heavy or repeated JPEG compression hurts legibility of text.
  - Keep important text legible; don't crop away context.
- **Optional strict mode:** `transformations: {oversized_image: "error"}` returns a 400 instead of silently downscaling, and the error names the target size [primary]. Useful as a guard that our resize code matches the model's tier.

### 3.3 Prompting with images

- Put **images before text**. Interleaved images still work, but image-then-text is preferred [primary].
- For several images, label each one with a preceding text block (`Image 1:`, `Image 2:`) [primary].
- Image limitations [primary]:
  - Claude can't identify people.
  - Approximate counting.
  - Possible mistakes on low-quality, rotated or <200 px images.
  - Not for diagnostic medical scans.
- Sonnet 5.5 prompting guide: for dense charts and technical drawings, "give Claude Sonnet 5.5 a way to crop, zoom, or run code on the image… adding tools helps more than raising effort" [primary]. This may apply to small-print supplement facts panels; see the crop-tool recipe it links. It is optional, and an eval decision.
- Changing whether images are present in the prompt invalidates the **messages** cache (tools and system caches stay valid) [primary].

---

## 4. Tool use (manual loop)

### 4.1 Request

- `tools: Tool[]`. Each custom tool has [primary, define-tools; sdk-source `Tool`]:
  - `name`, matching `^[a-zA-Z0-9_-]{1,128}$`
  - `description`
  - `input_schema`: a JSON Schema object (`type:"object"`, `properties`, `required`)
  - Optional: `strict`, `cache_control`, `input_examples` (each must validate against the schema or the request is a 400; costs about 20–200 tokens each), `defer_loading`, `allowed_callers`, `eager_input_streaming`, `type:"custom"`
- The API builds a tool-use system prompt that contains the tool definitions, then the user's system prompt, then the tool configuration [primary].
- `tool_choice` [primary; sdk-source]:
  - `{type:"auto", disable_parallel_tool_use?}`: the default when tools are present
  - `{type:"any", …}`
  - `{type:"tool", name, …}`
  - `{type:"none"}`: the default when no tools are present
  - `any` and `tool` prefill the assistant turn, so there is no text or thinking before the call. **Not allowed on Sonnet 5.5.**
- Steer tool use from the system prompt instead [primary]:
  - Lighter: "Use the tools to investigate before responding."
  - Stronger: "Always call a tool first before responding."
  - More conservative: "Use your judgment about whether to call a tool or respond directly."

### 4.2 Response and continuation

- `stop_reason: "tool_use"`, with one or more `tool_use` blocks `{type:"tool_use", id, name, input, caller, toolset_name?}` [sdk-source].
  - `input` is `unknown`; parse and validate it with Zod.
  - Never string-match the serialized JSON; escaping can differ (skill guidance).
- **Continuation rules** [primary, handle-tool-calls]:
  - Append the assistant message **exactly as returned** (`content: response.content`, including `thinking` blocks).
  - Then append **one** user message with one `tool_result` per `tool_use`: `{type:"tool_result", tool_use_id, content?: string | (text|image|document|search_result)[], is_error?}`.
  - The `tool_result` blocks must come **first** in that user message. Text is allowed only after them.
  - Nothing may sit between the `tool_use` message and the `tool_result` message.
  - Error if violated: "tool_use ids were found without tool_result blocks immediately after".
- **`is_error: true`** for execution failures. Write instructive errors ("what went wrong + what to try next"). Claude retries 2–3 times on invalid calls before apologizing [primary].
  - If you skip a call in a batch, still return a result for it: `is_error: true` with "Not executed: …" [primary, parallel tool use].
- **Parallel tool use** is on by default [primary]:
  - Run calls in any order you choose; execution order is up to us.
  - Return **all** results in a **single** user message. Splitting them across messages "teaches" Claude to stop calling in parallel.
  - Turn it off with `tool_choice.disable_parallel_tool_use: true`, which is not a top-level parameter.
- **Tolerant handling** (Sonnet 5.5) [primary, prompting-claude-sonnet-5-5]: the model may call a tool with wrong letter case or a near-miss parameter name. Accept unambiguous matches, or return `is_error` naming the exact expected name.
- **Never put user text inside a `tool_result`**; the model may treat it as a prompt injection. Deliver mid-turn user input as a text block after the last `tool_result` in the same user message [primary, Sonnet and Haiku prompting guides]. Relevant if a debounced burst arrives while a loop is running; our design never runs two turns at once, so it shouldn't happen.
- **Empty `end_turn`:** a 2–3 token empty reply usually means we appended text right after tool results, or resent a completed response. Don't retry unchanged; fix the message structure, or as a last resort add a continuation user message [primary, handling-stop-reasons].

### 4.3 `stop_reason` values [primary; sdk-source `StopReason`]

| Value | Meaning / handling |
|---|---|
| `end_turn` | Done. Read the `text` blocks by `type`; the response may start with `thinking` blocks |
| `tool_use` | Run the tools and continue |
| `max_tokens` | Truncated. A truncated `tool_use` may still parse as a valid **partial** object. Never run tools from a `max_tokens` response; retry with a higher `max_tokens`. With thinking on, a response can stop after thinking with no text |
| `stop_sequence` | Not used by us |
| `pause_turn` | Only when **server tools** hit their server-side loop limit (default 10 iterations). We use no server tools, but handle it defensively: append the content and resend |
| `refusal` | HTTP 200. `stop_details = {type:"refusal", category, explanation}`; `category` can be `null`. `content` may be empty or partial: discard partial output. Branch on `stop_reason`, not on `content` |
| `model_context_window_exceeded` | Output filled the context window; treat as truncated. Typed in TS 1.3.0's non-beta `StopReason` |

`stop_details` is `null` for every non-refusal stop [primary; sdk-source `Message.stop_details: RefusalStopDetails | null`].

### 4.4 Strict tools and structured outputs (both models)

- `strict: true` sits at the top level of the tool definition. It guarantees `tool_use.input` matches `input_schema` and that `name` is valid, via grammar-constrained sampling. GA, available on all models [primary].
- `output_config: {format: {type:"json_schema", schema}}` gives JSON final answers. It is GA, available on all models, and works together with strict tools. The old `output_format` is deprecated: using it needs the `structured-outputs-2025-11-13` beta header, or you get a 400 [primary].
- **Schema limits** [primary]:
  - All objects need `additionalProperties: false`.
  - **Not supported:** recursive schemas; `minimum`, `maximum`, `multipleOf`; `minLength`, `maxLength`; array constraints other than `minItems` 0 or 1; external `$ref`; complex enum types.
  - Supported string formats: date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid.
  - Regex: simple patterns only (no backreferences, lookarounds or `\b`).
- **Complexity limits per request, summed across all strict schemas** [primary]:
  - ≤ **20** strict tools.
  - ≤ **24** optional parameters in total.
  - ≤ **16** union-typed parameters (`anyOf` or `["string","null"]`).
  - Over the internal limits you get the 400 "Schema is too complex for compilation", and there is a 180 s compile timeout.
  - The first use of a schema adds compile latency; the grammar is cached for 24 h.
- **Property order:** required properties come first, then optional ones [primary].
- **Enum casing isn't guaranteed.** Claude may return `"Conversation Topic 3"` for a `"Conversation topic 3"` enum value, so compare case-insensitively [primary].
- **Don't put PHI in schemas** (property names, `enum`, `const`, `pattern`). Compiled schemas are cached separately for up to 24 h without PHI protections [primary, strict-tool-use "Data retention"].
- **Don't ask for a `reasoning` or `thinking` field** in tool inputs or JSON output; it risks `reasoning_extraction` refusals. Ask for a short `explanation` or `evidence` instead [primary].
- Changing `output_config.format` invalidates the prompt cache for that thread [primary].

### 4.5 Tool description best practice [primary, define-tools]

- "Provide extremely detailed descriptions… by far the most important factor". Cover what the tool does, when to use it and when not to, what each parameter means, and caveats; aim for at least 3–4 sentences.
- Consolidate related operations, for example with an `action` parameter. Use meaningful namespacing.
- Return only high-signal data with stable identifiers.
- Use `input_examples` for complex or nested inputs.

### 4.6 Thinking inside the loop [primary, thinking]

- A tool-use loop is **one assistant turn**. You **must** pass thinking blocks back unchanged with tool results.
- Don't toggle the thinking configuration mid-turn; the API silently disables thinking for that request.
- Thinking blocks can't be rearranged, edited or partially dropped within the latest assistant message (400 "thinking blocks cannot be modified").

---

## 5. Prompt caching

- **Prefix order:** `tools` → `system` → `messages`. A cache entry covers everything up to and including the block that carries `cache_control` [primary].
- Only `{type:"ephemeral"}` exists, with `ttl: "5m" | "1h"`; the default is 5 minutes [primary; sdk-source `CacheControlEphemeral`].
- The TTL is measured from the **start** of the request that writes or reads the entry, and each hit refreshes it at no cost [primary].
- **Two ways to enable it** [primary]:
  - **Automatic:** a top-level `cache_control` on `messages.create`, which puts the breakpoint on the last cacheable block. In multi-turn use the breakpoint moves forward automatically. It uses one of the 4 slots. If the last block already has an explicit `cache_control` with a **different** TTL → 400. If 4 explicit breakpoints already exist → 400.
  - **Explicit:** `cache_control` on individual blocks:
    - tools: on the **last** tool
    - system: requires the **array** form `system: [{type:"text", text, cache_control}]`
    - messages: on text, image, tool_use or tool_result blocks
- **At most 4 breakpoints** per request [primary].
- **Mixing TTLs:** 1-hour entries must come before 5-minute entries. Billing positions: A = highest hit, B = last 1 h breakpoint after A, C = last breakpoint [primary].
- **Mechanics** [primary]:
  - Writes happen **only at breakpoints**.
  - Reads look back up to **20 blocks** per breakpoint for earlier writes. A run of consecutive `tool_use` or `tool_result` blocks counts as one position.
  - Put the breakpoint on the **last stable block**, never on a block that changes every request (a timestamp, the incoming message).
- **Minimum cacheable length:** 512 tokens for Sonnet 5.5 and Haiku 5.5. Shorter prompts are silently not cached: both cache usage fields read 0 and no error is returned [primary].
- **Pricing multipliers** [primary]:
  - 5-minute write: 1.25× base.
  - 1-hour write: 2× base.
  - Read: **0.05× on Sonnet 5.5**, 0.1× on Haiku 5.5.
  - These stack with Batch, data-residency and long-context modifiers. Breakpoints themselves are free.
- **Verifying hits** [primary; sdk-source `Usage`]:
  - `usage.cache_read_input_tokens`
  - `usage.cache_creation_input_tokens`
  - `usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`
  - `usage.input_tokens`, which counts only tokens **after the last breakpoint**
  - Total input = read + creation + input_tokens.
  - Also available: `usage.output_tokens_details.thinking_tokens`.
- **Cache diagnostics** (GA) [primary; sdk-source]:
  - Send `diagnostics: {previous_message_id: null}` on the first request and the previous `msg_…` id after that.
  - The response then carries `diagnostics.cache_miss_reason`. Only hashes and token estimates are stored.
- **Invalidators** [primary]:

  | Change | Tools cache | System cache | Messages cache |
  |---|---|---|---|
  | Tool definitions (name, description, schema, order) | ✘ | ✘ | ✘ |
  | `tool_choice` or `disable_parallel_tool_use` | ✓ | ✓ | ✘ |
  | Images added or removed anywhere | ✓ | ✓ | ✘ |
  | Thinking config or `output_config.effort` (setting the default explicitly is the same as omitting it) | model-specific | model-specific | ✘ |
  | Web search or citations toggle | ✓ | ✘ | ✘ |
  | `output_config.format` change | — | — | ✘ (thread cache) |
  | Dropped thinking blocks (§6) | ✓ | ✓ | ✘ from that point on |

  The docs don't say per model whether thinking and effort render ahead of tools and system, so keep thinking and effort **constant per route** [primary].
- **Isolation** [primary]:
  - Caches are isolated by **workspace** on the Claude API and never shared across organizations.
  - A hit requires byte-identical prefixes. So a shared `tools`+`system` prefix is reused **across all our users** in the workspace.
  - A cache entry becomes readable only **after the first response starts**, so parallel cold requests each pay for a write.
- **1 h vs 5 min** [primary]: use 1 h when the prefix is reused less often than every 5 minutes but more often than every hour. 1 h pays for itself after 2 reads; 5 min after 1.
- **Pre-warming** [primary]: `max_tokens: 0` with an explicit breakpoint on the shared prefix, and the **same** thinking and effort as real traffic. It returns empty `content` with `stop_reason:"max_tokens"`; zero output is billed.
- **Thinking and caching** [primary]: within a tool loop, earlier thinking blocks are cached along with the tool results and count as input when read. On keep-all models (both of ours), earlier turns' thinking stays in the cache and in context.
- **Rate limits** [primary]: cache-read tokens do **not** count toward ITPM. `input_tokens` and `cache_creation_input_tokens` do.

---

## 6. Preserved thinking: the append-only rule (critical for design)

- From Fable 5.1 on, including **Sonnet 5.5 and Haiku 5.5**, the API checks every `thinking` and `redacted_thinking` block sent back [primary, preserved-thinking]:
  - **Model check:** a model reads only its own blocks and certain other models' blocks; unreadable blocks are dropped silently and unbilled. Haiku 5.5 does **not** read Sonnet 5.5 blocks. Sonnet 5.5 reads Haiku 5.5 blocks on the Claude API.
  - **Prefix check:** a block stays valid only while the top-level `system`, the `tools` set, and every message before it are byte-identical.
  - **Account binding:** Sonnet 5.5 and Haiku 5.5 blocks work only in the producing account or linked accounts.
- **Enforcement:** accounts created on or after **2026-08-31 00:00 UTC** get a **400 by default** on a prefix mismatch. Older accounts are checked only if `thinking.block_binding.prefix_mismatch_behavior` is set (needs beta header `thinking-binding-controls-2026-08-01`; values `"error"` or `"drop_block"`). `block_binding` works only with `thinking:{type:"adaptive"}` [primary].
- **Edits that invalidate later thinking** [primary]:
  - Changing the `system` string or blocks.
  - Adding, removing or editing any entry in `tools`.
  - Editing, reordering or deleting earlier messages.
  - Re-rendering context in the first user message.
  - Clearing or shortening old `tool_result`s, or re-encoding old images.
  - Adding text to an earlier user turn.
  - Removing a thinking block from the **middle** of the history.
- **Changes that stay valid** [primary]:
  - Appending messages.
  - Removing thinking blocks from the start, from the end, or **all** of them.
  - Changing request parameters outside `model`, `system`, `tools` and `messages` (`effort`, `max_tokens`, `tool_choice`, `metadata`, `thinking.display`).
  - Moving `cache_control` markers.
- "If you never send thinking blocks back, the prefix check has nothing to reject" [primary].
- **Our pattern:**
  - Build each inbound turn as a brand-new request: fixed `tools` and `system`, then a fresh first user message rendered from the database.
  - Do **not** replay earlier turns' assistant content or thinking. Store only final reply text and render history as plain text.
  - Within the turn's tool loop, append only.
- **If we ever keep long-lived conversations:**
  - Use mid-conversation `role:"system"` messages for new instructions.
  - Put changed context in the newest turn.
  - Keep `tools` frozen, or use `tool_addition` and `tool_removal` (beta `inline-tools-2026-09-15`).

---

## 7. TypeScript SDK `@anthropic-ai/sdk@1.3.0`

- **Version:** 1.3.0 is `latest`, published 2026-10-23. 1.0.0 (2026-10-21) moved to API version `2026-10-21` [sdk-source CHANGELOG; `npm view`].
- **Runtime support:** Node.js 20 LTS or later; Vercel Edge Runtime and Cloudflare Workers are also supported. TypeScript ≥ 5.0 [sdk-source README; primary TS SDK page].
- **Dependencies:** `@opentelemetry/api`, `standardwebhooks`, `json-schema-to-ts`. Optional peer dependency `zod ^3.25.0 || ^4.0.0` [sdk-source package.json].
- **Construction** [sdk-source `client.ts`]: `new Anthropic({ apiKey?, baseURL?, timeout?, maxRetries?, defaultHeaders?, fetch?, fetchOptions?, middleware?, logLevel?, logger?, openTelemetry?, dangerouslyAllowBrowser? })`.
  - `apiKey` defaults to `ANTHROPIC_API_KEY`.
  - `baseURL` defaults to `ANTHROPIC_BASE_URL`.
  - `logLevel` defaults to `ANTHROPIC_LOG` or `'warn'`.
  - Per-request overrides: `client.messages.create(body, { timeout, maxRetries, signal, headers })`, and `client.withOptions({...})`.
- **Timeouts** [sdk-source]:
  - `DEFAULT_TIMEOUT = 600000` ms (10 min), in **milliseconds**.
  - Non-streaming without an explicit timeout throws if `max_tokens > 21,333` (see §0).
  - A timeout raises `APIConnectionTimeoutError` and **is retried**, so worst-case wall time is about `timeout × (maxRetries+1)` plus backoff.
- **Retries** [sdk-source `shouldRetry` / `retryRequest`]:
  - Default `maxRetries = 2`.
  - The server header `x-should-retry: true|false` overrides everything.
  - Otherwise it retries 408, 409, 429, **≥500 (includes 529 `overloaded_error`)**, and connection errors.
  - Wait time: `retry-after-ms`, then `retry-after` (seconds or HTTP date), if positive and ≤ 2³¹−1 ms. Otherwise `min(0.5 × 2^n, 8)` s with up to 25% jitter.
  - On a 401 from a token-cache credential it refreshes once (not relevant for API keys).
- **Errors** [sdk-source `core/error.ts`]:
  - Base classes: `AnthropicError` → `APIError` (fields `status`, `headers`, `error` (body), `requestID` (from `request-id`), `workspaceID`, `type` (`ErrorType`)).
  - Subclasses by status:
    - `BadRequestError` (400)
    - `AuthenticationError` (401)
    - `PermissionDeniedError` (403)
    - `NotFoundError` (404)
    - `ConflictError` (409)
    - `UnprocessableEntityError` (422)
    - `RateLimitError` (429)
    - `InternalServerError` (≥500, including 529)
    - `APIConnectionError` → `APIConnectionTimeoutError`
    - `APIUserAbortError`
  - `RetryableError` can be thrown from middleware to opt into a retry.
  - `ErrorType` values: `invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `rate_limit_error`, `timeout_error`, `overloaded_error`, `api_error`, `billing_error`.
  - 529 has no dedicated class: detect it with `err instanceof Anthropic.InternalServerError && err.status === 529`, or `err.type === 'overloaded_error'`.
  - 402 (`billing_error`) and 413 fall through to the generic `APIError`.
- **Types** [sdk-source `resources/messages/messages.ts`]:
  - `Anthropic.Tool` (custom tool; `input_schema: {type:'object', properties?, required?, [k]: unknown}`)
  - `Anthropic.ToolUnion` (the `tools` param type)
  - `ToolChoice`, `MessageParam`, `ContentBlockParam`, `ImageBlockParam`, `ToolUseBlock`, `ToolResultBlockParam`, `ThinkingConfigParam` (`Enabled | Disabled | BetweenTools | Adaptive`), `OutputConfig` (`effort`, `format`), `Message`, `Usage`, `StopReason`, `RefusalStopDetails`
  - `Model`: a string union that includes `'claude-sonnet-5-5'` and `'claude-haiku-5-5'`, plus `(string & {})`, so env-var strings type-check.
  - `MessageCreateParamsBase` also has: `cache_control` (automatic caching), `diagnostics`, `inference_geo`, `metadata` (`user_id`), `service_tier` (`'auto' | 'standard_only'`), `speed`, `stop_sequences`, `user_profile_id`, `workspace_id`.
- **Methods (non-beta)** [sdk-source]:
  - `messages.create`
  - `messages.parse`: typed `parsed_output` when used with `zodOutputFormat`
  - `messages.stream`: has `.finalMessage()`
  - `messages.countTokens`
  - `messages.batches.*`
  - `models.*`
  - `files.*`
  - **`toolRunner` exists only on `client.beta.messages`**, and it is beta.
- **Zod helpers** [sdk-source `helpers/`]:
  - Non-beta: `zodOutputFormat(schema)` from `@anthropic-ai/sdk/helpers/zod`, and `jsonSchemaOutputFormat` from `@anthropic-ai/sdk/helpers/json-schema`. Both are **structured outputs only**.
    - They import `zod/v4` and run `z.toJSONSchema(schema, {reused:'ref'})`, then an internal `transformJSONSchema`.
    - That transform forces `additionalProperties:false`, keeps only supported string formats and `minItems` 0 or 1, and **moves unsupported constraints into the `description`** text.
    - Parse failures throw `AnthropicError`.
  - Beta (tool runner): `betaZodTool({name, description, inputSchema, run, ...extraFields})` from `@anthropic-ai/sdk/helpers/beta/zod`, `betaTool` (JSON Schema), `betaStandardSchemaTool`, `betaZodOutputFormat`.
    - `betaZodTool` uses `z.toJSONSchema` **without** the strict transform.
    - It accepts `strict` and `cache_control`, and validates input with `inputSchema.parse`.
  - **There is no non-beta `zodTool`.** For our manual loop, generate `input_schema` ourselves with Zod v4's `z.toJSONSchema()` (ensuring `additionalProperties:false` for strict tools) and validate `tool_use.input` with `safeParse`. `lib/transform-json-schema` is importable through the `./lib/*` export but is internal, so don't depend on it.
- **Refusal middleware** [sdk-source `index.ts` exports; primary refusals page]: `betaRefusalFallbackMiddleware([{model}])` plus `BetaFallbackState`. It works only through `client.beta.messages`. Don't combine it with server-side `fallbacks`.
- **OpenTelemetry** [sdk-source README, `internal/tracing.ts`]:
  - Spans are on automatically if the app registers a tracer provider, which happens on Vercel if `@vercel/otel` is installed.
  - The default `traces.contentMode` is **`'metadata_only'`**. `'content'` would put prompts and outputs in spans; **never enable it** (spec: keep message bodies and photos out of logs).
  - `propagation` (on by default) sends `traceparent`. Disable spans with `openTelemetry: false` or `ANTHROPIC_OPEN_TELEMETRY=false`.

---

## 8. Rate limits, headers, 429/529

- **Algorithm:** token bucket, per organization, per model class. Limits are RPM, ITPM and OTPM. New organizations may begin in an **Evaluation tier** below Start. Bursts can trip limits; for example 60 RPM may be enforced as 1 request per second [primary, rate-limits].

| Tier | Sonnet 5.5 (separate bucket) RPM / ITPM / OTPM | Haiku 5.5 RPM / ITPM / OTPM | Monthly spend cap |
|---|---|---|---|
| Start | 1,000 / 2,000,000 / 400,000 | 1,000 / 2,000,000 / 400,000 | $500 |
| Build | 5,000 / 5M / 1M | 5,000 / 5M / 1M | $1,000 |
| Scale | 10,000 / 10M / 2M | 10,000 / 10M / 2M | $200,000 |

[primary]. `max_tokens` doesn't count toward OTPM. Cache reads don't count toward ITPM.

- **Response headers** [primary]:
  - `retry-after` (seconds)
  - `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`: `reset` is RFC 3339, and the token values are rounded to the nearest thousand
  - `anthropic-priority-*` (Priority Tier only)
  - `anthropic-ratelimit-tokens-*` reflects the most restrictive limit in effect.
- **429 variants** [primary]:
  - Normal rate limit: has `retry-after`.
  - **Acceleration limit:** sharp usage increases → ramp traffic gradually.
  - **Spend-cap 429:** `error.type:"rate_limit_error"`, `error.details.error_code:"enforced_spend_limit_reached"`, **no `retry-after`**; it keeps failing until the 1st of next month 00:00 UTC. The SDK will still retry it twice.
  - A user-set spend limit returns **400** `invalid_request_error` ("You have reached your specified API usage limits").
- **529 `overloaded_error`:** temporary API-wide load. 500 means retry with backoff. 504 `timeout_error` means use streaming for long requests [primary, errors].
- **Recommended handling for our webhook worker** (my synthesis from the above):
  - Keep the SDK's retries (`maxRetries` 2–3). Set an explicit client `timeout` (about 60–90 s) that fits inside the Vercel function's maximum duration.
  - Catch `RateLimitError` and check `err.error?.error?.details?.error_code === 'enforced_spend_limit_reached'`: alert, don't retry, and send the user a graceful "temporarily unavailable" text.
  - For 529 or 5xx after SDK retries: requeue the turn with a delay, and tell the user once.
  - Log `requestID`, `usage` and `stop_reason`, but **never** message content.

---

## 9. Safety-relevant API behavior

- **Refusals** [primary, refusals-and-fallback]:
  - HTTP 200, `stop_reason:"refusal"`, `stop_details.category` ∈ {`cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms`, `null`}.
  - `explanation` text is unstable: display it, don't parse it.
  - **Billing:** a refusal before any output is billed only for `bio`, `frontier_llm` and `reasoning_extraction` (as of September 2026). A mid-stream refusal bills its input plus the output streamed so far.
  - **All refusals count against rate limits.**
  - Instrument refusals as their own metric; 5xx-based monitoring won't see them.
- **Most likely refusal for us:** `general_harms`, for example around eating-disorder or self-harm content, or dosing questions. That is my assessment, not documented. Neither model's server-side fallback covers `general_harms`.
  - Handle it in code: reply with a canned, caring message. When the eating-disorder guardrail applies, include the helpline text.
  - Never echo partial output.
- **Server-side fallback (Sonnet only)** [primary]:
  - Beta, `client.beta.messages`, header `server-side-fallback-2026-07-01`, `fallbacks:"default"`.
  - It covers only `cyber` and `frontier_llm`, which are unlikely in our domain. The response would contain `fallback` blocks (beta types only) and `usage.iterations`.
  - Sticky routing lasts about 1 h per conversation prefix.
  - Default: **off** for the MVP. Re-evaluate if eval logs show those categories.
- **`reasoning_extraction`** [primary]: avoid prompts or tool fields that ask the model to write its reasoning or scratchpad in the output.
- **`metadata.user_id`:** "should be a uuid, hash value, or other opaque identifier… Do not include… phone number" [sdk-source `Metadata`]. Pass our internal user UUID or an HMAC of it, never E.164.
- **Prompt injection from images and labels:** treat OCR'd menu or label text as untrusted. Keep untrusted content in `tool_result` blocks or the user turn, never in `system` [primary, handle-tool-calls warning].
- **Retention:** prompts and outputs are not retained by default for these models, but flagged content may be retained for up to 2 years. ZDR and HIPAA BAAs are arrangements made through sales and the Console [primary].

---

## 10. Keeping costs low

- **Classifier route (MODEL_FAST = `claude-haiku-5-5`)**:
  - Use either `client.messages.parse({ output_config: { format: zodOutputFormat(Schema) } })`, or a forced `tool_choice` with one enum-only tool (Haiku 5.5 accepts forced tools).
  - Set `thinking: {type:"disabled"}` (allowed at effort ≤ high) or `output_config.effort: "low"`. Set a small `max_tokens` (about 256–1024), leaving room for thinking if it's on.
  - Keep the prompt well under **100K tokens**. Above that, the whole request is billed at 5× the rate.
  - With thinking off, Haiku may skip tool calls when structured outputs is also set [primary, prompting-claude-haiku-5-5]. That isn't an issue for a tool-less classifier.
  - Enum casing isn't guaranteed: normalize it.
  - Cost per classification: about 800 input + 50 output tokens ≈ $0.00008 + $0.000025 ≈ **$0.0001** (my arithmetic from [primary] prices).
- **Agent route (MODEL_MAIN = `claude-sonnet-5-5`)**:
  - Start with `effort: "medium"`; the docs recommend `medium` for multistep tool use and `medium`/`low` for chat.
  - Keep effort and thinking **fixed** so the shared tools+system cache isn't invalidated.
  - Sweep `low`, `medium` and `high` with `npm run eval`.
  - `between_tools` is an alternative that removes up-front thinking latency, but it may lower portion-estimation quality. Eval it.
- **Rough cost of one photo turn on Sonnet 5.5** (my arithmetic, assumptions stated):
  - Assumptions: tools+system ≈ 5K tokens, cache-read; per-turn context ≈ 1.5K tokens; one image resized to ≈1,500 visual tokens; 2 loop iterations; ≈ 900 output tokens in total, including thinking.
  - Request 1: 5K read ($0.0005) + 3K written under automatic caching ($0.0075) + 600 output ($0.006).
  - Request 2: 8K read ($0.0008) + 0.9K written ($0.00225) + 300 output ($0.003).
  - **Total ≈ $0.02.** A full-resolution menu or label image at 4,784 tokens adds about $0.01. A cold tools+system write costs about $0.0125 (5 min) or $0.02 (1 h).
- **Batch API (50% off)** could suit weekly-recap generation. I didn't verify the batch turnaround SLA, so check it before relying on Batch for timed sends.
- **Token counting** (`count_tokens`) is free; use it in tests to watch prefix size [primary].

---

## Implications for our design

1. **Fixed prefix, fresh turn.** Each turn sends:
   - The `tools` array, sorted deterministically and frozen per deploy, with `cache_control` on the last tool.
   - A frozen `system` array of text blocks (persona, texting style, safety rules, tool policy). Put `cache_control` on the last block, and keep timestamps out of it.
   - A first user message holding, in order: the rendered per-user context (profile, targets, today's log totals computed in code, last N messages as plain text, the local date and time); then the image block(s), each preceded by an `Image k:` label; then the user's caption text.
   - Use top-level automatic caching, or an explicit breakpoint on the last user block, so the loop's iterations 2+ read the turn prefix. That's 3 breakpoints in total, under the limit of 4.
2. **Append-only loop, no thinking replay across turns.** Store only final reply text, not assistant content or thinking, for history. This makes the preserved-thinking 400 impossible across turns. Within a turn, push `response.content` verbatim, then a single user message of `tool_result`s. Cap iterations (e.g. 6) and fail gracefully.
3. **No forced tools on Sonnet 5.5.** Use `tool_choice: auto` plus a clear system-prompt policy ("When the user sends food, call log_meal…"). Use `strict: true` on the high-value tools (`log_meal`, `save_supplement`, `edit_or_delete_meal`). Stay within 24 optional parameters across all strict tools: prefer required-plus-nullable or required-with-defaults fields. If that limit is hit, make only the critical tools strict.
4. **Validate everything with Zod anyway:**
   - Generate `input_schema` with `z.toJSONSchema()` (Zod v4) and `additionalProperties:false`.
   - Apply the bounds we can't express (grams > 0, confidence in [0,1]) in Zod, not in the JSON schema: `minimum`/`maximum` are unsupported under strict.
   - Return `is_error: true` with an instructive message on failure.
   - Normalize enum casing.
5. **Reply extraction.** Send only the `text` blocks of the final `end_turn` response; ignore `thinking` blocks and intermediate preamble. Treat `max_tokens`, `refusal` and `model_context_window_exceeded` as non-success paths with canned replies.
6. **Images:** download promptly. Then:
   - Convert HEIC to JPEG.
   - Auto-orient using EXIF, then strip metadata.
   - Resize with the docs' `resizedSize` port. For meal photos, use a cost-saving budget, e.g. ≤1,568 visual tokens (about 1.15 MP). For menus and supplement labels, use the full high-res budget (2,576 px / 4,784 tokens).
   - Send as base64 JPEG at quality ≥ ~85.
   - Don't use URL sources (they would mean public blob URLs) or the Files API (data stored at Anthropic, not ZDR-eligible).
7. **Classifier on Haiku 5.5:** `messages.parse` with `zodOutputFormat`, thinking disabled or effort `low`, small `max_tokens`, no sampling parameters, and a separate small cached prefix (≥512 tokens to cache at all, or skip caching).
8. **SDK config:**
   - One module-level `new Anthropic({ timeout: 60_000–90_000, maxRetries: 2 })`. Keep non-streaming `max_tokens` ≤ 16,000 for Sonnet and about 1,024 for Haiku.
   - Map errors as in §8.
   - Log `requestID`, `usage.*`, `stop_reason` and `stop_details.category` only.
   - Leave `openTelemetry` at `metadata_only`, or disable it.
9. **Cache TTL:** use 5 min while there's steady traffic. If traffic is sparse (MVP), set `ttl:"1h"` on the tools and system breakpoints and the default 5 min on the messages breakpoint (1 h entries must come first). Track hit rate with `cache_read_input_tokens`, and turn on `diagnostics` in dev.
10. **Env:**
    - `ANTHROPIC_API_KEY`
    - `MODEL_MAIN=claude-sonnet-5-5`
    - `MODEL_FAST=claude-haiku-5-5`
    - Optional `ANTHROPIC_LOG`
    - Optional `ANTHROPIC_OPEN_TELEMETRY=false`
11. **Evals:** with no sampling parameters, outputs aren't deterministic. Evals should assert on parsed tool inputs within tolerances, not on exact reply text.

## Open questions for the product owner

1. **Data-handling arrangement with Anthropic.** Do you want to pursue **Zero Data Retention** (through Anthropic sales) or a **HIPAA BAA** (enabled in the Console), given we process consumer health data under WA MHMDA and NV SB 370? Without either, prompts aren't retained by default, but flagged content can be retained for up to 2 years. This is a legal and commercial decision.
2. **Anthropic org tier and spend cap.** A new org likely starts on the Evaluation or Start tier, with a **$500/month** cap that hard-stops all calls (429 with no retry-after) until the 1st of next month. Should we plan to request a tier increase before launch, and what monthly API budget should we design alerts around?

## Risks

- **Preserved-thinking 400s.** Any future change that replays stored assistant content after editing `system` or `tools` (for example a prompt update mid-conversation) fails on new accounts. Mitigation: the fresh-turn design, plus an integration test that sends a mutated prefix.
- **Forced `tool_choice` regressions.** Copy-pasted examples that use `any` or `tool` break on Sonnet 5.5 (400), and also on count_tokens and Batches.
- **Sampling parameters.** Any `temperature` (including from a library) returns a 400 under `2026-10-21`.
- **Strict-schema limits.** Exceeding 20 strict tools, 24 optional parameters or 16 unions returns a 400 ("Schema is too complex"). The first request after a schema change pays compile latency. Unsupported keywords return a 400.
- **Image cost and quality.** High-res tier images cost up to about 3× standard-tier tokens. Over-compression hurts label OCR. HEIC is unsupported. Rotation errors come from ignoring EXIF.
- **Refusal false positives** on eating-disorder, self-harm or supplement content (`general_harms`), with no automatic fallback. They are HTTP 200, so silent unless monitored.
- **Truncation.** Thinking tokens consume `max_tokens`. A low limit gives empty replies or truncated `tool_use` inputs that may still parse as valid partial objects. Never run tools from a `max_tokens` stop.
- **Haiku long-prompt pricing cliff** at 100K tokens (5× rate on the whole request).
- **Spend-cap outage** on the Start tier; the SDK's automatic retries waste time on it.
- **Privacy leaks through observability.** Enabling OTel `contentMode:'content'`, or logging error bodies that echo prompts, would put message bodies and photos in logs.
- **Doc and skill drift.** Prices and features changed recently (cache-read price, cache diagnostics now GA, the API version bump on 2026-10-21). Re-check the pricing page before the cost model goes into DECISIONS.md.
- **Cache misses from nondeterminism.** Unsorted tool order, timestamps in `system`, or a varying effort level turn every request into a full-price write.

## Sources

- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/models/sonnet-5-5/overview
- https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5
- https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
- https://platform.claude.com/docs/en/models/haiku-5-5/overview
- https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5
- https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/about-claude/model-deprecations
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
- https://platform.claude.com/docs/en/build-with-claude/files
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
- https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
- https://platform.claude.com/docs/en/build-with-claude/thinking
- https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
- https://platform.claude.com/docs/en/build-with-claude/effort
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5
- https://platform.claude.com/docs/en/build-with-claude/token-counting
- https://platform.claude.com/docs/en/api/rate-limits
- https://platform.claude.com/docs/en/api/errors
- https://platform.claude.com/docs/en/api/overview
- https://platform.claude.com/docs/en/api/versioning
- https://platform.claude.com/docs/en/api/migration-2026-10-21
- https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
- https://registry.npmjs.org/@anthropic-ai/sdk (npm `@anthropic-ai/sdk@1.3.0` tarball: `src/client.ts`, `src/core/error.ts`, `src/resources/messages/messages.ts`, `src/resources/shared.ts`, `src/helpers/zod.ts`, `src/helpers/beta/zod.ts`, `src/lib/transform-json-schema.ts`, `src/internal/constants.ts`, `src/internal/tracing.ts`, `package.json`, `CHANGELOG.md`, `README.md`)
- https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/helpers.md (main branch; may be ahead of 1.3.0)

## Critic addendum (2026-10-29)

Completeness-critic pass, appended to this file without changing the content above. I re-checked the facts in this note that drive the architecture, plus the ones that look surprising next to older models. **All of them matched.**

| Claim in this note | Re-check result | Tag |
|---|---|---|
| Sonnet 5.5: $2 in, $2.50 5-min write, $4 1-h write, **$0.10 cache read**, $10 out | pricing.md L29. Footnote 2 says "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input price" | [primary] |
| Haiku 5.5: $0.10 / $0.125 / $0.20 / $0.01 / $0.50 for prompts ≤100K; $0.50 / $0.625 / $1 / $0.05 / $2.50 for prompts >100K; prompt length "counts all of its input tokens, including cache reads and cache writes" | pricing.md L34–35, L222 | [primary] |
| Minimum cacheable prompt is 512 tokens on Sonnet 5.5 and Haiku 5.5 | prompt-caching.md L626–628 | [primary] |
| Sonnet 5.5 returns 400 for `tool_choice` `any`/`tool`, error text `tool_choice: type "tool" and "any" are not supported for this model.`, and the same check applies to token counting | whats-new-sonnet-5-5.md L39–47 | [primary] |
| Vision formats are JPEG/PNG/GIF/WebP only, max 8000×8000 px, high-res tier (Claude 4.7+) is 2,576 px / 4,784 tokens | vision.md L1275, L1293, L1303 | [primary] |
| `@anthropic-ai/sdk` latest is 1.3.0 and sends `anthropic-version: 2026-10-21` | `npm view` returns 1.3.0; tarball `src/client.ts` L2018 | [sdk-source] |

Cross-note items:
- **HEIC.** §3.1 says to "convert server-side". The obvious library, prebuilt sharp, cannot decode HEIC; see imessage-providers.md, Critic addendum §4. Plan for a separate decoder.
- **Timeout budget.** The §8 recommendation (`timeout` 60–90 s, `maxRetries` 2) can take about 270 s on a single call, and the SDK retries timeouts. That doesn't fit a multi-call loop inside Vercel's 300 s Hobby `maxDuration`. See vercel-next.md, Critic addendum §3 for a deadline-driven default.

Sources for this addendum:
- https://platform.claude.com/docs/en/about-claude/pricing.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md
- https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5.md
- https://platform.claude.com/docs/en/build-with-claude/vision.md
- https://registry.npmjs.org/@anthropic-ai/sdk (1.3.0 tarball `src/client.ts`)
