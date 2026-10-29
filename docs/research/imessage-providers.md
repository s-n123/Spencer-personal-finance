# iMessage providers: Sendblue (primary), Linq and Blooio (alternatives)

Retrieved: 2026-10-29

**TL;DR.** Sendblue is a REST API at `https://api.sendblue.co` (the default in the official SDK; the docs and the official CLI use `https://api.sendblue.com`). It authenticates with two headers, `sb-api-key-id` and `sb-api-secret-key`. You send with `POST /api/send-message` (`number`, `from_number`, `content`, `media_url`, `send_style`, `status_callback`, `reply_to`). Typing indicators use `POST /api/send-typing-indicator` (iMessage only, 1:1 only, needs a recent conversation). Reactions use `POST /api/send-reaction` (classic tapbacks or a single emoji, iMessage only). Read receipts use `POST /api/mark-read`, which Sendblue support has to enable for the account. Inbound messages arrive at "receive" webhooks, configured in the dashboard or with `POST /api/account/webhooks`. **Webhook authenticity is a static shared secret that Sendblue echoes back in the `sb-signing-secret` request header.** It is not an HMAC: there is no body integrity, no timestamp and no replay protection. Only the Verify product's webhooks use HMAC (`X-Sendblue-Signature`). We should add defense in depth: compare the header in constant time, put a secret path token in the URL, and optionally fetch the message back to confirm it. Inbound `media_url` links expire after 30 days, so download them right away. Webhooks have a 45 s timeout and are retried up to 3 times on a 5xx or a timeout, so delivery is at-least-once: dedupe on `message_handle`. The AI Agent plan (about $100 per line per month) is inbound-first: 1,000 inbound contacts per day per line, unlimited replies within 24 h of the user's last message, and 200 follow-up contacts per day per line outside that window. That last limit directly caps our proactive check-ins. Sendblue also processes STOP/START keywords itself. Linq (Standard Webhooks HMAC, chat-id based, 1-hour presigned media URLs) and Blooio (Stripe-style `t=,v1=` HMAC, chat-id based) both fit a provider-agnostic `ChannelAdapter`. That works as long as the interface treats the conversation reference and the capability flags as provider-specific.

Verification tags: **[primary]** = read on an official doc page myself; **[sdk-source]** = read in official SDK/CLI source or types (npm tarball / PyPI wheel / raw GitHub); **[search]** = only from a WebSearch summary of the official docs. **Confirm every [search] fact before coding.** docs.sendblue.com, docs.linqapp.com, docs.blooio.com and blooio.com could not be reached from this container (DNS failure), so I have no [primary] tags. SDK source stands in as the strongest primary source.

---

## 1. Sendblue: sources read

- npm `sendblue@3.21.1` (published 2026-10-23, Stainless-generated, zero dependencies, repo `sendblue-api/sendblue-ts`): README, `src/client.ts`, all of `src/resources/**`, CHANGELOG [sdk-source]. Raw `api.md` from GitHub main matches the tarball (54 configured endpoints) [sdk-source].
- npm `@sendblue/cli@0.10.0` (official CLI, uses `sendblue@3.11.0` plus raw fetch) [sdk-source].
- PyPI `sendblue@1.33.0` (official Python SDK, repo `sendblue-api/sendblue-py`). Grepped it for webhook and signature helpers and found none [sdk-source].
- Listing the `sendblue-api` GitHub org failed: this session's GitHub API is bound to the configured repos, and github.com HTML returned 403. Known repos: `sendblue-ts`, `sendblue-py`, `sendblue-node` (old, 2022), `sendblue-browser-use`.
- WebSearch summaries of docs.sendblue.com pages: getting-started/webhooks, getting-started/receiving-messages, getting-started/sending-messages, security, limits, api-v2/typing-indicators, api-v2/reactions, api-v2/read-receipts, api-v2/media, getting-started/groups, guides/chat-sdk-adapter, api-v2/verify [search].
- Third-party code, used only as corroboration and never as a source of truth: `chat-adapter-sendblue@0.2.0` (midday-ai), `@volter/twin-sendblue@0.1.37`.

## 2. Sendblue: base URL, auth, client behaviour

| Item | Value | Tag |
|---|---|---|
| Base URL (SDK default) | `https://api.sendblue.co` (env override `SENDBLUE_API_BASE_URL`) | [sdk-source] `src/client.ts` |
| Base URL (CLI / docs) | `https://api.sendblue.com` (CLI `API_BASE`, env `SENDBLUE_API_BASE`) | [sdk-source] CLI `dist/lib/api.js`; docs use `.com` [search] |
| Auth headers | `sb-api-key-id: <API key id>` and `sb-api-secret-key: <secret>` | [sdk-source] `apiKeyAuth`/`apiSecretAuth` |
| Alt auth | `Authorization: Bearer <accessToken>` (short-lived tokens from `POST /v3/auth/tokens`; cannot be combined with key and secret) | [sdk-source] |
| SDK env vars | `SENDBLUE_API_API_KEY`, `SENDBLUE_API_API_SECRET`, `SENDBLUE_API_LOG` | [sdk-source] |
| SDK retries | 2 retries by default on connection errors, 408, 409, 429 and >=500, with exponential backoff; 60 s default timeout | [sdk-source] README |
| Idempotency | **None for `/api/send-message`.** The SDK's `idempotencyHeader` is unset. Only `update-app-card` takes an `idempotency_key` body field. | [sdk-source] |
| Runtimes | Node 20+, Vercel Edge Runtime, Cloudflare Workers, etc. | [sdk-source] README |

**Conflict:** `.co` (SDK) vs `.com` (docs/CLI). Both appear to be live official hosts. Make it configurable and default to the SDK value. **Risk:** the SDK's automatic retry on POST `/api/send-message` (5xx/timeout/409) can produce **duplicate texts**, because send has no idempotency key. Use `maxRetries: 0` for sends, and reconcile through `GET /api/status?handle=` or `GET /api/v2/messages` before any manual retry.

## 3. Sendblue: sending messages

`POST /api/send-message` [sdk-source `messages.send`]

