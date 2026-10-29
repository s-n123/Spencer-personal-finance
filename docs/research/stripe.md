# Stripe: in-app free trial, then a subscription via a Checkout link sent by text

Retrieved: 2026-10-29

**TL;DR.** Use `stripe@23.0.1`, which pins API version **`2026-09-30.endive`**. Construct the client lazily with `new Stripe(key, { apiVersion: '2026-09-30.endive' })`. Run the trial in our own database (no Stripe objects, no card). When the trial ends, or the user asks to subscribe, text a short link on our own domain such as `https://<app>/pay/<token>`. When it is clicked, that route creates (or reuses) a **Checkout Session in `subscription` mode** and returns a 303 redirect to `session.url`. We redirect on click because a Checkout Session lives **at most 24 hours (minimum 30 minutes, default 24 hours)**, and SMS links are often clicked days later. Payment Links never expire, but they cannot attach an existing Customer, cannot carry per-user metadata or `trial_end`, and take `client_reference_id` only as a client-editable URL param. Our webhook is a Node-runtime route handler. It reads `await req.text()` and the `stripe-signature` header, then calls `stripe.webhooks.constructEvent` (default tolerance **300 s**). It dedupes on `event.id` and re-fetches the Subscription so out-of-order events are harmless. It upserts status and `items.data[].current_period_end`; that field moved off the Subscription object. Grant access for `trialing` and `active`, plus a configurable grace window for `past_due`. Gate access for `unpaid`, `canceled`, `incomplete`, `incomplete_expired` and `paused`. Never gate STOP/HELP/DELETE or safety replies. Card updates and cancellation go through a **Billing Portal session created on click** (`/billing/<token>`), because portal URLs are short-lived. Test with the CLI (`stripe listen --forward-to … --latest`), test clocks and the decline-after-attach card.

Tag legend: **[primary]** = read on an official doc page myself (Vercel docs via the Vercel docs MCP). **[sdk-source]** = read from the `stripe@23.0.1` npm tarball (`npm pack`, files under `esm/`), from the official Stripe OpenAPI spec (`github.com/stripe/openapi`, `latest/openapi.spec3.json`, `info.version = 2026-09-30.endive`), or from official Stripe source on GitHub (stripe-node examples, stripe-cli). **[search]** = only from a WebSearch summary of docs.stripe.com, support.stripe.com or third-party pages; **re-verify before coding**. docs.stripe.com could not be fetched directly from this container (DNS blocked).

---

## 0. Conflicts, staleness and surprises found

