# Vercel platform + Next.js 16 for the iMessage nutrition coach

Retrieved: 2026-10-29

**TL;DR.** The owner's Vercel **Hobby** plan has two blockers for this product. (1) **Cron jobs on Hobby run at most once per day, and only to the nearest hour (±59 min).** A `*/15 * * * *` schedule **fails the deployment**, so the spec's 15-minute check-in cron cannot run on Hobby. (2) **Hobby is limited to personal, non-commercial use.** A paid subscription (milestone 7) needs Pro ($20/month platform fee, which includes $20 of usage credit). Everything else fits Hobby for development. Fluid compute is the default, with a 300 s default and maximum function duration on Hobby (Pro: 800 s, 1800 s in beta). Request and response bodies are capped at 4.5 MB on every plan. Next.js `after()` runs on Vercel's `waitUntil` and shares the route's `maxDuration`. It is not durable. Vercel Queues is the durable option (public beta, 1M operations/month included on Hobby, delays up to 7 days). Vercel Blob now has **private** stores (GA). `@vercel/blob@2.8.2` supports `access: 'private'`, `get()`, and presigned URLs. Hobby Blob quotas are tiny, though (2,000 uploads/month). Postgres comes from the Marketplace (Neon or Supabase). Create the pool at module scope and register it with `attachDatabasePool()`. Next.js 16.4.3 changes some defaults. `middleware.ts` is now `proxy.ts` and runs only on Node. Turbopack is the default for dev and build. The minimum is Node 20.9. The Edge runtime is deprecated. `create-next-app` now turns on Cache Components by default, which changes how GET route handlers behave. Password Protection is **not** on Hobby, so `/admin` needs app-level auth (HTTP Basic in `proxy.ts` plus a check inside each admin handler).

**Tag legend.** `[primary]` means read from the official doc page or doc text myself. For vercel.com, `vercel.com` itself is DNS-blocked here, so these are verbatim official-doc excerpts returned by the Vercel docs search tool (an index of vercel.com/docs), each with its page URL. For Next.js, they come from the version-matched docs bundled in the `next@16.4.3` tarball (`dist/docs/`), which match `github.com/vercel/next.js/canary/docs`. `[sdk-source]` means read from published package code or types (npm tarballs). `[search]` means the fact comes only from a WebSearch summary of official pages and **must be re-verified before coding**.

---

## 1. Cron Jobs

### Limits by plan
| Plan | Cron jobs / project | Min interval | Timing precision |
|---|---|---|---|
| Hobby | 100 | **once per day** | **per hour (±59 min)**: `0 8 * * *` may fire any time 08:00:00–08:59:59 |
| Pro | 100 | once per minute | per minute: `5 8 * * *` fires 08:05:00–08:05:59 |
| Enterprise | 100 | once per minute | per minute |

- On Hobby, more frequent expressions (e.g. `0 * * * *`, `*/30 * * * *`) **fail at deployment** with an error that Hobby is limited to daily cron jobs. [search] https://vercel.com/docs/cron-jobs/usage-and-pricing
- 100 per project on every plan. Older limits are obsolete: 20 per project, and 2/40/100 per team on Hobby/Pro/Enterprise. [search] https://vercel.com/changelog/cron-jobs-now-support-100-per-project-on-every-plan
- Cron jobs themselves cost nothing. Each run is a normal Function invocation, billed and limited like any other. [search] https://vercel.com/docs/cron-jobs/usage-and-pricing

### Configuration
- `vercel.json` takes `"crons": [{ "path": "/api/...", "schedule": "<cron expr>" }]`. `path` must start with `/` (max 512 chars). `schedule` is max 256 chars. Crons are defined "for the production deployment". The same can be written in `vercel.ts` (`import type { VercelConfig } from '@vercel/config/v1'`). [primary] https://vercel.com/docs/project-configuration/vercel-json , https://vercel.com/docs/project-configuration/vercel-ts
- Schedules are in **UTC**. The docs' examples read "0 5 * * *" as "daily at 5:00 am UTC". [primary] https://vercel.com/docs/cron-jobs/quickstart
- Several entries can share one path. The handler can tell them apart by the **`x-vercel-cron-schedule`** request header, which carries the cron expression. [primary] https://vercel.com/docs/cron-jobs/manage-cron-jobs
- CLI (beta): `vercel crons ls [--format json]`, `vercel crons add --path ... --schedule "..."`, and `vercel crons run /api/cron`. The last one triggers a cron **already deployed to production** on demand, which is useful on Hobby for testing. [primary] https://vercel.com/docs/cli/crons

### How invocation works
- Vercel sends an **HTTP GET** to `path` on the **production** deployment. [search] https://vercel.com/docs/cron-jobs/quickstart
- Securing it: set an env var named **`CRON_SECRET`**. Vercel then sends **`Authorization: Bearer <CRON_SECRET>`**, and the official handler pattern is `if (!cronSecret || authHeader !== \`Bearer ${cronSecret}\`) return 401`. [primary] https://vercel.com/docs/cron-jobs/manage-cron-jobs
- The Vercel CLI rejects a `CRON_SECRET` containing characters that are not valid in HTTP headers (error code `INVALID_CRON_SECRET`; "Only visible ASCII characters (letters, digits, symbols), spaces, and tabs are allowed"). [sdk-source] `vercel@65.7.0` `dist/commands/build/index.js`
- User-Agent: the CLI's local schedule dispatcher sends `user-agent: vercel-cron/1.0` plus `x-vercel-cron-schedule`, and sends `authorization: Bearer ${CRON_SECRET}` when the variable is set. I did not see the production User-Agent in official docs, so **do not authenticate on UA**. [sdk-source] `vercel@65.7.0` `dist/commands/dev/index.js`
- Cron Jobs are exempt from Attack Challenge Mode challenges within the same account. [search] https://vercel.com/changelog/attack-challenge-mode-now-allows-verified-bots-and-vercel-cron-jobs