Body (`MessageSendParams`) [sdk-source]:
- `number` (required): the recipient. The type doc says E.164, but the receiving docs say it may also be an Apple Account email (an iMessage email handle) and you reply by passing that email as `number` [search].
- `from_number`: your Sendblue line in E.164. **Required on free shared-line plans.** Optional on dedicated/enterprise plans when "Automatic API line selection" is enabled (off by default). Required for inline replies and App Cards.
- `content`: text. Optional when `media_url` or `app_card` is present. Must be **< 18,996 characters** [search].
- `media_url`: URL of the media file.
- `send_style`: `celebration | shooting_star | fireworks | lasers | love | confetti | balloons | spotlight | echo | invisible | gentle | loud | slam`.
- `status_callback`: URL that receives status updates for this message. There is **no** global default status callback; you either set it per send or use the account-level `outbound` webhook [search].
- `reply_to: { message_handle, part_index? }` sends an iMessage inline reply. `seat_id`, `app_card` and `pre_reply_override: true` are also accepted (the override lets one blocked message through per contact per line per day).

Response (`MessageResponse`) [sdk-source]: `message_handle`, `status` (`QUEUED|SENT|DELIVERED|ERROR`), `from_number`, `number`, `content`, `media_url`, `send_style`, `error_code`, `error_message`, `error_key` (a stable rule id such as `PRE_REPLY_LIMIT_REACHED` or `OPTED_OUT`; the docs say "branch on this field"), `date_created`, `date_updated`, `account_email`, `is_outbound`, `message_type` (`message|group|location`), `reply_to`, `thread_originator`.

Status lifecycle (status_callback) [search]: `REGISTERED, PENDING, DECLINED, QUEUED, ACCEPTED, SENT, DELIVERED, ERROR`. **DELIVERED is terminal for iMessage/RCS. SENT is terminal for SMS** or when the recipient is not on iMessage. The SDK's `MessageRetrieveResponse.Data.status` enum also includes `RECEIVED` and `SUCCESS` [sdk-source]. The API v2 overview lists only QUEUED/SENT/DELIVERED/ERROR, so the docs disagree with each other [search]. Callback fields: `status, error_code, error_message, error_key, error_reason (display only), error_detail, message_handle, is_outbound, service, from_number, number, to_number, date_sent, date_updated` [search].

Other message endpoints [sdk-source]:
- `GET /api/status?handle=<message_handle>`: current status, "useful for resolving pending statuses and avoiding duplicate messages".
- `GET /api/v2/messages/{message_id}`: a single message. The data includes `service` (`iMessage|SMS|RCS`), `was_downgraded`, `group_id`, `participants`, `opted_out`, `plan`, `sendblue_number`. It is unconfirmed whether `{message_id}` equals `message_handle`; the SDK example uses `msg_abc123def456`.
- `GET /api/v2/messages`: list with filters (`is_outbound`, `number`, `sendblue_number`, `group_id`, `message_type`, `service`, `status`, created/sent/updated ranges, `order_by` createdAt|updatedAt|sentAt, `limit`, `offset`). **Rate limited to 100 requests / 10 s per account.**
- `GET /api/evaluate-service?number=`: iMessage-support lookup (`service: 'iMessage'|'SMS'`); not a delivery guarantee.

SMS fallback: Sendblue falls back from iMessage to SMS when the recipient lacks iMessage. `was_downgraded: true` marks that [search]. The `service` field tells you the transport [sdk-source, search].

### Sending media
- You can pass `media_url` on send. **It must be publicly fetchable. Signed URLs are not supported** ("please use the media object pattern"). The docs recommend a CDN URL with a proper file extension and no spaces [search].
- Upload options: `POST /api/upload-file` (multipart field `file`) returns `{ media_url }` [sdk-source CLI `uploadFile`], with a 100 MB cap on direct upload [search]. `POST /api/upload-media-object` takes `{ media_url }` and returns `{ mediaObjectId, status, message }`, re-hosting a URL on Sendblue's CDN [sdk-source].
- Types: the Media Upload page says "all file types supported" and lists JPG, PNG, GIF, HEIC, WebP; MP4, MOV, M4V; M4A, MP3, AAC, CAF; PDF, VCF [search].
- Size: iMessage 20 MB recommended, 100 MB max. SMS 5 MB max. RCS 5–100 MB depending on carrier [search]. That page is about 321 days old. App Card preview images are a separate case: JPEG/PNG/HEIC/HEIF/WebP up to 10 MB [sdk-source].
- Unknown: whether `content` and `media_url` in one request arrive as one bubble or two.

## 4. Sendblue: typing indicators

`POST /api/send-typing-indicator` [sdk-source `typingIndicators.send`]
- Body: `from_number` (required, your line), `number` (required, the recipient), `state?: 'start' | 'stop'` (defaults to start), `max_duration_ms?` for a start indicator. Default is 60 s; valid range 1–300000 ms [search].
- Response: `{ number, status: 'SENT' | 'ERROR', error_message }` [sdk-source].
- Constraints [search]: **iMessage only** (not SMS/RCS). **Not supported in group chats** (also stated in the SDK docstring [sdk-source]). **Requires an existing chat with recent messages:** the API uses the established "route mapping". It is best-effort and can return `SENT` even when nothing is shown. A **503** means the line's worker firmware doesn't support `state`/`max_duration_ms` yet: retry shortly, or send a legacy start without a duration. Third-party adapter code catches an error message containing `"No route mapping"` and treats it as non-fatal [third-party, corroborating].
- There is an optional auto mode (an auto-trigger on inbound 1:1 iMessages) [search].
- Plan gating: the docs say nothing about it. The AI Agent plan listing includes "typing and reactions" [search, marketing].
- Inbound typing: a `typing_indicator` webhook type delivers `{ number, is_typing, from_number, timestamp }` [search; the type name is in the SDK enum, sdk-source]. Typing v2 (start/stop plus max_duration_ms, and the inbound typing webhook) shipped in SDK 3.10.0 (2026-06-04) [sdk-source CHANGELOG].

## 5. Sendblue: reactions and read receipts

**Reactions:** `POST /api/send-reaction`. It is not in the SDK; call it with `client.post('/api/send-reaction', { body })`. [search; endpoint corroborated by third-party code]
- Body: `from_number`, `message_handle` (the **primary** handle of a *received* iMessage), `reaction`, `part_index?`.
- Values: `love | like | dislike | laugh | emphasize | question` (case-sensitive) or **any single emoji**. New integrations are told to send emoji. A `-` prefix (`-love`, `-🔥`) removes a reaction you sent.
- Errors: 422 for SMS/RCS targets, App Card messages, or an attachment-specific handle. 404 for an unknown handle or one from another account. Very old messages may be rejected, so react only to recent ones.
- Success: `{ status, message: "Reaction request sent", message_handle, reaction }`.
- Conflict: third-party `chat-adapter-sendblue@0.2.0` says removal isn't supported. That code is older than the current docs.
- Inbound tapbacks from users: **I found no documented payload.** We don't know whether they arrive on the `receive` webhook as text. Guard against them triggering an agent turn.