| Topic | Finding | Resolution |
|---|---|---|
| `payment_method_types` on Checkout | **Removed** from `Checkout.SessionCreateParams` in stripe-node 23.0.0 / API endive [sdk-source: CHANGELOG 23.0.0]. Replaced by `allowed_payment_method_types` (a filter over dynamic payment methods) or `excluded_payment_method_types` [sdk-source]. Still present on `PaymentLinkCreateParams` [sdk-source]. | Don't pass `payment_method_types` to Checkout. Manage methods in the Dashboard, or pass `allowed_payment_method_types: ['card','link']`. |
| `ui_mode` values | Enum is now `'elements' \| 'embedded_page' \| 'form' \| 'hosted_page'`, default `hosted_page` [sdk-source]. The old `hosted`, `embedded` and `custom` values error since dahlia (2026-03-25) [search: changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes]. | Omit `ui_mode`, so we get hosted. Older blog posts using `ui_mode: 'hosted'` will fail. |
| Subscription period fields | `Subscription` has **no** `current_period_end`. It lives on `SubscriptionItem.current_period_end` [sdk-source: `Subscriptions.d.ts`, `SubscriptionItems.d.ts:54`]. `SubscriptionListParams.current_period_end` filters on the "minimum item current_period_end" [sdk-source]. | Read `sub.items.data[0].current_period_end` (we have one item). |
| Invoice → subscription link | `Invoice` has no top-level `subscription` field. It is `invoice.parent.subscription_details.subscription` (`parent.type === 'subscription_details'`) [sdk-source: `Invoices.d.ts:349,852-867`]. | Use the `parent` path in `invoice.*` handlers. |
| Billing mode default | `subscription_data.billing_mode.type`: "If no value is passed, the default is `flexible`" [sdk-source]. That has been the API default since `2025-09-30.clover` [search: changelog/clover/2025-09-30/billing-mode-default-flexible]. | Fine. Note that pause and trial offers require flexible mode [search]. |
| `subscriptions.pause` | The search summary called the pause endpoint "public preview", citing the dahlia changelog of 2026-05-27. But `POST /v1/subscriptions/{subscription}/pause` is in the GA OpenAPI spec for `2026-09-30.endive`, and `stripe.subscriptions.pause()` is in GA SDK 23.0.0 [sdk-source]. | Treat it as GA in endive. We don't need it anyway. |
| `paused` status meaning | SDK doc-comment: "A subscription can only enter a `paused` status when a trial ends without a payment method" [sdk-source]. Yet `Subscription.status_details.paused.subscription.type` enumerates `final_payment_failure`, `first_payment_failure`, `pause_requested`, `system` and `trial_end_without_payment_method` [sdk-source]. A Dashboard setting can also pause on payment failure [search: billing/revenue-recovery/smart-retries/pause-on-payment-failure]. | The doc-comment is stale. `paused` can come from several causes. Gate on `paused` whatever the cause. |
| `constructEvent` tolerance `0` | Since 23.0.0, `tolerance = 0` **skips** the timestamp check; before, it used the default. `verifyHeader()` now defaults to 300 s instead of skipping [sdk-source: CHANGELOG 23.0.0 #2876]. | Never pass `0` in production. Omit the argument (300 s). |
| Portal session URL lifetime | API reference says only "short-lived; will expire if the customer does not visit the URL". An old page said 5 min unvisited and 1 h after last activity [search]. | Never store or text a raw portal URL. Create it on click. |
| Trial-will-end timing | `customer.subscription.trial_will_end` fires 3 days before trial end by default (a Dashboard setting). Stripe's own reminder email goes out 7 days before, or immediately for trials under 7 days [search]. | Only relevant if we create Stripe-side trials (see §2.6). |

---

## 1. SDK, API version and client construction

- **Package:** npm `stripe`, dist-tag `latest = 23.0.1` (published 2026-10-22). Other tags: `public-preview` = `23.1.0-beta.2`, `private-preview` = `23.1.0-alpha.4` [sdk-source: `npm view stripe`]. Engines: **Node ≥ 20**; Node 18 support was dropped in 23.0.0 [sdk-source: package.json, CHANGELOG]. Zero runtime dependencies.
- **Pinned API version:** `esm/apiVersion.js` exports `ApiVersion = '2026-09-30.endive'` and `ApiMajorVersion = 'endive'` [sdk-source]. CHANGELOG 23.0.0 (2026-09-30): "This release changes the pinned API version to `2026-09-30.endive`." The tarball's `OPENAPI_VERSION` is `v2526`.
- **Typing:** `StripeConfig.apiVersion?: LatestApiVersion`, where `LatestApiVersion = typeof ApiVersion`. Passing any other string is a TS error. The types reflect only the latest API version [sdk-source: `lib.d.ts`, README].
- **Import / construct** [sdk-source: README]:
  - `import Stripe from 'stripe'` (default import, not `* as Stripe`), then `new Stripe(key, config)`.
  - README warning: since v17, constructing at module top level without the key fails during a build step. **Instantiate lazily**, with a `getStripe()` singleton that reads `process.env.STRIPE_SECRET_KEY`.
- **Config options and defaults** [sdk-source: README table, `lib.d.ts`]:
  - `apiVersion` defaults to the pinned version.
  - `maxNetworkRetries` defaults to **1**. Exponential backoff; idempotency keys are auto-added on retried POSTs. Even with `0`, one retry happens on `ECONNRESET`/`EPIPE`.
  - `timeout` defaults to **80000 ms**.
  - `telemetry` defaults to `true`.
  - `httpClient` can be `Stripe.createFetchHttpClient()`.
  - `appInfo`, `stripeAccount`/`stripeContext` (Connect, not needed).
- **Per-request options** (`RequestOptions`): `idempotencyKey`, `timeout`, `maxNetworkRetries`, `apiVersion`, `apiKey`.
- **Idempotency keys:** up to 255 chars. Stripe keeps them **at least 24 h**, then may delete them [search: api/idempotent_requests].
- **Recommended construction for us:**
  ```ts
  new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-09-30.endive',
    maxNetworkRetries: 2,
    timeout: 20_000,
  })
  ```
  Pass `apiVersion` explicitly, even though it equals the default, so an SDK bump can't silently change the version.
- **Entry points:** `package.json#exports` maps `worker`, `workerd`, `browser`, `deno` and `bun` to `stripe.esm.worker.js` (Web crypto). The default (Node) entry uses Node crypto [sdk-source]. On the Node runtime the sync `constructEvent` works. On a Web-crypto runtime (Edge), use `await constructEventAsync(...)`, optionally with `Stripe.createSubtleCryptoProvider()` [sdk-source: `Webhooks.js` throws `CryptoProviderOnlySupportsAsyncError` with that hint].
- **Errors:** `Stripe.errors.*`, including `StripeCardError`, `StripeInvalidRequestError`, `StripeAPIError`, `StripeAuthenticationError`, `StripeRateLimitError`, `StripeConnectionError`, `StripeSignatureVerificationError` and `StripeIdempotencyError` [sdk-source: `Error.d.ts`]. Since 23.0.0, truncated response bodies throw `StripeConnectionError` instead of `StripeAPIError`.
- **Notices:** the SDK prints `Stripe-Notice` header notices for test/sandbox calls. Set `STRIPE_SUPPRESS_NOTICES=true` to silence them outside agent environments [sdk-source: README, CHANGELOG 23.0.0].
- **Typed events:** `Stripe.Event` is a discriminated union (`CheckoutSessionCompletedEvent`, `CustomerSubscriptionUpdatedEvent`, `InvoicePaidEvent`, …), so `switch (event.type)` narrows `event.data.object` [sdk-source: `stripe.core.d.ts`]. The SDK also ships "thin event" `EventNotification` handlers (`V1CheckoutSessionCompletedEvent`, …) for event destinations. **We use classic snapshot webhooks** via `constructEvent`, which throws if handed a `v2.core.event` thin payload [sdk-source: `Webhooks.js`].

## 2. Checkout Sessions in `subscription` mode

Endpoint: **`POST /v1/checkout/sessions`** → `stripe.checkout.sessions.create(params, { idempotencyKey })` [sdk-source]. Related endpoints:
- `GET /v1/checkout/sessions/{session}` (`retrieve`)
- `POST /v1/checkout/sessions/{session}/expire` (`expire`; only for `status: 'open'`)
- `GET /v1/checkout/sessions` (`list`): filters `customer`, `customer_details.email`, `payment_link`, `status` (`open|complete|expired`), `subscription`, `created`
- `GET …/{session}/line_items`

The OpenAPI schema for create has **no `required` list**. All constraints are semantic and come from the param descriptions [sdk-source: spec3.json].

### 2.1 Parameters we use (all [sdk-source] unless noted)

| Param | Exact semantics / limits |
|---|---|
| `mode: 'subscription'` | "Pass `subscription` if the Checkout Session includes at least one recurring item." Enum `payment \| setup \| subscription`. |
| `line_items[]` | "Required for `payment` and `subscription` mode." Each item takes `price` (ID) or `price_data` (one of the two required), plus `quantity`. Subscription mode allows **max 20 recurring-price line items and 20 one-time line items**; one-time items go on the first invoice only. `price_data.recurring.interval` is `day\|week\|month\|year`, with `interval_count` up to 3 years. Use a Dashboard-created Price ID (`STRIPE_PRICE_ID` env). |
| `client_reference_id` | String, **maxLength 200** (OpenAPI). "Can be a customer ID, a cart ID, or similar… reconcile the Session with your internal systems." Returned on the Session and in `checkout.session.completed`. Not copied to the Subscription. Set it to our `users.id` UUID. |
| `customer` | ID of an existing Customer. In subscription mode, Checkout uses the customer's default card if it has a valid billing address, name and email. If the Customer has a valid email, it is **prefilled and not editable**. If not, "Checkout will set the email entered during the session on the Customer". **If blank in subscription mode, Checkout creates a new Customer** every completed session. |
| `customer_email` | Prefills the email of the Customer that Checkout creates. Only meaningful when `customer` is absent. It does **not** link to an existing customer with that email [search: no source says it does]. |
| `customer_creation` | `always \| if_required`. **"Can only be set in `payment` and `setup` mode."** Not applicable to us: subscription mode always has or creates a Customer. |
| `customer_update` | `{ address?, name?, shipping? }`, each `auto \| never` (default `never`). **Only with `customer`.** Use `address: 'auto'` if Stripe Tax is enabled, so the collected billing address is saved. |
| `metadata` | On the **Session only**. Shows up in `checkout.session.*` events. Not copied to the Subscription [sdk-source description; search: metadata/use-cases]. |
| `subscription_data.metadata` | Set on the **Subscription** that Checkout creates, so it appears in `customer.subscription.*` events. Subscription metadata is snapshotted onto each invoice at finalization as `invoice.parent.subscription_details.metadata` [sdk-source: `Invoices.d.ts:854`]. Put `user_id` here too, so subscription and invoice events map back to us without the Session. |
| Metadata limits | 50 keys, key ≤ 40 chars, value ≤ 500 chars, no `[`/`]` in keys [search: docs.stripe.com/metadata]. **Never put health data in Stripe metadata.** Use the internal UUID only. |
| `success_url` | Optional in the schema. Not allowed for `embedded_page`/`elements`. Supports the literal **`{CHECKOUT_SESSION_ID}`** template variable, which Stripe substitutes on redirect [search: payments/checkout/custom-success-page]. Use `https://<app>/pay/done?session_id={CHECKOUT_SESSION_ID}`. The page should say "You're all set, head back to iMessage". **Never provision from the success page; use the webhook.** |
| `cancel_url` | Optional. If set, Checkout shows a back button. Use `https://<app>/pay/cancelled`. |
| `expires_at` | Unix seconds. **"Anywhere from 30 minutes to 24 hours after Checkout Session creation. By default, this value is 24 hours from creation."** (OpenAPI description) The Session `url` "is only present when the session is active". This is why we do not text a Session URL directly. |
| `after_expiration.recovery` | `{ enabled: boolean, allow_promotion_codes?: boolean }`. On expiry, `after_expiration.recovery.url` and `.expires_at` are populated. The recovery URL creates a copy of the expired session and is valid **30 days** [search: payments/checkout/abandoned-carts]. Not needed with our on-click redirect. |
| `allow_promotion_codes` | Boolean: user-redeemable promotion codes. Alternatively `discounts: [{ coupon } \| { promotion_code }]` (max one). |
| `payment_method_collection` | `always \| if_required`. **"Can only be set in `subscription` mode. Defaults to `always`."** With `if_required`, Checkout skips the card when the total due is 0 (free trial or 100% discount). Keep the default `always`. We want a card at checkout. |
| `subscription_data.trial_period_days` | Integer **≥ 1**. |
| `subscription_data.trial_end` | Unix ts, **"at least 48 hours in the future"**. |
| `subscription_data.trial_settings.end_behavior.missing_payment_method` | `cancel \| create_invoice \| pause`. Required inside `trial_settings`. Only matters for card-less Stripe trials. |
| `subscription_data.description` | Shown in the portal. |
| `subscription_data.billing_mode` | `{ type: 'classic' \| 'flexible' }`, default `flexible`. |
| `phone_number_collection.enabled` | Payment and subscription modes only. Not needed: we already know the phone. |
| `consent_collection.terms_of_service: 'required'` | Needs a ToS URL in Dashboard public settings. Also `promotions: 'auto'` (US only). |
| `automatic_tax: { enabled }` | Checkout then collects the billing address needed for tax (§8). |
| `billing_address_collection` | `auto \| required`, default `auto`. |
| `allowed_payment_method_types` / `excluded_payment_method_types` | Filters over the dynamic payment-method set. Apple Pay works on hosted Checkout "with no additional configuration" [search: docs.stripe.com/apple-pay]. Unverified: whether wallets count under `card` for this filter. |
| `locale` | `auto` by default (browser locale). |
| `origin_context` | `mobile_app \| web`, "informs the optimizations". Leave unset: SMS links open in Safari. |
| `ui_mode` | Leave unset (`hosted_page`). |

### 2.2 Session object fields we read [sdk-source]
- `id`, `status` (`open|complete|expired`)
- `payment_status` (`paid|unpaid|no_payment_required`)
- `mode`, `client_reference_id`, `metadata`
- `customer` (string | Customer), `customer_details` (email/phone/address)
- `subscription` (string | Subscription), `invoice`
- `expires_at`, `url` (null once inactive)
- `livemode`, `payment_link` (set if the session came from a Payment Link)
- `after_expiration.recovery.{url,expires_at}`

### 2.3 Recommended `/pay/<token>` flow (our design, built from the facts above)
1. The token is a ≥128-bit random value. Store **only its hash**, along with `user_id`, `purpose`, `expires_at` (config, e.g. 30 days) and `used_at`. The link is our own domain, so it is short and branded (§8).
2. On `GET /pay/<token>`:
   - If the token is invalid or expired → friendly page: "Text us 'subscribe' for a fresh link".
   - If the user's local subscription status is already `active`/`trialing` → page: "You're already subscribed", with a link to `/billing/<token>`.
   - If an **open** Checkout Session we created for this user has `expires_at > now + 10 min` → 303 to its stored `url`. This makes repeated or preview fetches cheap and idempotent (§8).
   - Otherwise:
     - Ensure a Stripe Customer exists: `customers.create({ metadata: { user_id } })`, stored as `users.stripe_customer_id`. Creating it ourselves avoids a duplicate Customer per session and lets test clocks attach.
     - **Expire any older open sessions** for this user with `checkout.sessions.expire`, so two sessions can't both complete and create two subscriptions.
     - Create the session:
       ```ts
       {
         mode: 'subscription',
         customer,
         client_reference_id: userId,
         line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
         metadata: { user_id },
         subscription_data: { metadata: { user_id } /*, trial_end? */ },
         success_url,
         cancel_url,
         allow_promotion_codes,
       }
       ```
       Use `idempotencyKey` = `checkout:<userId>:<10-min bucket>`.
     - Store `id`/`url`/`expires_at` and 303-redirect.
3. **Optional Dashboard setting:** "Limit customers to one subscription" redirects already-subscribed customers to the portal. It detects them by the `customer` passed, or by email. It **requires the portal login link to stay enabled** [search: payments/checkout/limit-subscriptions]. Our own check in step 2 covers most cases. Keep a webhook-side guard as well: if `checkout.session.completed` arrives for a user who already has an active subscription, alert and cancel the duplicate.

### 2.4 Lifecycle events from a subscription-mode Checkout
- **Card payment:** the session completes only after the first invoice is paid. `checkout.session.completed` arrives with `payment_status: 'paid'`. Stripe also emits `customer.subscription.created`, `invoice.paid` and so on, **in no guaranteed order** (§4).
- **Delayed-notification methods** (bank debits): `payment_status` may be `unpaid` at completion. Then wait for `checkout.session.async_payment_succeeded` or `invoice.paid` [search: get-started/use-cases/saas-subscriptions]. Restricting to card and wallets avoids this path.

### 2.5 Free-trial variants in Stripe (for reference)
- **Card-less Stripe trial via Checkout:**
  - Set `payment_method_collection: 'if_required'` plus `subscription_data.trial_period_days`/`trial_end` and `trial_settings.end_behavior.missing_payment_method: 'cancel' | 'pause'`.
  - `create_invoice` is the default and can leave the subscription `past_due` [search: payments/checkout/free-trials, billing/subscriptions/trials].
  - Under `pause`, the subscription stays `paused` indefinitely until a payment method is added and it is resumed. `customer.subscription.resumed` fires on resume [search].
  - Stripe checks `default_payment_method`/`default_source` on the subscription and the customer to decide whether a payment method exists [search].
- **Trial Offers** (`ProductCatalog.TrialOffer`, `/v1/product_catalog/trial_offers`):
  - GA in endive [sdk-source: OpenAPI path; search: changelog/endive/2026-09-30/trial-offer-ga].
  - Per-item trial price and length. Flexible billing mode only. Can't be combined with legacy subscription-level trials.
  - **Checkout support is still private preview** (`2026-09-30.preview`) [search]. Not usable for us.

### 2.6 Our trial design decision (to log in DECISIONS.md)
- **Default: the trial lives in our DB** (`users.trial_started_at`, `trial_ends_at`, configurable length). No card, no Stripe objects until the user subscribes. This keeps card-network trial rules out of scope during the trial, and Stripe never learns about non-paying users.
- **Optional "subscribe early, keep your remaining trial":** set `subscription_data.trial_end = trial_ends_at` only if that is ≥ 48 h away. Otherwise charge now.
  - This creates a Stripe-side trial **with a card on file**, so card-network trial compliance applies. Stripe sends a hosted reminder 7 days before trial end, or at trial start for trials under 7 days, when customer emails are enabled. "If you don't use these settings, you're still responsible for complying" [search: billing/subscriptions/trials/manage-trial-compliance].
  - Recommended default: carry the trial over, and **enable Stripe's trial reminder emails** in Dashboard → Billing → customer emails.
  - Under this variant, also handle `customer.subscription.trial_will_end`, which fires 3 days before by default.

## 3. Payment Links (alternative) vs our own redirect

Facts:
- `POST /v1/payment_links`. `line_items` is required (≤ 20, `price` + `quantity`) [sdk-source].
- Other params:
  - `after_completion: { type: 'redirect' | 'hosted_confirmation', redirect: { url } }`
  - `allow_promotion_codes`
  - `automatic_tax`
  - `customer_creation`
  - `metadata`: link-level, "automatically copied to checkout sessions created by this payment link"
  - `payment_method_collection`
  - `payment_method_types`: still exists here
  - `restrictions.completed_sessions.limit`: auto-deactivates after N completed sessions
  - `subscription_data: { description, invoice_settings, metadata, trial_period_days (≥1), trial_settings }`. **No `trial_end`.**
  - `inactive_message`
  - `active` (on update)
- **No `customer` and no `expires_at` params** [sdk-source: `PaymentLinks.d.ts`].
- **Expiry:** Payment Links don't expire unless deactivated (`active: false` → the visitor sees a deactivation page). They can't be deleted [search: support.stripe.com, api/payment-link].
- **URL params** [search: docs.stripe.com/payment-links/url-parameters, /customize]:
  - `?client_reference_id=`: alphanumeric, `-` and `_`, ≤ 200 chars. **Invalid values are silently dropped.** Not shown to the customer. Included in `checkout.session.completed`. Stripe warns against putting secrets in it.
  - `prefilled_email` (editable) and `locked_prefilled_email` (not editable; takes precedence).
  - `prefilled_promo_code`: alphanumeric; only if promo codes are enabled on the link.
  - `locale`.

| | Payment Link + `?client_reference_id=` | Our `/pay/<token>` → fresh Checkout Session |
|---|---|---|
| Staleness | Never expires | Session created at click time, so the 24 h limit never bites |
| Existing Customer | Not possible: a new Customer per purchase | `customer` passed, so resubscribes reuse the Customer, card and history |
| Per-user data | Link-level metadata only. Client-editable `client_reference_id`, so a user could alter it | `client_reference_id` and metadata are set server-side, so they can't be tampered with |
| Trial carry-over | `trial_period_days` only, fixed per link | Per-user `trial_end` |
| Already-subscribed guard | Only the Dashboard "one subscription" setting, by email | Our check before redirect |
| URL | `buy.stripe.com/...` | Our branded domain (good for SMS filters and user trust) |
| Moving parts | None on our side | Token table, one route, Stripe call on click. Must handle link-preview fetches (§8) |

**Recommendation:** our own redirect. A Payment Link is acceptable only as an emergency fallback, using an opaque per-user token in `client_reference_id`, never the raw user ID.

## 4. Webhooks

### 4.1 Endpoint and verification
- **Route:** `app/api/webhooks/stripe/route.ts`, `export const runtime = 'nodejs'`, `POST` only.
- **Official stripe-node Next.js App Router example** [sdk-source: `examples/webhook-signing/nextjs/app/api/webhooks/route.ts`]:
  - Reads `(await headers()).get('stripe-signature')`.
  - Calls `stripe.webhooks.constructEvent(await req.text(), sig, process.env.STRIPE_WEBHOOK_SECRET)`.
  - Returns 400 on failure, 200 `{message:'Received'}` on success.
  - `req.headers.get('stripe-signature')` is equivalent.
  - Vercel's own docs use the same `await request.text()` raw-body pattern for App Router signature checks [primary: Vercel docs, webhooks-api].
- **Signature mechanics** [sdk-source: `Webhooks.js`, crypto providers]:
  - The header (`Stripe-Signature`, case-insensitive) is `t=<unix>,v1=<hex>[,v1=…]`.
  - The expected scheme is `v1`.
  - The signed payload is `` `${t}.${rawBody}` `` with **HMAC-SHA256** under the `whsec_…` secret, compared in constant time.
  - Any `v1` entry matching passes, which allows overlapping secrets during rotation.
  - The SDK warns if the secret contains whitespace, and since 23.0.1 rejects whitespace-only secrets.
  - Passing a parsed object instead of a string or Buffer triggers a dedicated error message.
- **Tolerance:** `Webhook.DEFAULT_TOLERANCE = 300` seconds. A timestamp older than the tolerance throws `Timestamp outside the tolerance zone`. `tolerance = 0` skips the check (23.x semantics) [sdk-source]. Signature: `constructEvent(payload: string | Uint8Array, header: string | string[] | Uint8Array, secret, tolerance?, cryptoProvider?, receivedAt?)`. There is an async twin, `constructEventAsync`.
- **Retries:** each retry gets a **new signature and timestamp** [search: docs.stripe.com/webhooks], so the 300 s tolerance doesn't break retries.
- **Unit tests:** `stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp? })`, or `generateTestHeaderStringAsync` [sdk-source: README, `Webhooks.d.ts`].
- **Optional hardening:** allowlist Stripe webhook IPs [search: webhooks/signature]. Not required, and brittle on Vercel.
- **Preview deployments with Vercel Deployment Protection:** Stripe can't send custom headers. Append `?x-vercel-protection-bypass=<secret>` to the endpoint URL ("Protection Bypass for Automation") [primary: Vercel docs, protection-bypass-automation].

### 4.2 Endpoint API version (important)
- `WebhookEndpoint.api_version`: "The API version that events are rendered as for this webhook endpoint. **You can't change this value after you create the endpoint.**" The create param takes an enum that includes `2026-09-30.endive` [sdk-source: `WebhookEndpoints.d.ts`, CHANGELOG 23.0.0].
- Create the production endpoint with `api_version: '2026-09-30.endive'` (via API, or by choosing the version in the Dashboard) so payloads match the SDK types.
- The CLI's `stripe listen` uses the **account default** version unless you pass `--latest` [sdk-source: stripe-cli `pkg/cmd/listen.go`].

### 4.3 Events to enable (all confirmed in the OpenAPI `enabled_events` enum [sdk-source])

| Event | Why / handling |
|---|---|
| `checkout.session.completed` | Link Stripe objects to our user: `client_reference_id` → `user_id`, `customer` → `stripe_customer_id`, `subscription` → `stripe_subscription_id`. Then re-fetch the subscription and upsert. If `payment_status === 'unpaid'` (async method), don't grant yet. |
| `checkout.session.expired` | Optional. Mark the stored session expired. |
| `checkout.session.async_payment_succeeded` / `_failed` | Only if non-card methods are enabled. |
| `customer.subscription.created` / `.updated` / `.deleted` | Main source of truth for status, `cancel_at_period_end`, `cancel_at`, `canceled_at`, `ended_at`, `trial_end`, `items.data[0].current_period_end` and `items.data[0].price.id`. `.deleted` = ended (`status: 'canceled'`). |
| `customer.subscription.paused` / `.resumed` | Gate or ungate. |
| `customer.subscription.trial_will_end` | Only if we create Stripe-side trials (§2.6). Check status and latest invoice before nudging [search]. |
| `invoice.paid` | Renewal succeeded. Stripe's guides say to continue provisioning on it, but check the subscription status rather than assuming active [search: billing/subscriptions/webhooks]. |
| `invoice.payment_failed` | The subscription moves toward `past_due`. Mention it in-thread on the user's next message, with a `/billing` link to update the card [search]. |
| `invoice.payment_action_required` | 3DS/SCA needed off-session. Same nudge. |
| `entitlements.active_entitlement_summary.updated` | Optional alternative gating via Stripe Entitlements [search: billing/entitlements]. Not needed with one product. |

### 4.4 Delivery semantics and idempotency [search: docs.stripe.com/webhooks, /webhooks/process-undelivered-events]
- **Retries:**
  - Live mode: retries on non-2xx or timeout **for up to 3 days with exponential backoff**.
  - Sandbox/test: **3 retries over a few hours**.
  - Manual resend: Dashboard ≤ **15 days**, CLI `stripe events resend` ≤ **30 days**. A manual resend does not cancel automatic retries.
- **Ordering:** **not guaranteed.** `created` is in seconds, so ties happen.
- **Duplicates:** possible, including *distinct* Event objects for the same change. Dedupe by `event.id`, and also by `data.object.id` + `type`. Skip already-processed events with 200.
- **Fast response:** "Quickly return a 2xx response" before complex logic, or the delivery times out.
- **Our handler pattern:**
  1. Verify; on failure return 400.
  2. `INSERT INTO stripe_events(id, type, created, livemode) ON CONFLICT DO NOTHING`. If it already existed and was processed → 200.
  3. For subscription-related events, **re-fetch** `stripe.subscriptions.retrieve(subId)` and upsert our row, so processing order doesn't matter.
  4. Return 200.
  - If step 3 throws, mark the event row failed and return 500, so Stripe retries for up to 3 days.
  - The work is one API call plus one upsert, well within a fast response. If it grows, move it to `after()`/a queue and keep the event row as an outbox.
  - Run a **daily reconciliation** cron (list subscriptions or recent events) to catch anything missed.
- **Mapping precedence:** `checkout.session.client_reference_id`, then `subscription.metadata.user_id`, then `users.stripe_customer_id`.

## 5. Customer portal (cancel / update card), link sent by text

- **Endpoint:** `POST /v1/billing_portal/sessions` → `stripe.billingPortal.sessions.create({ customer, return_url?, configuration?, flow_data?, locale? })` [sdk-source].
- **Session fields:** `url` ("The **short-lived** URL…", maxLength 5000), `return_url`, `flow`, `configuration`, `customer`, `livemode` [sdk-source]. Sessions "expire if the customer does not visit the URL". The older figure is ~5 min to first use and ~1 h after last activity [search]. **So: text `https://<app>/billing/<token>`, and on click create a portal session and 303 to it.**
- **Deep-link flows:** `flow_data.type` is one of `customer_update`, `payment_method_update`, `subscription_cancel` (requires `subscription_cancel.subscription`; optional `retention: { type: 'coupon_offer', coupon_offer: { coupon } }`), `subscription_update` or `subscription_update_confirm`. `flow_data.after_completion.type` is `hosted_confirmation | portal_homepage | redirect`, with `redirect.return_url` [sdk-source].
  - "Update my card" → `payment_method_update`.
  - "Cancel" → `subscription_cancel`.
  - Give the token a `purpose` field so each link opens the right flow.
- **Configuration:** `POST /v1/billing_portal/configurations`, or in the Dashboard. Test and live are separate configurations [search].
  - `features.payment_method_update.enabled`
  - `features.subscription_cancel: { enabled, mode: 'at_period_end' | 'immediately', proration_behavior, cancellation_reason: { enabled, options } }`
  - `features.invoice_history.enabled`
  - `features.customer_update: { enabled, allowed_updates: ['address','email','name','phone','shipping','tax_id'] }`
  - `features.subscription_update` (≤ 10 products)
  - `business_profile.{headline, privacy_policy_url, terms_of_service_url}`
  - `default_return_url`
  - `login_page.enabled`
  - Without `configuration`, sessions use the default config. `return_url` is required unless the config sets a default [search: customer-management/integrate-customer-portal].
- **Security:** a portal session grants full billing control. The token must be unguessable, single-user, short TTL (e.g. 24 h), and regenerated on each request. The iMessage thread is the auth factor. Stripe: "authenticate customers on your site before creating sessions" [search].
- **No-code alternative:** the portal login link is a static URL where the user signs in with email and a one-time passcode [search]. It is static but adds friction. It must stay enabled if we use the "limit to one subscription" setting.
- **Cancellation by text** is also possible directly: `stripe.subscriptions.update(id, { cancel_at_period_end: true })`, after a YES confirmation. Undo with `cancel_at_period_end: false`. Status stays `active` until period end, then `customer.subscription.deleted` fires.
- **`DELETE` command:** before wiping data, cancel any live subscription immediately (`stripe.subscriptions.cancel(id)`). Otherwise we keep charging a user we can no longer serve. Optionally delete the Stripe Customer (`customers.del`); Stripe retains required financial records.

## 6. Subscription statuses and access policy

Enum [sdk-source]: `active | canceled | incomplete | incomplete_expired | past_due | paused | trialing | unpaid`. The list filter also accepts `all` and `ended`.

Doc-comment semantics [sdk-source; search where noted]:
- `incomplete`: the first payment failed (charge_automatically). Only metadata and default_source can be updated. It becomes `incomplete_expired` (**terminal**; open invoice voided) if the first invoice is not paid **within 23 hours**.
- `trialing` moves to `active` when the trial ends with successful payment. Paid trials or non-zero trial offers may show `active`/`incomplete`/`past_due` instead [search].
- `active`: good standing, but "doesn't necessarily indicate that all outstanding invoices… have been paid" [search].
- `past_due`: payment required but failed. Stripe keeps retrying per the retry settings: Smart Retries' recommended default is **8 tries within 2 weeks**, configurable from 1 week to 2 months [search; the source was an off-session-payments page, so verify in the Dashboard]. After the final retry it becomes `canceled`, `unpaid`, stays `past_due`, or becomes `paused`, depending on the Dashboard's failed-payment settings [search: billing/revenue-recovery/smart-retries].
- `unpaid`: invoices are still created but not attempted. Stripe: "revoke access… when the subscription is unpaid" [search].
- `canceled`: terminal.
- `paused`: no invoices. Causes are in `status_details.paused.subscription.type` [sdk-source]. Resume with `POST /v1/subscriptions/{id}/resume`. Its `payment_behavior` defaults to `resume_on_payment_attempt`; `resume_on_payment_success` is recommended [search].

**Access policy (our default):**

| Status | Access | Text behavior |
|---|---|---|
| Our in-app trial, `now < trial_ends_at`, no subscription | Full | — |
| `trialing`, `active` | Full | If `cancel_at_period_end`, mention the end date once |
| `past_due` | **Full during a grace window** (config `PAST_DUE_GRACE_DAYS`, default 7, counted from the first failure) | Append one gentle "card issue" line with a `/billing` link, at most once per day |
| `incomplete` | Gated | "Payment didn't go through", with a fresh `/pay` link |
| `unpaid`, `canceled`, `incomplete_expired`, `paused`, or trial expired with no subscription | Gated | Graceful paywall reply (below) |

**Graceful gating rules (product):**
- **Never** gate: STOP, START, HELP, DELETE, the consent/onboarding flow, eating-disorder or medical-emergency safety responses, or a "what's my data" request.
- When gated, reply warmly in 1–2 bubbles: "Your free trial ended. Keep going for $X/mo: <link>". Rate-limit the paywall copy (config, e.g. full message at most once per 24 h; otherwise a one-liner).
- Don't run the vision model on gated turns (cost control). Keep the user's data so they can pick up where they left off.
- Mention the trial ending only inside user-initiated replies or opted-in check-ins. Never cold-message (SPEC).
- Store `subscription_status`, `current_period_end`, `cancel_at_period_end`, `trial_end` and `price_id` locally. Gating is decided from our DB on every turn, not by a Stripe API call.

## 7. Testing

- **Keys and modes:** test/sandbox keys are `sk_test_…`. Each sandbox has its own portal configuration and webhook endpoints [search]. Stripe doesn't send trial reminder emails in sandboxes [search].
- **Test cards** [search: docs.stripe.com/testing, invoicing/integration/testing]:
  - `4242 4242 4242 4242`: success.
  - **`4000 0000 0000 0341`**: attaching succeeds, charges fail. Use it to simulate renewal failure → `past_due`. Issuer-decline cards can't be attached.
  - Stripe recommends `pm_card_visa`-style tokens in server code.
- **Test clocks** (`stripe.testHelpers.testClocks`) [sdk-source unless noted]:
  - `create({ frozen_time, name? })`, then `customers.create({ test_clock })`. "Once attached, customers can't be removed from a test clock."
  - `advance(id, { frozen_time })` must be after the current frozen time. It "Cannot be more than two intervals in the future from the shortest subscription in this test clock", or 2 years if the clock has no subscriptions.
  - Status `advancing | internal_failure | ready`. Poll until `ready`.
  - `deletes_after` auto-deletes the clock. Endpoints: `/v1/test_helpers/test_clocks[/{id}[/advance]]`.
  - Per-clock caps: **3 customers**, 3 subscriptions per customer (including scheduled), 10 unattached quotes. Accounts with Billing **Automations** can't use test clocks on existing customers. Frequent updates on clocked subscriptions can hit rate limits; advance a few minutes first [search: billing/testing/test-clocks/api-advanced-usage].
  - **Flow:**
    1. Create a clock and a Customer on it.
    2. Point our user's `stripe_customer_id` at that Customer.
    3. Open `/pay/<token>`, so Checkout uses `customer`, and pay with 4242.
    4. Advance one month → `invoice.paid`.
    5. Swap the default payment method to the 0341 card → advance → `invoice.payment_failed`, `past_due`, then `unpaid`/`canceled` per settings.
- **Our in-app trial** is not on Stripe's clock. Inject a `Clock`/`now()` dependency so Vitest can move time.
- **Stripe CLI** [sdk-source: stripe-cli `pkg/cmd/listen.go`, `trigger.go`, `pkg/fixtures/triggers/*`; search: docs.stripe.com/webhooks]:
  - Forward webhooks:
    ```
    stripe listen --forward-to localhost:3000/api/webhooks/stripe --latest \
      --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed
    ```
    - `--latest` renders events in the latest API version; otherwise they use the account default.
    - `--print-secret` prints the `whsec_…` and exits.
    - The CLI secret **differs** from Dashboard endpoint secrets. Use it as the local `STRIPE_WEBHOOK_SECRET`.
  - Trigger fixtures: `stripe trigger <event>`, with flags `--override`, `--add`, `--remove`, `--skip`, `--raw`, `--api-version`, `--edit`. Fixtures exist for:
    - `checkout.session.completed` (note: the fixture is **`mode: payment`** with no `client_reference_id`; use `--add checkout_session:client_reference_id=<uuid>` or the real flow)
    - `checkout.session.expired`
    - `customer.subscription.created`, `.updated`, `.deleted`
    - `customer.subscription.trial_will_end` (creates a subscription with `trial_period_days: 1`)
    - `customer.subscription.paused`
    - `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`

    No fixture file was found for `customer.subscription.resumed` or `invoice.payment_succeeded`.
  - `stripe events resend <evt_id>` re-sends an event, for up to 30 days [search].

## 8. Sending payment links by text; Stripe Tax

- **Stripe rules on SMS links:** no Stripe policy restricting Checkout or Payment Links sent by SMS or iMessage was found. Stripe's pay-by-link guide lists SMS and messaging apps as normal channels [search: stripe.com/resources/more/pay-by-link-an-in-depth-guide]. The Restricted Businesses list was not retrieved; diet/nutrition coaching software is not expected to be restricted, but verify it during account activation.
- **Carrier rules** (for SMS fallback and A2P): public URL shorteners (bit.ly etc.) are prohibited or blocked in A2P 10DLC campaigns. Use a domain we own [search: Twilio error 30963, Sinch, Bird; vendor sources, not the CTIA PDF itself]. Twilio also flags custom domains that act purely as redirect services [search]. Mitigation: `/pay/<token>` should be a real page on the product's own domain, with OG tags.
- **Smishing and trust:** users are trained to distrust texted payment links [search: Stripe fraud guide]. Use one consistent branded domain. The final page is `checkout.stripe.com`, unless we buy Stripe **Custom Domains**, which puts `session.url` on our subdomain [sdk-source: Session.url doc; pricing not found]. Never ask for card details in-thread.
- **iMessage link previews:** Apple's preview fetcher **follows server-side redirects but doesn't run JavaScript** [search: Apple TN2444]. Its UA includes `facebookexternalhit/1.1 Facebot Twitterbot/1.0` [search: third-party crawler profiles]. Whether the fetch happens on the sender's or the recipient's device is unclear.
  - Implication: a preview can hit `/pay/<token>` and create a Checkout Session before the human taps. Our "reuse open session" rule makes that harmless.
  - Optionally serve an OG-tag HTML page (no session creation) to preview UAs. That is not a security control, since UAs are spoofable.
  - Tokens must not be single-use-on-GET, or the preview would burn them.
- **Stripe Tax (note only)** [search: stripe.com/tax/pricing, support.stripe.com, docs.stripe.com/tax]:
  - Enable with `automatic_tax: { enabled: true }` on Checkout. Checkout then collects the address it needs. Pass `customer_update.address: 'auto'` when using `customer`.
  - Tax is collected only where we have an active registration.
  - SaaS is taxable in only some US states, sometimes only B2B or B2C.
  - Pricing (verify): pay-as-you-go 0.5% per transaction for no-code surfaces (Checkout, Billing, Payment Links) where registered, or $0.50 per API transaction. Tax Complete plans start around $90/month. A fee applies on each subscription renewal invoice finalized while a registration covers the customer.
  - Stripe can monitor thresholds (most US states: $100k or 200 transactions; CA/NY/TX: $500k).
  - Existing subscriptions must be migrated to enable automatic tax later. **Build with an `STRIPE_AUTOMATIC_TAX` flag (default off)** so it can be enabled without code changes.

---

## Implications for our design

1. **Dependencies and env:**
   - Add `stripe@23.0.1`, pinned exactly; it requires Node ≥ 20.
   - Add a lazy `getStripe()` in `src/billing/stripe.ts` with `apiVersion: '2026-09-30.endive'`, `maxNetworkRetries: 2` and `timeout: 20_000`.
   - Env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_PORTAL_CONFIGURATION_ID` (optional), `STRIPE_AUTOMATIC_TAX=false`, `TRIAL_DAYS`, `PAST_DUE_GRACE_DAYS`, `PUBLIC_BASE_URL`. Update `.env.example`.
2. **Billing module behind an interface**, like the channel adapter: `BillingProvider` with methods `createCheckoutRedirect`, `createPortalRedirect`, `cancelAtPeriodEnd`, `cancelNow` and `syncSubscription`. Add a `FakeBillingProvider` so the simulator and evals run without Stripe.
3. **Data model:**
   - `users`: `trial_started_at`, `trial_ends_at`, `stripe_customer_id` (unique).
   - `subscriptions`: `stripe_subscription_id` (unique), `user_id`, `status`, `price_id`, `current_period_end`, `cancel_at_period_end`, `cancel_at`, `trial_end`, `past_due_since`, `updated_from_event_at`.
   - `checkout_sessions`: `id`, `user_id`, `url`, `expires_at`, `status`.
   - `billing_link_tokens`: `token_hash`, `user_id`, `purpose` (`checkout | portal_home | portal_payment_method | portal_cancel`), `expires_at`.
   - `stripe_events`: `id` PK, `type`, `created`, `livemode`, `processed_at`, `error`.
4. **Routes:**
   - `GET /pay/[token]` (create or reuse a Checkout Session, 303)
   - `GET /pay/done`, `GET /pay/cancelled` (static "go back to iMessage" pages)
   - `GET /billing/[token]` (create a portal session with the right `flow_data`, 303)
   - `POST /api/webhooks/stripe` (Node runtime, raw body, `constructEvent`, dedupe, re-fetch, upsert)
   - Daily reconcile cron.
5. **Entitlement function** `getAccess(user, now)` → `full | grace | gated`, implemented in code (pure, unit-tested) from local rows per §6. The agent loop calls it before tool use. Gated turns get a canned reply and skip the model.
6. **Agent tools/commands:**
   - `subscribe`: send a `/pay` link.
   - `billing`/`update card`: send a `/billing` link with the `payment_method_update` purpose.
   - `cancel subscription`: confirm, then `cancel_at_period_end` (or send a portal cancel link).
   - Keep "STOP" (messaging) and "cancel subscription" (billing) clearly separate in HELP text.
7. **DELETE command** must cancel any live subscription immediately before wiping, and record that it did.
8. **No health data to Stripe:** metadata holds only `user_id` (UUID). Don't send phone or health info. List Stripe as a payment processor in the privacy policy (TODO for the owner's policy text).
9. **Tests (Vitest):**
   - Webhook route with `generateTestHeaderString`: valid, bad signature, stale timestamp, duplicate event ID, out-of-order events.
   - `getAccess` truth table.
   - Token hashing and expiry.
   - The "reuse open session" logic.
   - Mock the Stripe client at the `BillingProvider` boundary.
10. **Ops:**
    - Create the live webhook endpoint with `api_version: 2026-09-30.endive` and exactly the events in §4.3.
    - Configure the portal (cancel at period end, card update, invoice history).
    - Set failed-payment behavior (recommend: Smart Retries, then **cancel** after the final retry, or "mark unpaid").
    - Enable Stripe customer emails (failed payment, expiring card, trial reminders if using Stripe-side trials).
    - On preview deployments, use the Vercel protection-bypass query param in the webhook URL.

## Open questions for the product owner

1. **Price and plans:** monthly price and currency, and whether to offer an annual plan. There is no sensible default for the amount.
2. **Sales tax:** will you register to collect US sales tax or VAT, which needs Stripe Tax plus registrations? This is a business/legal decision, so we ship with the flag off.
3. **Refund/cancellation policy text and ToS URL.** They are needed for Checkout's ToS consent checkbox and the portal business profile, and card-network trial rules expect a cancellation URL if we ever use Stripe-side trials.

## Risks

- **Duplicate subscriptions** if two Checkout Sessions complete, or the user resubscribes via another path. Mitigated by reusing or expiring open sessions, our pre-redirect check and the webhook guard. Consider Stripe's "limit to one subscription" setting.
- **Link-preview fetches** creating sessions or consuming tokens (§8). Mitigated by idempotent GET and multi-use tokens with a TTL.
- **Out-of-order or duplicate events** corrupting status. Mitigated by event-ID dedupe and re-fetching the Subscription.
- **Webhook payload shape drift** if the endpoint `api_version` differs from the SDK's (it can't be changed after creation). Recreate the endpoint on upgrades.
- **Stale knowledge:** several facts are [search]-only: portal URL lifetime, retry windows, Smart Retries defaults, test-clock caps, Payment Link param rules and Stripe Tax pricing. Re-verify on docs.stripe.com before coding (blocked from this container).
- **Compliance surface:** trial-to-paid auto-renewal laws and card-network trial rules apply if a Stripe-side trial with a card is used (§2.6). State auto-renewal laws were not researched; flag for legal review.
- **Never-cold-message rule vs dunning:** we rely on Stripe emails and in-thread mentions for failed payments. If the user never texts back, they find out via email only.
- **Spam filtering:** texting payment links can trip carrier or Apple filters. Use our own domain, low frequency, and only in replies.
- **Vercel Deployment Protection** blocks Stripe on protected previews unless the bypass param is used.

## Sources

- npm `stripe@23.0.1` tarball (README.md, CHANGELOG.md, `esm/apiVersion.js`, `esm/lib.d.ts`, `esm/Webhooks.{js,d.ts}`, `esm/crypto/*`, `esm/resources/Checkout/Sessions.d.ts`, `esm/resources/PaymentLinks.d.ts`, `esm/resources/BillingPortal/{Sessions,Configurations}.d.ts`, `esm/resources/Subscriptions.d.ts`, `esm/resources/SubscriptionItems.d.ts`, `esm/resources/Invoices.d.ts`, `esm/resources/Customers.d.ts`, `esm/resources/TestHelpers/TestClocks.d.ts`, `esm/resources/WebhookEndpoints.d.ts`): https://registry.npmjs.org/stripe/-/stripe-23.0.1.tgz
- https://github.com/stripe/stripe-node
- https://raw.githubusercontent.com/stripe/stripe-node/master/examples/webhook-signing/nextjs/app/api/webhooks/route.ts
- https://raw.githubusercontent.com/stripe/stripe-node/master/examples/webhook-signing/README.md
- https://raw.githubusercontent.com/stripe/openapi/master/latest/openapi.spec3.json (info.version 2026-09-30.endive)
- https://raw.githubusercontent.com/stripe/openapi/master/README.md
- https://raw.githubusercontent.com/stripe/stripe-cli/master/pkg/cmd/listen.go
- https://raw.githubusercontent.com/stripe/stripe-cli/master/pkg/cmd/trigger.go
- https://raw.githubusercontent.com/stripe/stripe-cli/master/pkg/fixtures/triggers/customer.subscription.trial_will_end.json
- https://raw.githubusercontent.com/stripe/stripe-cli/master/pkg/fixtures/triggers/checkout.session.completed.json
- https://vercel.com/docs/webhooks/webhooks-api (via Vercel docs MCP)
- https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation (via Vercel docs MCP)
- https://docs.stripe.com/api/checkout/sessions/create
- https://docs.stripe.com/payments/checkout/free-trials
- https://docs.stripe.com/payments/checkout/abandoned-carts
- https://docs.stripe.com/payments/checkout/custom-success-page
- https://docs.stripe.com/payments/checkout/limit-subscriptions
- https://docs.stripe.com/payment-links/url-parameters
- https://docs.stripe.com/payment-links/customize
- https://docs.stripe.com/api/payment-link/create
- https://support.stripe.com/ (Payment Links expiry article, via search)
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/webhooks/signature
- https://docs.stripe.com/webhooks/process-undelivered-events
- https://docs.stripe.com/billing/subscriptions/webhooks
- https://docs.stripe.com/billing/subscriptions/overview
- https://docs.stripe.com/billing/subscriptions/trials
- https://docs.stripe.com/billing/subscriptions/trials/free-trials
- https://docs.stripe.com/billing/subscriptions/trials/manage-trial-compliance
- https://docs.stripe.com/billing/subscriptions/pause
- https://docs.stripe.com/billing/revenue-recovery/smart-retries
- https://docs.stripe.com/billing/entitlements
- https://docs.stripe.com/api/customer_portal/sessions
- https://docs.stripe.com/customer-management/integrate-customer-portal
- https://docs.stripe.com/customer-management/activate-no-code-customer-portal
- https://docs.stripe.com/billing/testing
- https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage
- https://docs.stripe.com/testing
- https://docs.stripe.com/invoicing/integration/testing
- https://docs.stripe.com/metadata
- https://docs.stripe.com/metadata/use-cases
- https://docs.stripe.com/api/idempotent_requests
- https://docs.stripe.com/apple-pay
- https://docs.stripe.com/changelog/endive
- https://docs.stripe.com/changelog/endive/2026-09-30/trial-offer-ga
- https://docs.stripe.com/changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes
- https://docs.stripe.com/changelog/dahlia/2026-05-27/pause-subscriptions
- https://docs.stripe.com/changelog/clover/2025-09-30/billing-mode-default-flexible
- https://docs.stripe.com/tax
- https://stripe.com/tax/pricing
- https://support.stripe.com/questions/understanding-stripe-tax-pricing
- https://stripe.com/resources/more/pay-by-link-an-in-depth-guide
- https://stripe.com/resources/more/six-types-of-payment-fraud
- https://developer.apple.com/library/archive/technotes/tn2444/_index.html
- https://docs.centinelanalytica.com/crawlers/apple-link-preview
- https://www.twilio.com/docs/api/errors/30963
- https://community.sinch.com/t5/10DLC/How-can-you-prevent-your-custom-URL-shortener-from-getting/m-p/12800
- https://bird.com/explained/sms/why-do-carriers-block-public-link-shorteners