### Long runs, overlap, reliability
- Cron runs have the **same duration limits as Functions** (Hobby 300 s). [search] https://vercel.com/docs/cron-jobs/manage-cron-jobs
- **Overlap is possible.** If a run outlasts the interval, a second instance can start while the first is still running. Vercel suggests a lock (their example is Redis), a shorter run, `maxDuration`, or a lower frequency. [search] same URL
- **No retries:** "Vercel will not retry an invocation if a cron job fails." Delivery is best-effort: a run can be **missed or duplicated**, so make jobs idempotent and catch-up based. [search] same URL + https://vercel.com/kb/guide/troubleshooting-vercel-cron-jobs
- Redirects are reportedly not followed (e.g. a 308 trailing-slash redirect ends the job). This is a community report only. Use the exact path with no trailing slash. [search, community]
- **Preview deployments do not run crons.** Only production is invoked. To test on a preview, call the route yourself with the secret. [search] https://vercel.com/docs/cron-jobs/quickstart
- Logs: Project → Cron Jobs → View Logs. [search] https://vercel.com/docs/cron-jobs/manage-cron-jobs

### Emerging: "Vercel Schedules" (unverified)
- Vercel CLI release notes (around Sept 2026) mention `vercel schedules get|list` and one-time schedules with `--at` (minute precision). The CLI bundle contains a dispatcher for schedules with `expression.type` `cron` or `at` and targets `path` or `queue` (CloudEvent type `com.vercel.schedule.v1beta`). There is no docs page I could reach, and plan limits are unknown. **Do not design around it yet.** [search] https://vercel.com/docs/cli/release-notes ; [sdk-source] `vercel@65.7.0`

---

## 2. Hobby plan: Fair Use and commercial use

- Fair Use Guidelines: "**Hobby teams are restricted to non-commercial personal use only.** All commercial usage of the platform requires either a Pro or Enterprise plan." [search] https://vercel.com/docs/limits/fair-use-guidelines
- The guidelines list examples of commercial use, including "**any method of requesting or processing payment from visitors of the site**", receiving payment to create, update or host the site, and ads. Asking for donations is not commercial use. The definition reported in community quotes is "any Deployment that is used for the purpose of financial gain of anyone involved in any part of the production of the project". **I could not confirm that exact sentence on the live page.** [search] same URL
- Terms of Service: "You shall only use the Services under a Hobby plan for your personal or non-commercial use." [search] https://vercel.com/legal/terms
- Pricing page: "Our Hobby plan is for personal, non-commercial use." Vercel's help page lists commercial use on Hobby as a frequent reason teams get paused. [search] https://vercel.com/pricing , https://vercel.com/kb/guide/why-is-my-account-deployment-blocked
- **Verdict.** A product that sells subscriptions through a Stripe Checkout link is commercial. It needs **Pro** before it takes payments, and arguably before it serves real users at all. Pro costs $20/month as a platform fee, includes $20 of usage credit and 1 paid seat, and each additional paid seat is $20/month. [search] https://vercel.com/docs/plans/pro-plan
- Hobby overage: Hobby is **paused** when it exceeds the included usage. There is no pay-as-you-go. Several products (e.g. Blob) then stay unavailable until 30 days have passed. [search] https://vercel.com/docs/plans , https://vercel.com/docs/vercel-blob/usage-and-pricing

---

## 3. Functions (Fluid compute)

### Defaults and duration
- Fluid compute is **on by default for new projects since 2025-04-23**. It can be toggled with `"fluid": true` in vercel.json or vercel.ts. [primary] https://vercel.com/docs/project-configuration/vercel-ts , https://vercel.com/docs/fluid-compute
- Duration on Fluid: **Hobby default 300 s, max 300 s. Pro/Enterprise default 300 s, max 800 s.** An **extended 1800 s max is in beta** on Pro/Enterprise only. It must be set per function, needs specific Node/Bun/Python versions, and is not supported with Secure Compute or Static IPs. [search] https://vercel.com/docs/functions/configuring-functions/duration , https://vercel.com/docs/functions/limitations
- Legacy, non-Fluid projects default to 10 s (Hobby) and 15 s (Pro). This is irrelevant for a new project. [search] same
- Configuration: in the App Router route file, `export const maxDuration = 300`. Alternatively use the vercel.json `functions` glob, e.g. `"app/api/**/*": { "maxDuration": 5 }`. Precedence runs from function code, to vercel.json, to the dashboard, to Fluid defaults. [primary] https://vercel.com/docs/functions/configuring-functions/duration ; precedence [search]
- `maxDuration` remains a valid segment config in Next 16, including with Cache Components on. [primary] next@16.4.3 `dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/index.md`

### Memory and CPU
- **Hobby: fixed 2 GB / 1 vCPU** (not configurable). Pro/Enterprise: Standard 2 GB / 1 vCPU (default) or Performance 4 GB / 2 vCPU. [search] https://vercel.com/docs/functions/configuring-functions/memory
- With Fluid on, memory is set in the dashboard (Functions section), **not** in vercel.json. [primary] https://vercel.com/docs/project-configuration/vercel-json

### Payload limits
- **Request body and response body: 4.5 MB each, on every plan.** An oversized request gets `413 FUNCTION_PAYLOAD_TOO_LARGE`. An oversized response gets `500 FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE`. Upgrading does not raise the limit. [search] https://vercel.com/docs/functions/limitations , https://vercel.com/docs/errors/FUNCTION_PAYLOAD_TOO_LARGE
- Vercel's workaround for uploads is client uploads straight to Blob. For responses, streaming is said to avoid the limit. A community thread says streaming does **not** lift the *request* limit. [search] https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
- The `@vercel/blob` README says the same: server uploads are limited to 4.5 MB on Vercel, while client uploads can go up to 5 TB. [sdk-source] `@vercel/blob@2.8.2` README
- Next-side limits are separate. Server Actions bodies default to **1 MB** (`experimental.serverActions.bodySizeLimit`). When `proxy.ts` matches a request, Next buffers the body up to `experimental.proxyClientMaxBodySize` (default **10 MB**) and truncates anything beyond, with a warning. [primary] next@16.4.3 `dist/docs/.../serverActions.md`, `.../proxyClientMaxBodySize.md`

### Pricing model: is waiting billed?
- **Active CPU** is billed only while code executes. It pauses during I/O waits such as DB queries or model calls. Vercel's example: 100 ms of processing plus 400 ms of waiting is billed as 100 ms. [search] https://vercel.com/docs/functions/usage-and-pricing
- **Provisioned memory** *is* billed for as long as the instance has in-flight requests, **including I/O waits** and timers. It stops when the last request finishes. So an `await sleep(4000)` debounce costs memory GB-seconds and invocation time, but not CPU. [search] same
- Hobby includes per month: **1,000,000 invocations, 4 h Active CPU, 360 GB-h provisioned memory**, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer, and 1,000,000 Edge Requests. A non-Fluid project falls back to the legacy cap of 100k invocations. [search] https://vercel.com/docs/plans/hobby , https://vercel.com/pricing
- Pro on-demand rates start at $0.128 per Active CPU hour and $0.0106 per GB-h in the cheapest regions. Rates vary by region. [search] https://vercel.com/pricing