**Read receipts:** `POST /api/mark-read` with body `{ number, from_number }` (both E.164) [search; corroborated by third-party code].
- **Must be enabled for the account by Sendblue support.** A missing `from_number` returns 400; an unregistered line returns 404. Receipts are best-effort and iMessage/RCS only [search].
- SDK 3.17.0: "Reject /mark-read for lines that cannot apply a read receipt" [sdk-source CHANGELOG].
- An account setting, `POST /accounts/settings/auto-mark-read`, auto-sends receipts for every inbound 1:1 iMessage (Free API and AI Agent plans) [search].

## 6. Sendblue: inbound webhooks

Configuration [sdk-source `webhooks.*`]:
- `POST /api/account/webhooks`: append. Body `{ webhooks: Array<string | { url, secret?, sendblue_numbers? }>, type?, globalSecret? }`.
- `PUT /api/account/webhooks`: replace all. Body `{ webhooks: { receive?: [...], outbound?: [...], typing_indicator?: [...], ..., globalSecret? } }`.
- `GET /api/account/webhooks` lists them. `DELETE /api/account/webhooks` takes `{ webhooks: string[], type? }`.
- Types: `receive` (inbound messages), `outbound` (status of sent messages, applies to every line), `typing_indicator`, `line_blocked`, `line_assigned`, `call_log`, `call_completed`, `inbound_call`, `contact_profile`, `contact_created`.
- `sendblue_numbers` (receive webhooks only) limits delivery to inbound messages on those lines.
- Dashboard: Developer → Webhooks [search].