### Concurrency within an instance
- Fluid "optimized concurrency" (Node.js and Python): a new instance starts only when no running instance has spare capacity. **Many invocations run concurrently in one instance** and share module-level state, caches, and DB pools. [search] https://vercel.com/docs/fundamentals/what-is-compute
- I found no documented per-instance cap. Vercel has reported observing "dozens" of concurrent requests per instance, with peaks above 250. [search] https://vercel.com/blog/scale-to-one-how-fluid-solves-cold-starts
- Consequence: never keep per-request or per-user mutable state in module scope. In-memory locks do not serialize across instances.

### Region
- Functions default to **`iad1`** (Washington, D.C.). Hobby may choose **any single region**. Pro can deploy to up to 5 regions. Put functions in the same region as the database. [primary] https://vercel.com/docs/project-configuration/vercel-ts ; region counts [search] https://vercel.com/docs/functions/configuring-functions/region
- The Node version can be overridden with `"engines": { "node": "24.x" }`. Project `nodeVersion` accepts `20.x`, `22.x`, `24.x`, or `26.x`. I did not confirm the default for new projects. [primary] https://vercel.com/docs/functions/runtimes/node-js/node-js-versions , https://vercel.com/docs/rest-api/sdk/projects/create-a-new-project

### System env vars
- `@vercel/functions` `getEnv()` types include `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_AUTOMATION_BYPASS_SECRET`, and `VERCEL_GIT_*`. [sdk-source] `@vercel/functions@3.10.4` `get-env.d.ts`

---

## 4. Background work after responding

### Next.js `after()` (`import { after } from 'next/server'`)
- It is stable since v15.1 and allowed in Route Handlers, Server Functions, Server Components, and Proxy. It takes a callback or a promise: `after<T>(task: Promise<T> | (() => T | Promise<T>)): void`. [primary] next@16.4.3 `dist/docs/01-app/03-api-reference/04-functions/after.md` ; [sdk-source] `dist/server/after/after.d.ts`
- **Duration:** "`after` will run for the platform's default or configured max duration of your route", configurable with `maxDuration`. [primary] same doc
- On Vercel it is implemented with `waitUntil(promise)`, found through `globalThis[Symbol.for('@next/request-context')].get().waitUntil`. [primary] same doc
- It runs even if the response failed, threw, or called `notFound`/`redirect`. In Route Handlers, `cookies()` and `headers()` may be called inside the callback. [primary] same doc
- Calling it outside a request scope **throws** ("…outside a request scope"). It also throws when no `waitUntil` is available ("`after()` will not work correctly, because `waitUntil` is not available"). So unit tests must call the processing function directly. [sdk-source] next@16.4.3 `dist/server/after/after.js`, `after-context.js`
- Vercel's docs say to use `after()` rather than `waitUntil()` on Next.js 15.1 and later. [primary] https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package

### `@vercel/functions` `waitUntil` (v3.10.4)
- `waitUntil(promise: Promise<unknown>): void | undefined`. It throws `TypeError` on a non-promise. It reads `globalThis[Symbol.for('@vercel/request-context')]`. **Outside Vercel it is a silent no-op**: the promise still runs, but nothing keeps the process alive. [sdk-source] `wait-until.js`, `get-context.js`
- "Promises passed to `waitUntil()` will have the **same timeout as the function itself**. If the function times out, the promises will be cancelled." [primary] https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
- `getDeadline(): Date | undefined` returns the shared invocation deadline, derived from `maxDuration`. It "includes request processing and asynchronous `waitUntil` tasks". Use it to stop work before the kill. [primary] same URL ; [sdk-source] `deadline.d.ts`
- **So response time plus `after()` work must fit inside one `maxDuration` (300 s on Hobby).** If the invocation crashes or times out, the work is gone, and the webhook has already returned 200.

### Vercel Queues (`@vercel/queue@0.10.0`)
- **Status: public beta, available to all teams and plans since 2026-02-27.** I found no GA announcement as of 2026-10-29. The trigger type is still `queue/v2beta`, configured under `experimentalTriggers`. [search] https://vercel.com/changelog/vercel-queues-now-in-public-beta ; [sdk-source] README
- **Pricing:** billed per API operation (send, receive, delete, visibility change, notify). Messages are metered in 4 KiB chunks. **Sends with an idempotency key, and push deliveries with max concurrency, count 2×.** **Hobby includes 1,000,000 operations/month.** On-demand pricing is $0.60–$0.96 per million depending on region. Functions invoked by pushes are billed at normal compute rates. [search] https://vercel.com/docs/queues/pricing , https://vercel.com/docs/pricing/regional-pricing
- **Producer:** `send(topic, payload, { idempotencyKey?, retentionSeconds?, delaySeconds?, headers?, region? })`. [sdk-source] README and `dist/index.d.ts`
  - `retentionSeconds`: default 86,400, min 60, max 604,800 (7 d).
  - **`delaySeconds`: default 0, max 604,800, and it cannot exceed retention.** This means delayed delivery is supported.
  - `idempotencyKey`: max 256 chars. The dedup window is `min(retention, 24h)`.
  - `sendBatch` takes 1–100 messages.
  - The payload can be up to 100 MB.
  - `messageId` is `null` when the message was accepted for deferred processing.
- **Consumer (push):** `export const POST = handleCallback(async (message, metadata) => {...}, { visibilityTimeoutSeconds?: 300 (30–3600), retry?: (err, meta) => ({ afterSeconds } | { acknowledge: true } | undefined) })`. Wire it in vercel.json: `"functions": { "app/api/queue/<topic>/route.ts": { "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "<topic>", "retryAfterSeconds"?: 60, "initialDelaySeconds"?: 0 }] } }`. [sdk-source] README
  - Delivery is **at-least-once**. A handler that throws means the message is retried until it expires.
  - `metadata` has `messageId`, `deliveryCount`, `createdAt`, `expiresAt`, `topicName`, `consumerGroup`, `region`.
  - Each route file subscribed to a topic is its own consumer group.
- **Per-key serialization (experimental):** `send(..., { experimental_concurrencyKey })` allows at most one active push delivery per (topic, consumer group, key). Messages claimed while the key is held are **coalesced** into the running delivery, and are consumed with `experimental_maxCoalescedReruns`. It is incompatible with `maxConcurrency` or `maxAttempts`. This matches "debounce per user and never run two turns at once" almost exactly, but it is experimental. [sdk-source] `dist/index.d.ts`
- **Deployment pinning:** by default, sent messages are **pinned to the sending deployment** (`VERCEL_DEPLOYMENT_ID`). `new QueueClient({ deploymentId: null })` unpins them. A message delayed for days would by default go to old code. I could not verify how unpinned push delivery routes. [sdk-source] `dist/index.d.ts` (`deploymentId` doc)
- Messages can only be consumed in the region they were sent to. The top-level `send` auto-detects `VERCEL_REGION` and falls back to `iad1`. [sdk-source] README
- Local dev works in two ways. With Vercel CLI ≥ 59.26.0 there is a local broker (`VERCEL_QUEUE_BASE_URL`, `VERCEL_QUEUE_TOKEN`). Otherwise messages go to the cloud service and handlers are invoked in-process, which needs `vc link` and `vc env pull` for OIDC. [sdk-source] README
- Related: **Vercel Workflow** (durable steps and `sleep`, built on Queues). Hobby includes 50,000 events and 1 GB of data written per month. Each step is limited by the Function duration (300 s on Hobby). One guide calls it GA since April 2026, but I did not verify that. [search] https://vercel.com/docs/workflows/pricing

---

## 5. Vercel Blob

### Private vs public
- **Private storage is GA, for all plans.** One changelog gives the GA date as 2026-06-30. "Private Blob stores require authentication for all read and write operations." Private blob URLs are not publicly reachable. [search] https://vercel.com/changelog/vercel-private-blob-is-now-generally-available , https://vercel.com/docs/vercel-blob/private-storage
- Create a private store with `vercel blob create-store <name> --access private --yes`. The store's access level is fixed at creation. [primary] https://vercel.com/docs/vercel-blob/private-storage
- **`@vercel/blob@2.8.2` supports it fully.** [sdk-source] `dist/index.d.ts`, `dist/create-folder-*.d.ts`
  - `type BlobAccessType = 'public' | 'private'`. `access` is required on `put`, `get`, `copy`, `putImage` and the rest.
  - `get(urlOrPathname, { access: 'private', useCache?, ifNoneMatch? })` returns `{ statusCode: 200, stream, headers, blob: { contentType, size, etag, ... } }`, or `304`, or `null`.
  - `put(pathname, body, { access, addRandomSuffix? (default false), allowOverwrite?, contentType?, cacheControlMaxAge? (default 1 month, min 60 s), multipart? })`.
  - `head()`, `list()`, `del()`, and `copy()` are available.
- Serving private blobs: the docs' pattern is a route handler that runs your auth, then calls `get(pathname, { access: 'private' })`, then returns `new NextResponse(result.stream, { headers: { 'Content-Type': result.blob.contentType, 'X-Content-Type-Options': 'nosniff' } })`. ETag/304 is supported through `ifNoneMatch`. [primary] https://vercel.com/docs/vercel-blob/private-storage
- **Signed URLs** use `issueSignedToken({ pathname?, operations?: ('get'|'head'|'put'|'delete')[], validUntil?, allowedContentTypes?, maximumSizeInBytes? })`, then `presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil?, useCache? })`. [sdk-source] ; usage [primary] https://vercel.com/docs/vercel-blob/vercel-signed-urls
  - The token's `validUntil` defaults to now + 1 h. The default operation is `get` only. `pathname: '*'` means the whole store.
  - Docs and changelog give a maximum expiry of **7 days** [search]. That is not encoded in the SDK.
- Auth: `BLOB_READ_WRITE_TOKEN`, or OIDC (`VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID`, which is the default on Vercel Functions). Outside Vercel, a raw request is `curl https://<store>.private.blob.vercel-storage.com/<path> -H "Authorization: Bearer $BLOB_READ_WRITE_TOKEN"`. [sdk-source] ; [primary] private-storage page
- Overwritten private blobs can be served from cache for up to 60 s. Pass `useCache: false` to read fresh. [search] https://vercel.com/changelog/vercel-blob-now-supports-consistent-reads-on-private-storage
- `putImage(pathname, body|URL, { access, optimizeImage: { width 1–8192, quality? (default 75), format?: 'jpeg'|'png'|'webp'|'avif' } })` resizes through Vercel Image Optimization before storing. It requires OIDC and is billed as one image transformation plus one put. It could replace `sharp`. [sdk-source]
- Client uploads (`@vercel/blob/client`): `upload()`, plus `handleUpload({ onBeforeGenerateToken(pathname, clientPayload, multipart) => ({ allowedContentTypes, maximumSizeInBytes, validUntil, addRandomSuffix, callbackUrl? }), onUploadCompleted? })` on the server. These bypass the 4.5 MB Function limit. [sdk-source] `dist/client.d.ts`

### Limits and pricing
- Hobby includes per month: **1 GB storage, 10,000 simple operations, 2,000 advanced operations, 10 GB data transfer.** Uploads, copies, lists, and store creation are advanced operations. A multipart upload costs 1 + one per part + 1. Deletes are free. Dashboard browsing also counts. If Hobby goes over, **Blob is inaccessible until 30 days have passed.** [search] https://vercel.com/docs/vercel-blob/usage-and-pricing
- Pro rates: $0.023 per GB-month (varies by region, $0.023–$0.041), $0.40 per million simple operations, $5.00 per million advanced operations, $0.05 per GB transfer. [search] same
- Hobby rate limits: 1,200 simple operations/min and 900 advanced operations/min. The max file size is 5 TB. Blobs over 512 MB always miss the cache. [search] same

### Consequences for health photos
- Use a **private** store, serve only through an authenticated route or a short-lived presigned URL, and use random suffixes in pathnames. A user's `DELETE` should call `del()` on all of that user's blobs (deletes are free).
- On Hobby, 2,000 advanced operations/month is roughly 66 uploads/day. That is fine for dev and the simulator, but too small for production.

---

## 6. Postgres on Vercel