Inbound payload (receive). Field names come from the docs' field table [search], cross-checked against the SDK's message data types [sdk-source]:
`accountEmail`, `content`, `is_outbound` (false for inbound), `status` (`RECEIVED` for inbound), `error_code`, `error_message`, `error_reason`, `error_detail`, `message_handle`, `date_sent` (ISO 8601), `date_updated`, `from_number` (sender: E.164 **or an Apple Account email**), `number` (the end user's identifier: E.164 or email), `to_number`, `sendblue_number` (your line), `was_downgraded` (bool or null), `plan` (e.g. `"dedicated"`), `media_url` (single CDN link, or empty), `message_type` (`message|group|location`), `group_id` (**empty string for 1:1**), `group_display_name` (null for 1:1), `participants` (array of phones or iMessage emails), `send_style`, `opted_out`, `service` (`iMessage|SMS|RCS`). Also seen in the SDK types: `reply_to`, `thread_originator`, `location`, `app_card`, `seat_id`, `sender_email`.
- I could not see the full example JSON. Confirm the field casing with a live payload (note `accountEmail` is camelCase while the other fields are snake_case).
- **Multiple attachments:** the SDK docs describe "an attachment represented by its own webhook" with its own `message_handle` [sdk-source `ReplyTo.part_index` doc]. So one iMessage with N photos plus a caption can arrive as **several webhooks**. Our 4 s debounce is required, not optional. We don't know whether the caption arrives on its own webhook or as `content` on one of the photo webhooks.
- iMessage vs SMS: `service`, plus `was_downgraded` for outbound fallback.

Delivery semantics [search]:
- **Timeout 45 s.** No response within 45 s counts as a failure.
- **Retried up to 3 times on 5xx or timeout.** The marketing pages say "non-200 triggers retries with exponential backoff", which conflicts. The backoff schedule is not documented.
- At-least-once delivery. "Endpoints should be idempotent." **Dedupe key: `message_handle` for message events** (`event_id` "for events that provide it"; no receive field of that name was confirmed).
- Return 2xx to stop redelivery.

Alternative to webhooks: `GET /api/v2/events` is an SSE account stream with event types `message.received`, `message.updated`, `typing.changed`, etc. It sends a heartbeat every 15 s, rotates at most every 15 min, has no durable replay, and consumers dedupe by `id` [sdk-source]. **It does not suit Vercel serverless.** Use webhooks.

## 7. Sendblue: webhook authenticity (critical)

What the sources say:
1. **Shared-secret header.** The Security page says "Sendblue sends `sb-signing-secret` header with requests. Verify this matches your configured secret." [search]. The Webhooks page says the secret goes in "the webhook request headers" but names no header [search]. The Chat SDK adapter guide verifies the `sb-signing-secret` header by default, reads the value from `SENDBLUE_WEBHOOK_SECRET`, and lets you override the header name (`webhookSecretHeader`) [search]. Third-party `chat-adapter-sendblue` does exactly `request.headers.get('sb-signing-secret') !== config.webhookSecret`, a plain equality check [third-party code].
2. **Where secrets live:** a per-webhook `secret` on `{ url, secret }` objects, an account `globalSecret`, or a legacy root-level `secret` (older format) [sdk-source field docs "Secret for webhook signature verification"; search for the three options].
3. **No HMAC for message webhooks.** None of the SDKs (TS 3.21.1, Python 1.33.0, CLI 0.10.0) ships a verify or unwrap helper [sdk-source]. A third-party "twin" package implements an `sb-signature` HMAC-SHA256 scheme, but its source states the scheme "is grounded in the real consumer's verification code, not a vendor spec" and that the vendor docs do not document a signing algorithm. **Do not rely on it.**
4. **Verify product only:** `X-Sendblue-Signature: t=<timestamp>,v1=<sig>`, where `sig = HMAC_SHA256(secret, "${timestamp}.${raw_body}")` [search]. This applies to Sendblue Verify webhooks, not message webhooks. **The docs do not say** whether message webhooks also carry it.
5. No IP allowlist is documented [search].

**Recommended verification for `SendblueAdapter`:**
- (a) Set a per-webhook `secret` (32+ random bytes) through `POST /api/account/webhooks` (`type: 'receive'`) or the dashboard. Compare `sb-signing-secret` with `crypto.timingSafeEqual` (check lengths first). Reject with 401 on a mismatch.
- (b) Also put an unguessable token in the webhook path (e.g. `/api/webhooks/sendblue/<token>`), because (a) is a static bearer value with no body integrity or replay protection.
- (c) Optionally verify by fetching the message back (`GET /api/v2/messages/{id}` or a list filtered by number) before acting on high-impact commands such as DELETE. Mind the 100 req/10 s limit.
- (d) If a live delivery carries `X-Sendblue-Signature`, prefer verifying the HMAC.
- (e) Read the raw body (`await req.text()`) before `JSON.parse`, so we can switch to HMAC later.

Confirm the exact header with one live delivery during milestone 6.

## 8. Sendblue: inbound media URLs

- `media_url` is "a CDN link that **expires after 30 days** for inbound" [search; repeated in a Sendblue blog post and the Chat SDK guide].
- Host: example responses show `storage.googleapis.com/inbound-file-store/...` [search]. That is one example, not a guarantee.
- Auth to download: **not documented.** It appears to be a public GCS URL. Do a plain GET and treat a 401/403 as an error worth alerting on. Do not send Sendblue API headers to a third-party host by default.
- Format: iPhone photos may arrive as **HEIC**. Sendblue lists HEIC as a supported type [search]. Anthropic vision accepts only certain formats, so the media pipeline must convert HEIC to JPEG. Check that our image library can decode HEIC; don't assume it can.
- Download right away (well inside 30 days), store in Blob/S3, and keep only our own URL.

## 9. Sendblue: limits, plans, compliance

Request-rate limits [search, sdk-source]:
- HTTP 429 is reserved for request-rate limiting, and the SDKs retry 429 by default.
- `GET /api/v2/messages` (and the contacts API): 100 requests / 10 s per account.
- **10 messages/s per line.** Excess requests are rejected, not queued.

New-contact limits (Blue Ocean / outbound plans) [search; corroborated by the SDK `lines.getUsage` docs, sdk-source]:
- 50 new contacts per line per day, resetting at **3 AM ET**.
- 15 per rolling 60 min.
- Burst of 10 msg/s.
- "New" means no conversation in the last 30 days (`new_contact_lookback_days`). Inbound-initiated conversations don't count.
- When every line is capped, you get HTTP **400** with body `error_code: 429` and `error_key` `LINE_HOURLY_LIMIT_REACHED` or `LINE_DAILY_LIMIT_REACHED`, and nothing is queued [sdk-source `messages.send` docstring].
- `GET /api/v2/lines/usage` and `GET /api/v2/lines/contact-status?number=&sendblue_number=` show capacity and known/new status, including advisory pacing `suggested_delay_ms` [sdk-source].

Pre-reply rules (before a contact's first reply) [search; `pre_reply_override` and `error_key` in sdk-source]:
- At most 6 SENT/DELIVERED messages; the 7th is declined with `4009 PRE_REPLY_LIMIT_REACHED`.
- **300-character cap** (`4008 PRE_REPLY_LENGTH_EXCEEDED`).
- **Links and media are blocked.**
- One `pre_reply_override` per contact per line per day; a second returns `4010 PRE_REPLY_OVERRIDE_EXHAUSTED`.
- These declines are HTTP 400, never 429.
- **For us:** users always text first, so these rules should not apply. They would matter only if we ever messaged a number that has never replied.

AI Agent plan (inbound-first) [search]:
- About **$100 / month / dedicated line**, no per-message fees. Includes a dedicated number, webhooks/callbacks, media, typing and reactions.
- **1,000 inbound contacts/day/line.**
- **Replies within 24 h of the contact's last message are unlimited.**
- Messaging first after 24 h counts against **200 follow-up contacts/day/line**. The window resets each time the contact texts.
- AI Agent lines can respond in groups they were added to but cannot create groups.

Free sandbox [search]:
- Shared number, up to 10 verified contacts, and each contact must text first to verify (the CLI uses `/accounts/verify-contact-on-shared-account`) [sdk-source CLI].
- The pricing page lists "no outbound messaging" and "no webhooks or callbacks". Other pages and the SDK (which says `from_number` is "required on free shared-line plans") suggest sending works. **This conflicts:** confirm in the dashboard before relying on the sandbox for milestone 6.

Opt-out keywords:
- Sendblue has built-in detection for **stop, unsubscribe, cancel, opt out, revoke, end, quit**, and "opt-in via start". Custom phrases require support and cannot be set through the API [search].
- Opted-out recipients are blocked and sends return `error_key: OPTED_OUT` [sdk-source enum example; search].
- `POST /api/v2/contacts/opt-out` with `{ number, opted_out?: boolean }` sets or clears the opt-out [sdk-source]. `PUT /api/v2/contacts/{phone}` with `opt_out` updates "the same recipient record used for inbound keyword opt-outs" [sdk-source].
- Unknown: whether Sendblue auto-replies to STOP and whether a START reply clears the block automatically.

Line health [sdk-source]:
- `GET /api/v2/lines/state` returns `status: ONLINE|OFFLINE|DEGRADED|UNKNOWN`.
- The `line_blocked` webhook type exists. Wire it to an admin alert.

Spam guidance: Sendblue's limits revolve around new-contact pacing, pre-reply rules and per-line throughput. Our spec's quiet hours, per-user caps, back-off and global daily cap match this. I found no other written spam guidance [search].

## 10. Sendblue: group chats (we ignore them)

- Detection: `group_id` is a non-empty string (it is `""` for 1:1) [search], **or** `message_type === 'group'` [sdk-source enum], or `participants.length > 1` besides us. `group_display_name` is non-null for groups.
- Action: return 200, do not enqueue a turn, and log only a count. Typing indicators are unsupported in groups anyway [sdk-source].

---

## 11. Linq (Linq Blue iMessage API), brief

Sources: npm `@linqapp/sdk@0.78.0` (official, Stainless, repo `linq-team/linq-node`, 2026-10-09) and `@linqapp/chat-sdk-adapter@0.5.1` [sdk-source]; WebSearch of docs.linqapp.com and linqapp.com [search].

- **Base URL / auth:** `https://api.linqapp.com/api/partner`, `Authorization: Bearer <token>` (env `LINQ_API_V3_API_KEY`) [sdk-source].
- **Model:** chat-centric.
  - Start a chat with `POST /v3/chats` `{ from, to: [handles], message: { parts: [...] } }`. The same `from` plus `to` returns the existing chat.
  - Send into a known chat with `POST /v3/chats/{chatId}/messages` `{ message: { parts, idempotency_key? }, override_optout? }`.
  - Parts: `{type:'text', value}` and `{type:'media', url | attachment_id}`.
  - **Has an `idempotency_key`.** [sdk-source]
- **First-message rule:** the first outbound message of a *new* chat cannot contain a link (`400`, code `1005`). Sends into an existing chat are exempt [sdk-source].
- **Media out:** a public HTTPS URL up to **10 MB**, or pre-upload with `POST /v3/attachments` (presigned PUT, valid 15 min) up to 100 MB [sdk-source].
- **Media in:** `parts[].type==='media'` with `url`, `mime_type`, `size_bytes`, `filename`. **The URL is a presigned URL that expires in 1 hour.** URLs are served from `cdn.linqapp.com`. Ephemeral tiers delete files after 24–48 h [sdk-source].
- **Webhooks:**
  - Create with `POST /v3/webhook-subscriptions` `{ target_url, subscribed_events, phone_numbers? }`. The signing secret is returned once.
  - Payload version comes from the `?version=2026-02-03` query param on the URL.
  - Envelope: `{ api_version, event_id, event_type, created_at, partner_id, trace_id, webhook_version, data }`.
  - `message.received` data: `{ id, chat: { id, is_group, owner_handle, health_status }, direction, sender_handle: { handle, service, is_me }, parts, service, sent_at, reply_to, reconciled_at? }`. The docs say to treat `reconciled_at` (late recovered messages) as history and suppress auto-replies.
  - [sdk-source]
- **Webhook verification:** **Standard Webhooks.**
  - Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`, space-separated list).
  - Signed content: `"{webhook-id}.{webhook-timestamp}.{rawBody}"`, HMAC-SHA256 keyed with the base64-decoded secret after stripping `whsec_`. Reject timestamps older than 5 min. The SDK's `webhooks.unwrap()` uses the `standardwebhooks` package.
  - Legacy `X-Webhook-Signature` (hex HMAC-SHA256) and `X-Webhook-Timestamp` headers are still sent but deprecated.
  - Use `webhook-id` as the dedupe key. [sdk-source]
- **Retries:** 5xx, 429 and network errors are retried with exponential backoff **for up to 30 min**. Other 4xx responses are not retried [sdk-source].
- **Typing:** `POST /v3/chats/{chatId}/typing` (start) and `DELETE` (stop). iMessage only; SMS/RCS requests return 204 but nothing is shown. Reliable only if you sent a message in the last ~5 min. One call lasts ~85–90 s; refresh every 60 s; sending a message clears it [sdk-source]. Minor conflict: the SDK says it works in groups, but the adapter README says Linq rejects typing in groups.
- **Reactions:** `POST /v3/messages/{messageId}/reactions` `{ operation: 'add'|'remove', type: love|like|dislike|laugh|emphasize|question|custom|sticker, custom_emoji? }`. Inbound events: `reaction.added` and `reaction.removed` [sdk-source].
- **Read receipts:** `POST /v3/chats/{chatId}/read` [sdk-source].
- **Opt-out:** whole-message STOP/UNSUBSCRIBE/OPTOUT/CANCEL/END/QUIT blocks sends with `403` code `2024`. Any later non-keyword message from the user opts them back in. `override_optout` exists [sdk-source].
- **Limits:**
  - Recommended ≤7,000 messages (in plus out) per line per day; no hard cap in production; sandbox 100/day [search].
  - 30 messages / 60 s per sender–recipient pair; excess returns 429 code `1007` with `Retry-After` [search].
  - Capability checks: 1 per 10 s [search].
  - Conflict: the 1007 error page describes a daily allowance [search].
  - Chat `health_status` (BETA) signals line-flagging risk [sdk-source].
- **Pricing:** Hobby $0 (≤20 contacts); Pro from $260/mo [search, marketing].

## 12. Blooio, brief

Sources: npm `eve-channel-blooio@0.3.0` (published by the Blooio org, author david@blooio.com, targets the **v4** API, 2026-10-11) [sdk-source, official integration code]; `@blooio/sdk@0.0.2` (2025-10, the old `/v1/api/...` API, outdated); third-party `chat-adapter-blooio@0.1.0`; WebSearch of docs.blooio.com and blooio.com [search].

- **Base URL / auth:** `https://api.blooio.com/v4`, `Authorization: Bearer bl_live_...` [sdk-source]. Conflict: one docs guide still shows `https://api.blooio.com/v2/api` [search].
- **Send:**
  - Into an existing chat: `POST /chats/{chatId}/messages` `{ text?, attachments?: [publicUrl...], format?: 'markdown', reply_to? }`.
  - Proactive or new: `POST /messages` `{ to, from | channel_type, ... }`.
  - **`Idempotency-Key` header** (the same key within 24 h returns the original response [search]).
  - [sdk-source]
- **Inbound:**
  - Envelope `{ id, type, created_at, organization_id, data }`.
  - `type: 'message.received'` data fields: `chat_id`, `message_id`, `sender`, `recipient`, `text`, `attachments: [{ url, media_type, size, caption }]`, `is_group`, `group_id`, `channel_type` (e.g. `amb`), `protocol`.
  - Blooio "re-hosts inbound media at servable URLs". Expiry not found.
  - Dedupe on envelope `id`.
  - [sdk-source]
- **Webhooks:** `POST /v4/webhooks` `{ url, event_types: ["*"] }`. Headers also include `X-Blooio-Event` and `X-Blooio-Webhook`. Secret rotation: `POST /webhooks/{id}/secret/rotate`. HTTP timeout 5000 ms [search].
- **Verification:**
  - `X-Blooio-Signature: t=<unix>,v1=<hex HMAC-SHA256>` over `"<t>.<rawBody>"`, keyed with the `whsec_...` secret **used as the raw string** (not base64-decoded, unlike Linq). Reject timestamps outside 300 s. [sdk-source eve-channel `verify.js`; same scheme in third-party chat-adapter-blooio]
  - **Conflict:** a docs Node guide shows HMAC over the raw body only, with no timestamp [search]. Likely an older example. Confirm with a live delivery.
- **Retries:** a 5xx response makes Blooio "retry the delivery with backoff" [sdk-source README]. The count and schedule are not documented [search].
- **Typing:** `POST /chats/{chatId}/typing` `{ state: 'started' | 'stopped' }` (iMessage and Apple Messages for Business) [sdk-source].
- **Reactions:** `POST /chats/{chatId}/messages/{messageId}/reactions` `{ reaction: '+love' | '-love' | '+<emoji>' }` [sdk-source].
- **Read:** `POST /chats/{chatId}/read` [sdk-source].
- **Limits / pricing:** no published numeric limits ("no arbitrary daily caps", auto-pacing). $39/mo shared, $98/mo inbound dedicated, $289/mo full dedicated [search, marketing].

---

## 13. Cross-provider comparison (for the ChannelAdapter)

| Concern | Sendblue | Linq | Blooio |
|---|---|---|---|
| Conversation key | (user handle, our line), no chat id | `chat.id` | `chat_id` |
| Inbound message id (dedupe) | `message_handle` (one per attachment) | `event_id` / `webhook-id`; msg `id` | envelope `id`; `message_id` |
| User identity | `from_number`/`number`: E.164 **or iMessage email** | `sender_handle.handle`: E.164 or email | `sender` |
| Media in | `media_url` (one per webhook), 30-day expiry | `parts[]` media, **1 h presigned** | `attachments[]`, re-hosted |
| Media out | public URL (no signed URLs) or upload-file | public URL ≤10 MB or attachment_id | public URL list |
| Webhook auth | static `sb-signing-secret` header (shared secret) | Standard Webhooks HMAC (+5 min replay) | `X-Blooio-Signature` t/v1 HMAC (+5 min) |
| Webhook retries | ≤3 on 5xx/timeout; 45 s timeout | backoff up to 30 min on 5xx/429/network | backoff on 5xx; 5 s timeout |
| Idempotent send | no | `idempotency_key` | `Idempotency-Key` header |
| Typing | start/stop + duration; needs recent convo; 1:1 only | start/stop; ~85–90 s; best within 5 min of our last send | start/stop |
| Reactions | classic + single emoji, `-` removes | add/remove classic + custom + sticker | `+`/`-` classic or emoji |
| Read receipts | `/api/mark-read` (needs enablement) | `/v3/chats/{id}/read` | `/chats/{id}/read` |
| Service field | `service` iMessage/SMS/RCS, `was_downgraded` | `service` per message | `protocol` / `channel_type` |
| Group detect | `group_id !== ''` or `message_type==='group'` | `chat.is_group` | `is_group` / `group_id` |
| Provider STOP handling | built-in keywords; `OPTED_OUT` | built-in; 403 `2024` | not found |

## Implications for our design

1. **ChannelAdapter shape.** Base it on what all three support:
   - `verifyWebhook(req, rawBody): Promise<boolean>`
   - `parseWebhook(rawBody, headers): NormalizedEvent[]`, where an event is an inbound message, a status, a typing event, a reaction, or ignore
   - `send({ to: ConversationRef, text?, mediaUrls?, replyToId?, idempotencyKey })`
   - optional `startTyping` / `stopTyping` / `react` / `markRead`
   - a static `capabilities` object (`typing`, `typingStop`, `reactions: 'classic'|'emoji'`, `readReceipts`, `idempotentSend`, `maxMediaBytes`)
   
   Capability calls must be **best-effort**: swallow and log failures (a Sendblue typing 503 or "No route mapping", a reaction 422), and never block a reply on them.
2. **Normalized inbound.** The spec's normalized message should carry:
   - `handle` (E.164 **or iMessage email**) plus a derived `phoneE164?`
   - `providerMessageId`, `providerConversationId?` (Linq/Blooio chat id; null for Sendblue), `ourLine`
   - `text`, `media: [{ url, mimeType?, expiresAt? }]`, `timestamp`, `service` (`iMessage|SMS|RCS`), `isGroup`
   
   Store `providerConversationId` and `ourLine` on the user so replies route correctly. Decision: accept email handles as identities (log this in DECISIONS.md).
3. **Raw body first.** In the Next.js route handler, read `await req.text()`, verify, then `JSON.parse`. All HMAC schemes need the exact bytes.
4. **Sendblue verification.** Constant-time compare of `sb-signing-secret` against `SENDBLUE_WEBHOOK_SECRET`, **plus** a secret URL path token (`SENDBLUE_WEBHOOK_PATH_TOKEN`). Before DELETE-type actions, optionally fetch the message back. Write the code so a later switch to HMAC (`X-Sendblue-Signature`) is a small change.
5. **Ack fast.** Return 200 well under 5 s (Blooio times out at 5 s; Sendblue at 45 s). Hand processing to the background (Vercel `waitUntil`/`after()` or a queue; confirm with the Vercel docs research). Dedupe on `(provider, providerMessageId)` with a DB unique constraint, since all three are at-least-once.
6. **Debounce is mandatory.** Sendblue sends one webhook per attachment, so a photo, a caption and a second photo arrive as 2–3 webhooks. The 4 s per-user debounce merges them.
7. **Download media immediately** in the background job (Linq URLs die in 1 h; Sendblue's in 30 days). Store it in Blob, convert **HEIC→JPEG**, and resize. Keep provider URLs out of logs.
8. **Outbound media.** Send public, unsigned Vercel Blob URLs with a file extension, or use Sendblue `/api/upload-file`. Do not send S3 presigned URLs to Sendblue.
9. **No SDK auto-retry on sends.** Set `maxRetries: 0` for `messages.send`, and use `GET /api/status?handle=` to reconcile. Pass our own idempotency key where the provider supports one (Linq, Blooio).
10. **Proactive messaging vs plan limits.** On the AI Agent plan, a check-in sent >24 h after the user's last message counts against **200 follow-up contacts/day/line**. Set the "global daily cap per sending number" default to ≤200 out-of-window contacts. Track `lastInboundAt` per user to classify each proactive send. Branch on `error_key` (`OPTED_OUT`, `LINE_*_LIMIT_REACHED`, `PRE_REPLY_*`) and treat these as non-retryable. Note the daily reset is 3 AM ET.
11. **STOP/START/HELP.** The providers (Sendblue, Linq) enforce opt-out themselves. Our STOP handler must mirror their state, expect our confirmation reply to be blocked (handle `OPTED_OUT` gracefully), and re-enable on START. Optionally sync with `POST /api/v2/contacts/opt-out`. Don't spend a send on HELP for an opted-out user.
12. **Groups.** Drop them (Sendblue `group_id !== ''` or `message_type==='group'`; Linq `chat.is_group`; Blooio `is_group`) with a 200 and no turn.
13. **Inbound tapbacks.** The Sendblue payload shape is unknown, so add a guard that recognizes reaction-like events and does not start an agent turn. Linq and Blooio send explicit reaction events.
14. **Env vars for `.env.example`:** `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET`, `SENDBLUE_WEBHOOK_PATH_TOKEN`, `SENDBLUE_API_BASE_URL` (optional). Map them explicitly in code rather than relying on the SDK's `SENDBLUE_API_API_KEY` defaults.
15. **Ops hooks.** Subscribe to the `line_blocked` webhook and poll `GET /api/v2/lines/state` on a schedule. Show both on `/admin`.
16. **Read receipts.** Gate them behind config, because they need Sendblue support to enable them. Prefer the account-level auto-mark-read setting over per-message calls.

## Open questions for the product owner

1. **Which Sendblue plan and line will we use?** The AI Agent plan is about $100/line/month, inbound-first, with the 200/day follow-up cap. Blue Ocean/dedicated plans have new-contact caps. The free sandbox may not allow webhooks or outbound messages. This decides whether proactive check-ins at scale need more than one line. It's a spend decision, so I can't pick a default.
2. **Should we ask Sendblue support** (a) to enable `/api/mark-read` or auto-mark-read on the account, (b) to confirm the exact webhook auth header or whether HMAC signing is available, and (c) whether their automatic STOP handling sends its own confirmation text and can be disabled so we control the reply? These need someone with account access.

## Risks

- **Weak webhook auth (Sendblue).** A static shared secret in a header has no body integrity or replay protection, and the header name rests on [search] only. A leaked secret means anyone can forge inbound messages, including DELETE commands. Mitigate with the path token, optional fetch-back, and a DELETE confirmation step (already in the spec).
- **Docs vs SDK conflicts:** base URL `.co` vs `.com`; retry rules (5xx only vs any non-200); status enum lists; free-plan capabilities; `error_code` 429 vs 4009/4010 (the pre-reply codes are 4009/4010; the line-cap codes are still body 429).
- **Duplicate outbound texts** from SDK auto-retries on a non-idempotent send.
- **Unknown inbound shapes:** the caption/attachment split, inbound tapbacks, and the `accountEmail` casing. Capture real payloads in milestone 6 before finalizing the Zod schemas, and make the schemas `passthrough`/lenient.
- **HEIC images** may break the vision pipeline if conversion isn't handled.
- **Plan limits** (200 follow-ups/day/line, 3 AM ET reset) can silently cap proactive features. Users can also be "new contacts" again after 30 days of silence on Blue Ocean-type plans.
- **Typing indicators** are best-effort. They can report `SENT` and show nothing, can 503 during firmware rollout, and need a recent conversation.
- **Provider-enforced opt-out** can block replies our state machine expects to send.
- Every docs site (docs.sendblue.com, docs.linqapp.com, docs.blooio.com) was unreachable from this container. All [search] facts need checking against the live pages before coding.
- **Linq:** 1-hour inbound media URLs need prompt download. Blooio: the signature scheme conflicts between docs and code.

## Sources

- https://www.npmjs.com/package/sendblue (v3.21.1 tarball: README.md, src/client.ts, src/resources/**, CHANGELOG.md)
- https://github.com/sendblue-api/sendblue-ts
- https://raw.githubusercontent.com/sendblue-api/sendblue-ts/main/api.md
- https://raw.githubusercontent.com/sendblue-api/sendblue-ts/main/.stats.yml
- https://www.npmjs.com/package/@sendblue/cli (v0.10.0: README.md, dist/lib/api.js, dist/commands/webhooks.js)
- https://pypi.org/project/sendblue/ (v1.33.0 wheel; https://github.com/sendblue-api/sendblue-py)
- https://docs.sendblue.com/getting-started/webhooks/
- https://docs.sendblue.com/getting-started/receiving-messages/
- https://docs.sendblue.com/getting-started/sending-messages
- https://docs.sendblue.com/getting-started/groups/
- http://docs.sendblue.com/security/
- https://docs.sendblue.com/limits
- https://docs.sendblue.com/api-v2/typing-indicators/
- https://docs.sendblue.com/guides/typing-indicator/
- https://docs.sendblue.com/api-v2/reactions/
- https://docs.sendblue.com/api-v2/read-receipts/
- http://docs.sendblue.com/api-v2/media/
- http://docs.sendblue.com/api-v2/
- https://docs.sendblue.com/api-v2/verify/
- https://docs.sendblue.com/guides/chat-sdk-adapter/
- https://docs.sendblue.com/api/resources/messages/methods/send/
- https://docs.sendblue.com/api/resources/webhooks/methods/list
- https://docs.sendblue.com/guides/contact-card/
- https://docs.sendblue.com/api/resources/contacts/methods/update/
- https://www.sendblue.com/pricing
- https://www.sendblue.com/api
- https://www.sendblue.com/features/webhooks
- https://www.sendblue.com/blog/imessage-webhook-integration
- https://www.npmjs.com/package/chat-adapter-sendblue (third-party, corroboration only)
- https://www.npmjs.com/package/@volter/twin-sendblue (third-party; HMAC scheme explicitly not vendor-specified)
- https://www.npmjs.com/package/@linqapp/sdk (v0.78.0: src/client.ts, src/resources/webhooks.ts, webhook-subscriptions.ts, webhook-events.ts, chats/*, messages/messages.ts, attachments.ts, shared.ts)
- https://github.com/linq-team/linq-node
- https://www.npmjs.com/package/@linqapp/chat-sdk-adapter (v0.5.1: README.md, dist/verification.js)
- https://docs.linqapp.com/channel/imessage/guides/platform/rate-limits/
- https://docs.linqapp.com/channel/imessage/error/codes/1xxx/1007/
- https://linqapp.com/s/pricing
- https://www.npmjs.com/package/eve-channel-blooio (v0.3.0: README.md, dist/verify.js, dist/api.js, dist/inbound.js; https://github.com/Blooio/eve-channel-blooio)
- https://www.npmjs.com/package/@blooio/sdk (v0.0.2, legacy v1 API)
- https://www.npmjs.com/package/chat-adapter-blooio (third-party, corroboration only)
- https://docs.blooio.com/
- https://docs.blooio.com/guides/send-imessage-api-nodejs
- https://docs.blooio.com/guides/imessage-rest-api
- https://blooio.com/integrations/eve
- https://blooio.com/pricing
- https://blooio.com/integrations/api

## Critic addendum (2026-10-29)

Completeness-critic pass, appended to this file without changing the content above. Tags as above.

**1. Webhook auth header: still not primary, now more corroborated.** `eve-channel-sendblue@0.4.0` is a **third-party** package (author Alex Patow, repo `alexpatow/eve-channel-sendblue`, not the Sendblue org). Its `dist/index.js` sets `DEFAULT_WEBHOOK_SECRET_HEADER = "sb-signing-secret"`, reads `SENDBLUE_WEBHOOK_SECRET`, compares with `crypto.timingSafeEqual`, and **fails closed** when no secret is configured. That makes two independent third-party implementations (`chat-adapter-sendblue`, `eve-channel-sendblue`) agreeing with the [search] summary of docs.sendblue.com/security. The official packages from Sendblue's maintainer (`sendblue@3.21.1`, `sendblue-mcp@2.1.0`, `@sendblue/cli@0.10.0`) contain **no** webhook-verification code. `sendblue-ts/.stats.yml` contains only `configured_endpoints: 54`, with no `openapi_spec_url`, so there is no official spec to check webhook headers against [sdk-source]. **Still confirm with one live delivery in milestone 6.** Keep the header name configurable, as the adapters do.

**2. Base URL confirmed** [sdk-source]. `sendblue@3.21.1` `src/client.ts` L234/L269: `baseURL = process.env['SENDBLUE_API_BASE_URL'] ?? https://api.sendblue.co`.

**3. Deletion at the provider (feeds the MHMDA processor-deletion duty in compliance.md §1.5)** [sdk-source, `src/resources/**`].
- **There is no endpoint to delete or redact messages or media.** The SDK's only `DELETE` routes are `/v3/auth/tokens/{id}`, `/api/lines/{n}/call-forwarding`, `/api/v2/totp/secrets/{id}`, `/api/account/webhooks`, `DELETE /api/v2/contacts/{phoneNumber}` ("Delete a specific contact") and bulk `DELETE /api/v2/contacts`.
- So a user's DELETE can remove the **contact** record at Sendblue, but not their message history or inbound media. That needs a support/DPA process, which is an open question for the owner.
- **Conflict risk:** the SDK says `PUT /api/v2/contacts/{phone}` updates "the same recipient record used for inbound keyword opt-outs" (§9 above). Deleting the contact may therefore also erase Sendblue's STOP block. Don't delete the contact for a user who is opted out, or re-apply `POST /api/v2/contacts/opt-out` afterwards. The suppression record has to survive (compliance.md, open question 2).

**4. HEIC decoding: the default image library cannot do it** [sdk-source].
- `sharp@0.35.5` `lib/index.d.ts` L823: "Support for patent-encumbered HEIC images requires the use of a globally-installed libvips compiled with support for libheif, libde265 and x265."
- The prebuilt binary that Vercel's Linux x64 runtime would use, `@img/sharp-libvips-linux-x64@1.3.4`, lists `heif 1.23.5` and `aom 3.15.1` in `versions.json`, with **no libde265 or x265**. Prebuilt sharp therefore handles the HEIF container with AV1 (AVIF) only, not HEVC-coded HEIC.
- sharp's install docs point to a community `sharp-heic-lambda-layer` for HEIC, which is consistent with this.
- I did not run a decode against a real HEIC file. That is an inference from the shipped library list plus sharp's own docstring.
- **Options:**
  - (a) A WASM decoder, `heic-convert@2.1.0` (ISC) → `heic-decode@2.1.0` → `libheif-js@1.23.5` (**LGPL-3.0**). Whether it bundles an HEVC decoder is unverified, so test it.
  - (b) A custom libvips build.
  - (c) Confirm whether Sendblue already delivers JPEG (unknown).
  - HEVC is patent-encumbered (sharp's word), so the owner may want counsel's view on shipping a decoder.
- **Architecture impact now:** the media pipeline needs a format-sniffing step and a pluggable `HeicDecoder`. Add a HEIC fixture to `fixtures/` in milestone 1. The simulator should also accept HEIC uploads to exercise this path.

**5. Cross-note contradiction: outbound images vs private storage.**
- §3 above says Sendblue `media_url` must be publicly fetchable, and that "Signed URLs are not supported" [search].
- vercel-next.md §5/§7 says store photos in a **private** Blob store and serve them only via an authenticated route or a short-lived presigned URL.
- anthropic.md §3.1 says send images to Claude as base64, not URLs.
- Inbound health photos stay private either way. The SPEC also requires outbound images, though. **Resolution to log in DECISIONS.md:** outbound images (if any, e.g. a weekly-recap chart) go either through `POST /api/upload-file` (multipart, returns a Sendblue `media_url`) or into a **separate public Blob store holding only non-health, non-identifying assets**. A user's meal photo must never be re-sent through a public URL.

**6. Cross-note tension: the STOP confirmation.**
- compliance.md §4.2 allows exactly one confirmation text, sent within 5 minutes.
- §9 above says Sendblue blocks sends to opted-out recipients (`error_key: OPTED_OUT`), and it is unknown whether Sendblue sends its own confirmation.
- If Sendblue auto-confirms, our confirmation would be a forbidden second message. If it blocks us, ours can't be sent at all.
- **Default until confirmed:** attempt one confirmation and treat `OPTED_OUT` as "already confirmed by provider". Record either outcome in `messaging_state.stop_confirmation_sent_at`. This stays an owner/Sendblue-support question (open question 2(c) above).

Sources for this addendum:
- https://www.npmjs.com/package/eve-channel-sendblue (v0.4.0 tarball `dist/index.js` L119-190, L369-380; `dist/index.d.ts` L83-97)
- https://www.npmjs.com/package/sendblue (v3.21.1 tarball `src/client.ts`, `src/resources/contacts/contacts.ts` L76-86, `src/resources/contacts/bulk.ts` L37)
- https://www.npmjs.com/package/sendblue-mcp (v2.1.0; no webhook code)
- https://raw.githubusercontent.com/sendblue-api/sendblue-ts/main/.stats.yml
- https://www.npmjs.com/package/sharp (v0.35.5 tarball `lib/index.d.ts` L823, `package.json` optionalDependencies)
- https://www.npmjs.com/package/@img/sharp-libvips-linux-x64 (v1.3.4 `versions.json`)
- https://raw.githubusercontent.com/lovell/sharp/main/docs/src/content/docs/install.md (AWS Lambda section, HEIC layer link)
- https://www.npmjs.com/package/heic-convert , https://www.npmjs.com/package/heic-decode , https://www.npmjs.com/package/libheif-js (npm metadata only)