- **Vercel Postgres no longer exists.** Existing databases were moved to Neon in December 2024. New projects install Postgres from the **Marketplace** (Neon, Supabase, and others). [search] https://vercel.com/docs/postgres
- **Neon (Vercel-managed integration).** It injects `DATABASE_URL` (pooled; host has a `-pooler` suffix) and `DATABASE_URL_UNPOOLED` (direct), plus `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGDATABASE`, `PGPASSWORD` and the legacy `POSTGRES_*` variables for Vercel Postgres templates. [search] https://neon.com/docs/guides/vercel-managed-integration , https://neon.com/docs/changelog/2024-02-23
  - The set is configurable. Preview branch variables are injected per deployment. Setup fails if `DATABASE_URL` or `PG*` variables already exist in the project.
  - The Neon pooler is **PgBouncer in transaction mode**. Session-level `SET`/`RESET`, `LISTEN`/`NOTIFY`, SQL-level `PREPARE`, persistent temp tables, and **session-level advisory locks** are not supported. Protocol-level prepared statements work (max 1,000 per connection). Use the direct URL for migrations and `pg_dump`. [search] https://neon.com/docs/connect/connection-pooling
- **Supabase (Marketplace).** It syncs `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_USER`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWT_SECRET`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Pooled URLs go through Supavisor. Vercel has no IPv6, so direct connections need Supabase's IPv4 add-on. [search] https://supabase.com/docs/guides/integrations/vercel-marketplace
- **Pooling on Fluid compute.**
  - Create the pool once at module scope and call `attachDatabasePool(pool)` right after (`import { attachDatabasePool } from '@vercel/functions'`). Check out a client per request and release it in `finally`. [primary] https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
  - What `attachDatabasePool` does: it uses `waitUntil` to keep the instance alive until idle clients are closed, waiting `min(idleTimeout + 100 ms, time left before the deadline)`. It is **marked `@experimental`**. `experimental_attachDatabasePool` is a deprecated alias. [sdk-source] `@vercel/functions@3.10.4` `db-connections/index.{d.ts,js}`
  - Pool types it supports: `pg`, mysql2, mariadb, mongodb, ioredis, cassandra, and anything duck-typed like them. [sdk-source] same
  - It reads `pg` `idleTimeoutMillis` (default 10,000 ms if unset). [sdk-source] same
  - It is active only when `VERCEL_URL` and `VERCEL_REGION` are set. [sdk-source] same
  - Vercel's KB also recommends rolling releases to avoid connection storms. Its pool-size advice reads ambiguously (it warns against max=1). [search] https://vercel.com/kb/guide/connection-pooling-with-functions , https://vercel.com/kb/guide/efficiently-manage-database-connection-pools-with-fluid-compute
- **Region:** keep the Neon or Supabase region next to the function region (`iad1` maps to AWS us-east-1).

---

## 7. Next.js 16 specifics (latest `next@16.4.3`; `create-next-app@16.4.3`; canary is 16.5.0-canary.31)

- **Runtime and tooling minimums:** Node **≥ 20.9.0** (`engines` in next/package.json), TypeScript ≥ 5.1, browsers Chrome/Edge/Firefox 111+ and Safari 16.4+. [sdk-source] `npm view next engines` ; [primary] `dist/docs/01-app/02-guides/upgrading/version-16.md`
- React peer dependency is `^18.2 || ^19`. The App Router uses the built-in React canary, which includes **React 19.2** (View Transitions, `useEffectEvent`, `<Activity>`). The React Compiler is stable but off by default (`reactCompiler: true`). [sdk-source] ; [primary] version-16.md
- **`middleware.ts` → `proxy.ts`.** The file and the `middleware` export are deprecated. Use `export function proxy(request)` (or a default export) plus `export const config = { matcher }`. [primary] `03-file-conventions/proxy.md`, `middleware.md`
  - **Proxy runs only on the Node.js runtime.** Setting `runtime` in proxy.ts throws.
  - Config flags were renamed, e.g. `skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`.
  - Codemod: `npx @next/codemod@canary middleware-to-proxy .`
  - Without a matcher, Proxy runs on every request, including `_next/static` and images.
  - The docs warn that Proxy must not be the only auth layer. Server Functions are POSTs to the page route, so a matcher change can silently drop coverage.
- **The Edge runtime is deprecated** (`runtime = 'edge'`). `nodejs` is the default. With Cache Components on, **remove any `runtime` export, including `'nodejs'`**. [primary] `02-route-segment-config/runtime.md`
- **Turbopack is the default for `next dev` and `next build`.** Opt out with `--webpack`. A build with a custom `webpack` config **fails** under Turbopack. Config lives under the top-level `turbopack` key. The filesystem cache is on by default. [primary] version-16.md
- **`next lint` is removed.** Use `eslint` directly (scripts: `"lint": "eslint"`). `next build` no longer lints. `serverRuntimeConfig` and `publicRuntimeConfig` are removed in favour of env vars. [primary] version-16.md
- **Async Request APIs only.** `cookies()`, `headers()`, `draftMode()`, `params`, and `searchParams` must be awaited. `npx next typegen` generates the `PageProps`, `LayoutProps`, and `RouteContext<'/users/[id]'>` helpers. [primary] version-16.md, `03-file-conventions/route.md`
- **Route Handlers.** `export async function GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS(request: NextRequest, ctx)`. Unsupported methods return 405. [primary] `01-getting-started/15-route-handlers.md`
  - **Without Cache Components:** handlers are not cached by default, and a GET can opt in with `export const dynamic = 'force-static'`.
  - **With Cache Components:** a GET handler is **prerendered at build time if it reads no request or uncached data**. Prerendering stops when the handler reads `request.headers`, `request.url`, the body, `cookies()`, `headers()`, or `connection()`, or does a network or DB call. `dynamic`, `dynamicParams`, `revalidate`, and `fetchCache` are removed when Cache Components is on.
- **`cacheComponents`** is a stable top-level flag in v16. The docs say to set it together with `partialPrefetching: true`; leaving that unset logs a warning. It enables `use cache`, `cacheLife`, and `cacheTag`, and makes PPR the default. Uncached data accessed in pages must sit under `<Suspense>` or be cached, otherwise dev and build warn or error. [primary] `05-config/01-next-config-js/cacheComponents.md`, `02-guides/public-static-pages.md`
- **create-next-app.** `npx create-next-app@latest <dir> --yes` uses the recommended defaults: **TypeScript, ESLint, no React Compiler, Tailwind, no `src/`, App Router, Cache Components, AGENTS.md, agent feedback**, Turbopack, and the `@/*` alias. [primary] `03-api-reference/06-cli/create-next-app.md`, `01-getting-started/01-installation.md`
  - Flags: `--ts|--js`, `--tailwind`, `--react-compiler`, `--cache-components` (on by default for App Router), `--eslint|--biome|--no-linter`, `--app`, `--api` (route handlers only), `--src-dir`, `--turbopack|--webpack`, `--import-alias <a>`, `--empty`, `--use-npm|--use-pnpm|--use-yarn|--use-bun`, `--skip-install`, `--disable-git`, `--agents-md`, `--agent-feedback|--no-agent-feedback`, `--reset-preferences`, `--yes`. Any default can be negated with `--no-*`.
  - The generated `AGENTS.md` points coding agents at `node_modules/next/dist/docs/`. `next dev` keeps it up to date on 16.2 and later.
- **sharp.** `next@16.4.3` has `sharp ^0.35.5` as an **optionalDependency** (sharp 0.35.5 needs Node ≥ 20.9.0). `sharp` is in Next's default `serverExternalPackages` list, so it is not bundled. Using it in a Route Handler only needs the default Node runtime. [sdk-source] next/package.json, `npm view sharp` ; [primary] `05-config/01-next-config-js/serverExternalPackages.md`
- **`next/image` defaults changed:** `minimumCacheTTL` is 4 h, `qualities` is `[75]`, local IPs are blocked, and `maximumRedirects` is 3. These only matter if we use `<Image>`. [primary] version-16.md
- **Version check:** the bundled `after.md` is identical to `raw.githubusercontent.com/vercel/next.js/canary/docs/01-app/03-api-reference/04-functions/after.mdx`, and `proxy.mdx` matches on runtime. [primary]

---

## 8. Password-protecting `/admin`

- **Vercel Deployment Protection** works per deployment URL, not per path. [search] https://vercel.com/docs/deployment-protection , https://vercel.com/docs/deployment-protection/usage-and-pricing
  - **Vercel Authentication** (log in with a Vercel account that is on the team) is **free on all plans, including Hobby**.
  - **Standard Protection**, the recommended default and available on all plans, protects **every URL except production domains**: previews and generated deployment URLs.
  - **"All Deployments"** scope also covers production. Sources conflict on whether Hobby gets it.
  - **Password Protection is not available on Hobby.** Pro: **$20/month per protected project**. Enterprise: included. Teams on the legacy "Advanced Deployment Protection" package pay $150/month.
  - Passport and Trusted IPs are Enterprise-only.
- Protected deployments **block automated callers** (webhooks, Cron Jobs, e2e tests). The fix is **Protection Bypass for Automation**: send `x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET` as a header (recommended) or as a query parameter. [primary] https://vercel.com/docs/deployment-protection/automated-agent-access ; [search] https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
  - So deployment-wide protection on production would break the Sendblue and Stripe webhooks unless they carry the bypass secret.
  - Webhooks pointed at *preview* URLs are blocked by Standard Protection. Use the bypass query parameter if a provider can't set headers.
- The protection API takes `passwordProtection: { deploymentType: 'prod_deployment_urls_and_all_previews' | 'all' | 'preview' | 'all_except_custom_domains', password }`. [primary] https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/password-protection
- **Conclusion:** on Hobby, and even on Pro to avoid a $20/month add-on that protects the whole deployment, do **app-level auth for `/admin`**. One way is HTTP Basic in `proxy.ts` with `matcher: ['/admin/:path*', '/api/admin/:path*']` and a constant-time compare against an env secret, **plus** the same check inside admin route handlers and pages, as the Next docs advise. Next's auth guide covers optimistic checks in Proxy and a data access layer. [primary] next@16.4.3 `02-guides/authentication.md`

---

## Implications for our design

1. **Cron and plan (flag for the owner, per the spec).** Hobby cannot run the 15-minute check-in cron. Putting `*/15 * * * *` in `vercel.json` **breaks every deploy on Hobby**.
   - Build the cron handler as **plan-agnostic and catch-up based**. Each run selects all users whose check-in slot is due and not yet sent, with a unique `(user_id, slot_kind, local_date)` constraint so duplicate or overlapping runs are harmless. Frequency then only changes timing granularity.
   - On Hobby, ship `vercel.json` with one **daily** schedule (or no cron) and test with `vercel crons run` or a manual call. Switch to `*/15 * * * *` when on Pro. `vercel.ts` makes this env-driven.
   - The handler checks `Authorization: Bearer ${CRON_SECRET}` and must read `request.headers`, which also keeps it dynamic under Cache Components.
2. **Upgrade to Pro before taking money (milestone 7) and ideally before real users.** The Fair Use rules forbid payment processing on Hobby, and Hobby gets *paused*, not billed, when it exceeds quotas, which would take the coach offline.
3. **Webhook → background turn.** The route verifies the signature, inserts the inbound message (unique on provider message ID), and returns 200 quickly. Then `after(() => processUserBurst(userId))`.
   - The `after` work does the following: sleep about 4 s; take a **DB lease** on the user (e.g. `UPDATE users SET turn_lock_until = now()+interval '5 min' WHERE id=$1 AND (turn_lock_until IS NULL OR turn_lock_until < now()) RETURNING`, or `pg_advisory_xact_lock` inside a transaction). **Session-level advisory locks do not work through the Neon or Supabase poolers.** Then process every pending message in one turn; release the lease; loop if new messages arrived meanwhile.
   - Export `maxDuration = 300` on webhook routes (Hobby maximum) and call `getDeadline()` to stop safely.
4. **Durability gap.** `after()` work dies with the invocation. Mark rows `pending` → `processing` → `done`, and have the cron (daily on Hobby, every 15 min on Pro) or the next inbound message re-drive stale `pending` rows. Keep the background runner behind an interface:
   - `AfterRunner` (default, uses `next/server` `after`)
   - `InlineRunner` (Vitest and simulator tests, awaits directly, because `after()` throws outside a request scope)
   - `QueueRunner` (optional later, Vercel Queues with `delaySeconds: 4`, `idempotencyKey: providerMessageId`, consumer route with `handleCallback`)
   Queues' experimental `concurrencyKey` could later replace the DB lease.
5. **Fluid concurrency.** No per-request state in module scope. One `pg` Pool per instance at module scope with `attachDatabasePool(pool)`. The Anthropic client can also be a module singleton. Waiting on Anthropic costs provisioned memory but not CPU. With 2 GB instances, Hobby's 360 GB-h/month covers about 650k instance-seconds. That is roughly 30k turns at 20 s of wall time each if they don't overlap; concurrent turns share an instance and cost less. This is my own rough estimate.
6. **Images.**
   - Simulator uploads must stay under **4.5 MB**. Downscale in the browser with a canvas, to Anthropic's recommended long edge (see `docs/research/anthropic.md`), before POSTing to a Route Handler; or use Blob client upload. Don't use Server Actions for uploads (1 MB default).
   - Inbound provider media is *fetched* by our function, so the 4.5 MB request limit doesn't apply. Resize with `sharp` (Node runtime, external by default) or `@vercel/blob` `putImage`.
   - Exclude webhook and upload routes from the `proxy.ts` matcher, so Proxy doesn't buffer or touch raw bodies needed for signature checks.
7. **Photo storage.** Use a **private** Blob store (`access: 'private'`). Serve photos to `/admin` only through an authenticated route using `get()`, or a presigned URL valid for at most a few minutes. Pathnames should look like `users/<uuid>/<random>.jpg`. `DELETE` removes the blobs. Never log blob URLs together with message bodies. Hobby allows about 2,000 uploads/month, which is fine for dev only. Env: `BLOB_READ_WRITE_TOKEN` (or OIDC with `BLOB_STORE_ID`).
8. **Postgres.** Default to Neon through the Vercel Marketplace. The app uses `DATABASE_URL` (pooled). drizzle-kit migrations use `DATABASE_URL_UNPOOLED`. Pin the function region to the database region; the default `iad1` pairs with Neon us-east-1. The driver choice (`pg` + `attachDatabasePool` vs `@neondatabase/serverless`) belongs to the Postgres/Drizzle research.
9. **Next.js scaffold.** Use `npx create-next-app@16.4.3 . --ts --app --eslint --tailwind --no-src-dir --import-alias "@/*" --use-npm`, and **decide on Cache Components**. I recommend `--no-cache-components`. With it off, every route handler is dynamic by default, so a cron or health GET is never frozen at build time, and the `/admin` page doesn't need Suspense around its DB queries. Log this in DECISIONS.md.
   - Use `proxy.ts`, not `middleware.ts`.
   - No `runtime = 'edge'` anywhere.
   - Set `"engines": { "node": ">=20.9" }` (24.x on Vercel is fine).
   - Lint with `eslint`, not `next lint`.
10. **Admin auth.** App-level HTTP Basic (`ADMIN_USER` / `ADMIN_PASSWORD` env, timing-safe compare) in `proxy.ts` for `/admin/:path*`, with the same check repeated in admin handlers. Leave Vercel's **Standard Protection** on, which covers previews only, so production webhooks keep working. Gate `/dev/chat` the same way, or disable it when `VERCEL_ENV === 'production'`.
11. **.env.example additions from this research:** `CRON_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BLOB_READ_WRITE_TOKEN` (or `BLOB_STORE_ID`), `ENABLE_SIMULATOR`.

## Open questions for the product owner

1. **When will you move the Vercel account to Pro?** It costs $20/month plus usage, and it has two effects. (a) The 15-minute check-in cron cannot run on Hobby. Until Pro, check-ins can fire at most once a day, at an hour-level time, or only when triggered by hand. (b) Hobby forbids commercial use, including taking Stripe payments. Proposed default: develop on Hobby, upgrade before milestone 5 goes to production or before milestone 7, whichever comes first. Is that acceptable, or do you want a free external scheduler (e.g. a GitHub Actions schedule calling the cron URL with `CRON_SECRET`) while on Hobby?

## Risks

- **Hobby Terms:** running the paid product on Hobby breaks the Fair Use and Terms rules and risks the account being paused.
- **Hobby quota exhaustion pauses the project** (no overage billing), and Blob stays locked for 30 days. Users' texts would go unanswered.
- **Lost turns:** `after()` and `waitUntil` are not durable and are cancelled at `maxDuration`. The webhook already returned 200, so the provider won't retry. Mitigation: pending rows plus a sweeper, and later Queues if needed.
- **Cron is best-effort:** runs can be missed or duplicated, there are no retries, and runs can overlap. Proactive sends must be idempotent and respect daily caps in the database.
- **Queues are beta** (`queue/v2beta`, `experimentalTriggers`, `experimental_concurrencyKey`), so names and semantics may change. Messages are pinned to the deployment that sent them, so long delays deliver to stale code.
- **4.5 MB payload cap** on uploads and on any response, such as serving full-size photos.
- **Pooler semantics:** transaction-mode pooling breaks session-level advisory locks and `SET`. `attachDatabasePool` is marked experimental.
- **Cache Components footgun:** if enabled, a GET handler that reads no request data is prerendered at build time.
- **Many Vercel limits are only `[search]`-verified**, because `vercel.com` is blocked here: the cron table, function limits, payload cap, Blob pricing and quotas, Queues pricing, and Fair Use wording. Re-check them before relying on exact numbers.
- **"Vercel Schedules"** (one-shot `at` schedules) looks like an emerging feature with unverified availability and plan limits.

## Sources

- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://vercel.com/docs/cron-jobs/manage-cron-jobs
- https://vercel.com/docs/cron-jobs/quickstart
- https://vercel.com/changelog/cron-jobs-now-support-100-per-project-on-every-plan
- https://vercel.com/kb/guide/troubleshooting-vercel-cron-jobs
- https://vercel.com/changelog/attack-challenge-mode-now-allows-verified-bots-and-vercel-cron-jobs
- https://vercel.com/docs/cli/crons
- https://vercel.com/docs/cli/release-notes
- https://vercel.com/docs/project-configuration/vercel-json
- https://vercel.com/docs/project-configuration/vercel-ts
- https://vercel.com/docs/limits/fair-use-guidelines
- https://vercel.com/legal/terms
- https://vercel.com/pricing
- https://vercel.com/docs/plans
- https://vercel.com/docs/plans/hobby
- https://vercel.com/docs/plans/pro-plan
- https://vercel.com/kb/guide/why-is-my-account-deployment-blocked
- https://vercel.com/docs/fluid-compute
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/limits
- https://vercel.com/docs/functions/configuring-functions/duration
- https://vercel.com/docs/functions/configuring-functions/memory
- https://vercel.com/docs/functions/configuring-functions/region
- https://vercel.com/docs/functions/usage-and-pricing
- https://vercel.com/docs/fundamentals/what-is-compute
- https://vercel.com/blog/scale-to-one-how-fluid-solves-cold-starts
- https://vercel.com/docs/errors/FUNCTION_PAYLOAD_TOO_LARGE
- https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
- https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
- https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
- https://vercel.com/docs/queues
- https://vercel.com/docs/queues/sdk
- https://vercel.com/docs/queues/pricing
- https://vercel.com/docs/queues/api
- https://vercel.com/docs/pricing/regional-pricing
- https://vercel.com/changelog/vercel-queues-now-in-public-beta
- https://vercel.com/changelog/queues-now-supports-7-day-ttl
- https://vercel.com/docs/workflows/pricing
- https://vercel.com/docs/vercel-blob/private-storage
- https://vercel.com/docs/vercel-blob/usage-and-pricing
- https://vercel.com/docs/vercel-blob/using-blob-sdk
- https://vercel.com/docs/vercel-blob/vercel-signed-urls
- https://vercel.com/changelog/vercel-private-blob-is-now-generally-available
- https://vercel.com/changelog/vercel-blob-now-supports-consistent-reads-on-private-storage
- https://vercel.com/docs/postgres
- https://vercel.com/kb/guide/connection-pooling-with-functions
- https://vercel.com/kb/guide/efficiently-manage-database-connection-pools-with-fluid-compute
- https://neon.com/docs/guides/vercel-managed-integration
- https://neon.com/docs/changelog/2024-02-23
- https://neon.com/docs/connect/connection-pooling
- https://supabase.com/docs/guides/integrations/vercel-marketplace
- https://vercel.com/docs/deployment-protection
- https://vercel.com/docs/deployment-protection/usage-and-pricing
- https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/password-protection
- https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
- https://vercel.com/docs/deployment-protection/automated-agent-access
- https://registry.npmjs.org/next/16.4.3 (tarball `dist/docs/**`, `dist/server/after/**`, package.json)
- https://registry.npmjs.org/create-next-app (16.4.3)
- https://registry.npmjs.org/@vercel/functions (3.10.4)
- https://registry.npmjs.org/@vercel/blob (2.8.2)
- https://registry.npmjs.org/@vercel/queue (0.10.0)
- https://registry.npmjs.org/vercel (65.7.0)
- https://registry.npmjs.org/sharp (0.35.5)
- https://raw.githubusercontent.com/vercel/next.js/canary/docs/01-app/03-api-reference/04-functions/after.mdx
- https://raw.githubusercontent.com/vercel/next.js/canary/docs/01-app/03-api-reference/03-file-conventions/proxy.mdx
- https://github.com/vercel/vercel/blob/main/packages/functions/src/wait-until.ts
- https://github.com/vercel/vercel/blob/main/packages/functions/src/db-connections/index.ts

## Critic addendum (2026-10-29)

Completeness-critic pass, appended to this file without changing the content above. Tags as above.

**1. "The owner is on Hobby" is now verified.** The TL;DR asserted it without a source. The Vercel API (`GET /v2/user` via the Vercel MCP `get_auth_user`) returns `billing.plan: "hobby"` and `billing.status: "active"` for the authenticated user [primary: Vercel REST API response, 2026-10-29]. The user's `defaultTeamId` (scope `s-n123s-projects`) could not be read: `GET /v2/teams/{id}` returned **403 forbidden**, because the MCP connection isn't authorized for that team scope. So the *team's* plan is unconfirmed. If projects live under that team, the owner should confirm its plan, or grant the connection team access. The SPEC's "flag it if my Vercel plan can't run that often" is therefore **confirmed to apply**: Hobby cannot run `*/15 * * * *`.

**2. Cron frequency and duration limits are still [search] only.**
- The Vercel docs MCP returned cron *configuration* excerpts (vercel.json/vercel.ts `crons`, `CRON_SECRET` bearer pattern, `x-vercel-cron-schedule`, `vercel crons run`). Several queries returned **no** text from `cron-jobs/usage-and-pricing` or `functions/limitations` (once-per-day Hobby limit, hourly precision, the 300 s/800 s durations, the 4.5 MB body cap).
- `mcp__Vercel__web_fetch_vercel_url` can't fetch vercel.com/docs (404 "deployment could not be found").
- Grepping the `vercel@65.7.0` CLI bundle found no Hobby cron-frequency check, so enforcement happens server-side at deploy.
- These numbers stay [search]. Before writing the README: deploy once with a daily schedule, try `*/15` on a preview branch, and record the actual error.

**3. Cross-note inconsistencies to settle in DECISIONS.md.**
- **Turn lock.** §Implications 3 above offers `pg_advisory_xact_lock` inside a transaction as an alternative. database.md §5 rejects that for turns: it pins a pooler backend for the whole 10–60 s LLM turn and blocks Neon scale-to-zero. **Use database.md's lease row** (`process_after` debounce plus `lease_owner`/`lease_expires_at` with fencing). The `UPDATE users SET turn_lock_until …` sketch above is the same idea on a different table; pick one table (database.md's `conversation_state`).
- **Duration budget.**
  - database.md §5.5 uses `maxDuration = 120` with a 150 s lease, as an example.
  - This file uses `maxDuration = 300` (the Hobby max).
  - anthropic.md §8 suggests an SDK `timeout` of 60–90 s with `maxRetries: 2`. A timeout is retried (anthropic.md §7), so one model call can take about 3 × 90 s = 270 s plus backoff, and a tool loop makes several calls.
  - Those three settings don't fit together. **Default:** `maxDuration = 300` on the turn route; lease TTL > 300 s (e.g. 330 s); one turn-level deadline from `getDeadline()`; each model call gets `timeout = min(60 s, remaining − 20 s)` with `maxRetries` 0–1 inside the loop. If the deadline hits, end with the canned "give me a sec" reply plus a re-drive by the sweeper. This is my synthesis, not a vendor rule.
- **Images through sharp on Vercel.** §7 says sharp works in a Node route handler, which is true for JPEG/PNG/WebP/AVIF. But prebuilt sharp **cannot decode HEIC**; see imessage-providers.md, Critic addendum §4. Plan a separate HEIC decoder.
- **Outbound media vs private Blob.** Private storage for health photos is right. But Sendblue outbound `media_url` must be public and unsigned. See imessage-providers.md, Critic addendum §5 for the resolution.

Sources for this addendum:
- Vercel REST API `GET /v2/user` and `GET /v2/teams/{teamId}` (via Vercel MCP, 2026-10-29)
- https://vercel.com/docs/cron-jobs/manage-cron-jobs , https://vercel.com/docs/project-configuration/vercel-json , https://vercel.com/docs/cli/crons (via Vercel docs MCP)
- https://registry.npmjs.org/vercel (65.7.0 tarball `dist/**`, grep only)
