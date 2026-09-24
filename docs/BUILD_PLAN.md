# S-Corp Readiness (working name): build plan, stack response and first build

Reply to SPEC.md v0.1 §0.2, revised 2026-09-24 by the lead engineer after adversarial review of the first draft against the spec, the six analyst reports and the bundled `claude-api` skill. No code has been written; the only repository change is this file and `docs/SPEC.md`.

How to read this: to approve or redirect, read §1, §4 (seven stack departures and the paid-services list), §9 (questions, Phase 0 blockers first) and §10 (what gets built first). Tax rulings live in §6 (the TODO table; rows marked F#n change a §11 fixture outcome) and Q17–Q24. §3, §5, §7 and §8 are the engineering reference and can be skimmed.

## 1. Summary

This is the §0.2 reply for S-Corp Readiness (working name): a Phase 0–5 plan, a stack response and the first build. The repository holds an unrelated public Plaid/n8n landing page plus `docs/SPEC.md`; no code, manifest or CI. Recommendation: keep §14 and §7 except seven approvals listed in §4: structured output via `output_config.format`, an always-on pg-boss worker, Better Auth, forced Postgres RLS, one Docker host instead of Vercel, AWS S3 with customer-managed keys, and content edits through pull requests until a Phase 6 editor. Phases 0–5 total roughly 69–96 engineer-days (estimate, one engineer). Before Phase 0 can be called done the founder must answer Q1–Q3 (repository, auth library, code name). Phase 3 cannot close until Q17–Q22 are answered (the §1362(b) deadline, the §1374 period, 1120-S line mapping, whether a finding may cite an intake answer); fixtures 2, 4, 5 and 8 stay pending until then.

## 2. Repository and environment findings

- Commits: `357269d` index.html, `3b7b1a7` privacy.html, `175c8bd` docs/SPEC.md (identical to the scratchpad spec). The two pages describe a personal Plaid/n8n project marked "not offered to the public" with `noindex`. `privacy.html` may be the privacy URL registered with a Plaid application, so it must not be deleted or reused as this product's privacy page.
- The repository answers unauthenticated on the GitHub API (HTTP 200), so it is public today. Anything committed here is published; GitHub Pages is enabled on the repository (verified via the API, `has_pages: true`), so the root `index.html` is being served as a site. Consequence in Q1: the security runbook stays out of this repository until it is private, and a private repository on a personal Free plan has no enforced branch protection (§4 paid services).
- No `package.json`, lockfile, `.github`, Dockerfile or env files.
- Dev container: Node 22.22.2, pnpm 10.33.0, Playwright 1.56.1 with Chromium 1194 at `/opt/pw-browsers`. The Docker CLI (29.3.1) is installed but no daemon is running (`/var/run/docker.sock` is absent). PostgreSQL 16.13 server binaries exist at `/usr/lib/postgresql/16/bin` (`initdb`, `pg_ctl`, `postgres`) but `pg_ctl` is not on `PATH`, no cluster is initialised and nothing listens on 5432, 9000 or 1025. So `docker-compose` is not usable here; Phase 0 must be buildable with a locally started Postgres cluster, a filesystem storage adapter and a file-based mail transport (Phase 0 deliverables), with `docker-compose` reserved for the founder's machine and CI.
- Both spec model IDs exist in the skill catalog: `claude-sonnet-5` (Active) and `claude-opus-5-5` (Active, "launching; use only when the user names it"; §8.7 names it). The skill has no `SKILL.md`; `shared/*.md` and `typescript/claude-api/*.md` back every API fact in §5.

## 3. Phase-by-phase build plan

Conventions: `@scr/*` is the placeholder package scope (Q3); "NC" is the `Needs confirmation` severity; sizes and day ranges are estimates for one engineer excluding founder review time; entity fields are listed once in §7; mechanism detail lives in §5 (extraction) and §8 (security) and is not repeated per phase. Each phase ends with a full test run, a written summary and the open-TODO list (§0.3) before the next phase starts. Deliverables not named in §18's scope column are tagged "(added)" with the reason. Total for Phases 0–5: 69–96 engineer-days, roughly 14–19 weeks for one engineer (estimate; excludes founder review time and waits on Q17–Q22).

### Phase 0. Foundation

Scope (§18): repo, stack, auth, roles, firms, CI, fixture generator skeleton.

Deliverables:
- Monorepo (pnpm + Turborepo, no remote cache): `apps/web` (Next.js App Router, TypeScript, Tailwind 4, shadcn/ui; route groups `(auth)`, `(pro)`, `(owner)`, `(admin)`; `output: 'standalone'`), `apps/worker` (pg-boss, `/health`, Dockerfile on `mcr.microsoft.com/playwright:v1.56.1-noble`), `packages/{config,logger,db,jobs,storage,content,rules,extraction,fixtures,reports,tsconfig,eslint-config}`, `/content` at the repo root. Playwright pinned to 1.56.1 (the version present here).
- Package boundary: `packages/rules/src/types` holds the closed fact-type union and the Zod schemas for check, relief, `states.yaml` and `parameters.yaml` content (zod only). `packages/content` depends on rules to parse YAML; `packages/fixtures` and `packages/extraction` depend on rules for the fact union. dependency-cruiser rule: `packages/rules` imports no workspace package and only `zod` and `date-fns`; every other package may import rules.
- `packages/db`: Prisma schema for Firm, User, FirmMembership, ProfessionalAttestation, Invitation, MagicLinkToken, Engagement, EngagementParticipant, AuditLog, BreakGlassGrant (added: every later feature writes audit rows and the platform role needs a grant path from day one); RLS SQL in migrations; roles `app_migrator` (owner; also runs pg-boss's schema creation) and `app_runtime`; `withTenant`; a Prisma query extension that injects `where.firmId` on read/update/delete and asserts `data.firmId` on create for models in `TENANT_MODELS` (nested writes and raw SQL are covered by RLS only); `audit()`. Three connection strings: `DATABASE_URL` (pooled, web), `DATABASE_URL_DIRECT` (worker, pg-boss), `DATABASE_URL_MIGRATE` (owner role, CI).
- Auth: Better Auth with the two-factor, magic-link and organization plugins, as of our check on 2026-09-24; day-one task verifies the pinned version ships those plugins with Prisma and Next 15 App Router support, else the Auth.js + otplib path in §4. Attestation at signup; MFA forced before any `(pro)` page. Screens: sign-up with attestation, MFA enrolment, firm setup, users, engagement list and creation, owner invite; owner magic-link landing and expired-link page.
- `packages/content` and `/content` skeleton, with the §7 fields exactly: check YAML `id, title, what_it_tests, severity_rules, inputs, owner_explanation, professional_note, relief_paths, authorities, status, verified_by, verified_on`; relief YAML `id, name, when_it_applies, authority, typical_steps, notes, status`; `states.yaml` per state `community_property, requires_separate_s_election, status`. Additions to §7: `severity_rules = {default, variants}`; `typical_steps` accepts §7's plain strings and coerces them (assignee professional, no due date) or structured `{title, assignee, due_in_days, evidence_expected}`; `parameters.yaml`; `intake/`, `checklist/`, `report/`, `legal/attestation.md` (Phases 1 and 5). Skeleton `C01`–`C18` YAMLs (draft). `states.yaml` ships with the nine §7 community-property states as `community_property: true, status: draft` and every other value `unknown` (all 50 states and DC, `requires_separate_s_election: unknown` everywhere): no state value the spec does not give is written to `/content`; the fixture home state's values live in the fixture layer's override (Phase 3). Content hash and `VERSION.json`; forbidden-words lint over `/content` and UI string files with the allowlist (Q30).
- `packages/reports` ships only `htmlToPdf(html, opts)` (Playwright, Letter, printBackground, network aborted); report components arrive in Phase 5.
- `packages/fixtures` skeleton: scenario DSL, `corpBase()`, name tables, registry for scenarios 1–12 plus two additions outside the §11 gate (12b unconfirmed family groups, 13 prompt injection), `s01-clean` authored (`facts.json`, `expected-findings.json` with an empty set, `notApplicable` list and preconditions against the fixture override, `manifest.json`), the `form-2553` template rendered through `htmlToPdf` with page-count and citation-grounding tests, comparator with unit tests.
- Local dev in this container (added: no Docker daemon here): `pnpm db:local` runs `/usr/lib/postgresql/16/bin/initdb` and `pg_ctl start` into a scratch data directory and applies the role-init SQL; `packages/storage` exposes one interface with an S3 adapter and a filesystem adapter for local dev and unit tests; magic-link email uses Nodemailer's JSON-file transport locally. `docker-compose.yml` (postgres:16 with role-init SQL, MinIO with `MINIO_KMS_SECRET_KEY` so SSE headers are served, Mailpit, ClamAV profile) is the founder-machine and CI path. `.env.example`, `pnpm dev`, `db:migrate`, `db:seed`, `fixtures:*`.
- CI (GitHub Actions): lint (eslint, prettier, dependency-cruiser), typecheck, content, unit, db (Postgres service, migrations, isolation suite), e2e and fixture-render (service containers; run only on PRs to `main`, rendered fixtures cached), security (osv-scanner, gitleaks, `pnpm audit`, Dependabot: added, free, §16 asks for dependency scanning). Branch protection where the plan allows it (Q1). `docs/security.md` outline kept outside a public repository.

Key design decisions: tenancy and RLS as in §8 (policy `firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid`, transaction-local GUC, forced RLS under a non-owner role); AuditLog insert-only with a trigger blocking update and delete; platform admin has no firm membership and reads tenant rows only through an unexpired BreakGlassGrant; server-side sessions with proposed timeouts (professionals 30 min idle/12 h absolute, owners 30 min/24 h).

Tests proving "done when": Playwright: sign-up requires attestation and license fields; MFA forced before the engagement list; firm creation; owner invite produces exactly one captured email (file transport locally, Mailpit in CI); the link signs in once and fails on reuse, expiry and revocation; an A-firm professional requesting a B-firm engagement URL gets 404. Vitest on real Postgres: reflection over every exported DAL function against seeded firms A and B (no cross-firm rows read, written or deleted; B ids throw NotFound); raw SQL as `app_runtime` sees 0 rows on a fresh session with no GUC, 0 rows and no error on a session that ran a transaction-local `set_config` in an earlier committed transaction, only A rows with GUC A, and cannot insert B; schema-contract test that every `firmId` model has forced RLS and a policy, with `pgboss.*` and `_prisma_migrations` allowlisted; owner of E1 cannot read E2; platform context reads nothing without a grant and one engagement with one, every read audited; ripgrep test for Prisma use outside the DAL. Content schemas parse and lint passes; `s01-clean` validates, the 2553 renders to 2 pages, every citation grounds.

Size: L, estimate 10–14 days. Dependencies and open items: Q1 repository and visibility, Q2 auth library, Q3 code name. Hosting (Q10) and email (Q4) gate a hosted staging, not this phase's acceptance test.

### Phase 1. Intake and documents

Scope (§18): engagements, owner invite, questionnaire, uploads, checklist, classification.

Deliverables: `/content/intake/sections/A..I.yaml` as a declarative question graph (types, options, `allow_unknown`, `visible_when` DSL, `fact` mapping, `feeds_checks`, repeat groups, `why_we_ask`, status) cycle-checked in CI; `/content/checklist/<doc-type>.yaml` sharing the `when_required` expressions. Intake C gains spouse name, spouse citizenship/residency periods and marriage dates; intake H gains subsidiary entity type and acquisition dates (needed by C03, C05, C12). DB: the §7 intake, checklist, document and Fact entities. Owner portal: engagement home, intake sections with progress rail and "Why we ask", roster/trust/subsidiary wizards, review and submit, checklist with upload and "I don't have this", upload result with type correction. Professional: engagement overview, documents with page ranges, PDF.js viewer with reclassify, intake read-only view. Storage: presigned POST upload (1–50 MB, PDF only, server-chosen key under `firm/{firmId}/eng/{engagementId}/`, policy conditions carrying the SSE fields the bucket policy requires); `finalizeUpload` in web does only HeadObject and a ranged GET of the first bytes for `%PDF-`; page count, encrypted-PDF rejection and status live in the worker's `pdf_inspect` job, which then enqueues classification; audited 120 s presigned GET per view. Worker jobs: `pdf_inspect` (pdfjs per-page text, masked and encrypted, text-layer flag, page count), `classify` (heuristic boundaries on the text layer, then one text-window structured-output call per candidate range; PDF pages sent only where no text layer exists), `split` (pdf-lib), optional `scan` (ClamAV). `packages/extraction`: `ModelClient` with Live, Recording and Replay implementations; the replay path needs no SDK host override; a replay HTTP stub is added only if the SDK `baseURL` option is verified (§5 unverified list). `fixtures:record` refuses to write a classification recording whose segments do not equal `manifest.json`. The remaining fixture templates are finished here so Phase 2 has PDFs.

Key design decisions: raw answers are kept (IntakeResponse) and materialised into typed Facts with `feedsChecks`; intake facts are `asserted` until a professional accepts them per section (Q5); `unknown` answers produce a present-but-unknown fact so checks return NC; §4.1 engagement fields pre-fill §5A and owner corrections are queued as conflicts; CI classification uses recorded responses and a nightly live job measures accuracy.

Tests proving "done when": Playwright driven by `s01-clean/facts.json.intake`: hidden sections do not render, reload restores answers, submit sets `submittedAt`; every answer yields one Fact of the registry's type; checklist derivation for corporation, LLC and trust rosters; uploading the 13 fixture PDFs records sha256 and page count; the storage contract test runs against every adapter and asserts `x-amz-server-side-encryption` on the object where the S3 adapter runs (MinIO in CI), with `aws:kms` and the key ARN asserted only in the AWS staging smoke test; classification of every page range equals `manifest.json` in replay, including `return-2021.pdf` split into `form_1120s` + 3 × `schedule_k1`, plus one live recording of fixture 1 classification, manifest-checked at record time, committed as an explicit acceptance step; docType correction stores `previousDocType` and audits; view/download audit rows exist; 375 px and axe checks on intake, checklist and upload screens.

Size: L, estimate 10–14 days. Dependencies: Phase 0; Q4 (only for a hosted staging), Q5, Q6, Q7.

### Phase 2. Extraction

Scope (§18): schemas, extraction with citations, confidence, confirmation queue, SSN masking, reconciliation.

Deliverables: Zod schemas per document type with every leaf wrapped as `Cited<T> = {value, status: present|not_present|illegible, citations: [{page, snippet}], model_confidence: high|medium|low}`, `.strict()` objects, exported deterministically to `schemas/<docType>/<n>.json`: Form 2553 (plus `reliefStatement`, `consentDocumentRef`), CP261, K-1 (plus shares and period percentages if shown), 1120-S cover/Schedule B/M-2, stock ledger, governing documents (category, verbatim snippet, page, structured attributes), trust agreement, estate document, promissory note, equity award/83(b), Form 8832, Form 8869, state S election, distribution records, IRS correspondence. Nine of these are absent from §8.2 (1120-S, estate, promissory note, equity award, 8832, 8869, state election, distribution records, IRS correspondence) and feed C01, C02, C06, C09–C15 and C18. The 1120-S schema is a placeholder until Q21 names the lines (TODO-C13-7); until then C13 inputs are professional manual entry. Versioned prompts; ExtractionRun and PromptVersion rows; raw responses masked, encrypted with the per-engagement DEK and stored under `model-output/`. `maskTins()` on parsed values, raw output, cached page text, intake free text and filenames. Local citation verification against the pdfjs text layer plus a value-on-page check. Confirmation queue (filters, side-by-side viewer highlighting the cited page and snippet, confirm/edit/reject with reason, ask owner), owner confirmation requests, professional manual fact entry (C13 inputs, scanned pages), extraction runs list. Reconciliation job writing ReconciliationResult rows for six pairs (ledger % vs K-1 %, 2553 holders vs ledger on the election date, K-1 vs GL distributions, CP261 vs 2553 effective date, entity name/EIN across documents, K-1 count vs holder count) with tolerances from `parameters.yaml` (exact equality until Q20). Recorded outputs for all fixtures; fixture 13 (prompt injection) and a rasterised variant of fixture 1. Startup check on every configured model ID including fallbacks (§5).

Key design decisions: mechanism per §5 (`messages.parse` with `zodOutputFormat` on both models, no `tool_choice`, sampling parameters or prefill; base64 sub-PDF per page range; no Files API, and Batches only for synthetic fixture workloads); refusal → one retry on the env-named fallback, recorded, confidence capped at 0.7, then queue (Q14); confidence = min(model enum map, classification confidence, caps) with hard rules (never `auto` without a verified citation or with a client-side validation failure); `EXTRACTION_CONFIDENCE_THRESHOLD` required in staging and production; idempotency key `documentId:version:rangeIndex:promptVersionId`.

Tests proving "done when": per fixture 1–12 with replay, every required schema field has a Fact with status `auto|confirmed|queued`; a field with no citation is queued regardless of model confidence; every citation's page lies inside its range and its snippet grounds in the fixture PDF; `ssn.storage-scan.test.ts` iterates every text/JSON column (decrypting app-encrypted ones) and every non-original bucket object and finds no separated SSN pattern nor `000-00-0000`/`000000000` (originals excluded, Q15); `pagesSent` equals the page range and a mock SDK asserts the payload holds only those pages; fixture 11 yields a ledger-vs-K-1 ReconciliationResult and fixture 1 none; a `stop_reason: refusal` marks the run refused and queues the range; fixture 13 values equal fixture 1. One opt-in live smoke test: `models.retrieve` on every configured ID asserting `capabilities.structured_outputs.supported` and `capabilities.thinking.types.adaptive.supported`; fixture-1 2553 extraction with all citations verified on the primary and on `ANTHROPIC_MODEL_FALLBACK_EXTRACTION` with `parsed_output` non-null; one classification window on every configured ID; `cache_read_input_tokens > 0` on repeat; `BadRequestError` when `tool_choice: any` reaches the analysis model; the streamed analysis path returns a schema-conforming object.

Size: XL, estimate 16–22 days. Dependencies: Q10 hosting only for a hosted staging; Q11 Anthropic org and keys; Q12 threshold and `auto`; Q13 OCR; Q14 fallback retry.

### Phase 3. Timeline and checks

Scope (§18): timeline builder, content system, checks C01–C18.

Deliverables: `packages/rules`: `Known<T>` (`known | unconfirmed | missing`), `Timeline` (events, ownership intervals, attribute intervals including spouse residency, governing versions with provisions, distributions, debts, equity grants, family groups, gaps), derived `ownershipOn`, `shareholderCountSeries` with family aggregation, `attributeOn`, `sweep(window)`; `CheckResult` = `pass | finding{severity, variant, periods, evidence, reliefIds} | needs_confirmation{missing, reason} | not_applicable`; the runner converts every `needs_confirmation` result into a Finding with severity "Needs confirmation" so it participates in the §11 exact match and in sign-off (Q26); a `req()` helper and an access log that rewrites any `pass` that touched a non-known value into NC; C01–C18 as pure modules declaring `inputs`. `/content` filled: check YAMLs, relief YAMLs, `states.yaml`, `parameters.yaml` (election deadline and recognition period unset; trust-election counting convention; C09/C18 tolerances at exact equality; all draft). DB: CheckRun, Finding, FindingEvidence, FamilyGroup, ContentVersion snapshots written by CI on merge, engagements pinning a version. Screens: findings list and detail (evidence panel opening the viewer at the cited page), timeline view with document links, family-group editor with professional confirmation, content status page. Fixture layer 1 complete for all scenarios plus 12b, with `professional-facts.json` (confirmed family groups for 12, trust-type confirmations) and a content override that holds only the synthetic home state's `states.yaml` entry (`CO: community_property false, requires_separate_s_election false`); overrides never set a tax parameter the spec does not state.

Key design decisions: `auto` facts above threshold count as `known` (Q12) with the threshold recorded on each fact and the report stating how many facts were auto-accepted; `asserted`, `queued` and `conflicted` never do; C16 runs first and marks gap periods so dependent checks report `not_evaluated` for those periods, attached to the C16 finding (Q23); C18 marks both sides `conflicted`; trusts are evaluated by C06 only; evaluation window `[S effective date, asOf]` with pre-election facts listed in an Info note; every §6 ambiguity is coded as NC or a named variant, never a pass and never a silent skip; a finding whose only evidence is an intake answer or checklist status is emitted at NC with reason `evidence_kind_pending_ruling` until Q22 is answered; the content hash is sha256 over sorted path+bytes.

Expected sets per fixture (from the fixtures report; `(checkId, severity)` multiset; N/A = checks the engine must report `not_applicable`):

| # | Documents (delta from the 13-PDF base) | Expected | N/A | TODO ids that could flip it |
| --- | --- | --- | --- | --- |
| 1 | Base as is | `[]` | C06 C10 C11 C12 C13 C14 C17 | C15-1, C09-1, C18-1; Q23 |
| 2 | Formed 2023-01-03; 2553 signed 2023-09-15, no relief statement; CP261 for the same effective date | C02 High | C06 C12 C13 C14 C17 | C02-1 (Q17, pending), C02-2, C02-4 |
| 3 | Ledger gift 2022-06-01 to an irrevocable trust; trust agreement; K-1s at 10%; intake E "no election" | C06 High | C12 C13 C14 C17 | C04-1, C06-1, C06-9 |
| 4 | PDFs unchanged; intake C residency "nonresident alien" from 2023-08-15 | C04 Critical | C06 C12 C13 C14 C17 | EVID-1 (Q22, pending), C04-5 |
| 5 | Desmond resident in TX; intake C married 2024-03-10 to a nonresident alien | C05 Critical | C06 C12 C13 C14 C17 | EVID-1 (Q22, pending), C05-1, C05-2, C05-4 |
| 6 | LLC base with Form 8832; operating agreement §9.2 liquidates by capital accounts | C08 High | C06 C12 C13 C17 | C08-1, C14-1, C14-3 |
| 7 | Priya resident in OR; GL line 2024-04-15 state withholding for her only; intake F yes | C09 Medium | C06 C12 C13 C14 C17 | C09-1, C09-2, C09-3, C09-7, C18-3 |
| 8 | Formed 2018, C years 2018–2022, S from 2023; 1120-S covers with receipts, rents 45%, E&P each year | C13 Critical; C17 Info | C06 C12 C14 | C17-1 (Q18, pending), C13-1, C13-6, C13-7 (Q21, pending for the e2e path) |
| 9 | Revocable trust holds 500 sh from 2021-06-01; death 2023-10-15; asOf 2026-04-15 | C06 High | C12 C13 C14 C17 | C06-2 (Q19; period start unasserted), C06-4, C04-1 |
| 10 | GL marked not available; `return-2024` cover only; K-1 2024 marked missing | C16 NC | C06 C12 C13 C14 C17 | C16-4, C16-5 (Q23), C09-4 |
| 11 | Two holders 500/500 on ledger and 2553; K-1s 60/40; distributions 50/50 | C18 Medium (one finding, five periods) | C06 C12 C13 C14 C17 | C18-2, C18-4, C09-5 |
| 12 | Meridian Orchard Holdings; 120 holders; 20 confirmed family groups; 2023–2025 | `[]` | C06 C10 C11 C12 C13 C14 C17 | C07-2, C07-3, C03-4; Q23 |
| 12b | As 12 with no confirmed groups (outside the §11 gate) | C07 NC | as 12 | C07-1 |

Tests proving "done when": one Vitest case per scenario runs `runChecks(buildTimeline(facts), content, asOf)` through the shared comparator (preconditions first, multiset equality on `(checkId, severity)`, at least one evidence ref per finding, exact period starts unless marked unasserted, `notApplicable` reported as `not_applicable`); property test per check that removing or unknowning any declared input never yields `pass`; a test that every `pass` result's access log contains no `queued`, `asserted` or `conflicted` fact; determinism across two runs; content tests (ids match files, relief ids resolve, `inputs` equal the module's declaration and cover the access log, verified entries carry `verified_by/on`, VERSION.json matches, `/content/states.yaml` holds no non-`unknown` value outside the nine §7 states); timeline golden tests (ownership on each distribution date, count series for fixture 12); draft detection sets `usesDraftContent` on every fixture report; Playwright pipeline per scenario with replay, auto-confirming queued and asserted facts as the professional and entering fixture 8's C13 inputs by manual entry, findings page equals expected; timing budget on fixture 12.

Size: XL, estimate 16–22 days. Dependencies: the "done when" is conditional on founder-supplied values: fixtures 2 and 8 stay red on a precondition failure until Q17, Q18 and Q21 are answered, and fixtures 4 and 5 until Q22 is answered, by design under §0.4. The engineer can take 8 of 12 fixtures green alone. Other §6 answers change severities and expectations, not architecture.

### Phase 4. Review and remediation

Scope (§18): review UI, sign-off, follow-ups, remediation tracker, re-runs.

Deliverables: review actions (confirm, severity override with reason, dismiss with required reason, notes with `includeInReport` and audience); Task table (`follow_up|remediation`) created from relief `typical_steps` on confirmation; follow-up composer; owner task list and detail with reply and upload; SignOff row (license snapshot, `findingSetHash`, checkRunId, contentVersion, attestation text) invalidated by any finding change; "changes since last sign-off" view; re-run triggers (resolution with evidence, new DocumentVersion after extraction, fact change, reconciliation resolved, manual) coalesced by pg-boss singleton key; `irs-relief-letter` template, recorded IRS-correspondence extraction output for fixtures 2 and 3 committed via `fixtures:record` before the Playwright test runs, and `expected-findings.after-relief.json` for fixture 2; "Sign off" and "Release to owner" as separate actions (a §17 deviation, §4).

Key design decisions: resolution is a professional overlay keyed by fingerprint with evidence required (Q25); checks consult relief records only where the spec text says so (C02, C01); step-up MFA within 10 minutes for sign-off, release, retention change and break-glass.

Tests proving "done when": Playwright on fixtures 3 and 2: confirm the finding, open the generated task, upload the synthetic relief letter, extraction yields a ReliefRecord fact from the recording, resolution without evidence is rejected, resolution with evidence triggers a CheckRun, the finding shows `resolved` with its evidence and the engagement has 0 open High findings; empty reasons rejected; sign-off blocked while any finding lacks a decision and invalidated after an edit; owner tasks list passes axe on mobile; review decisions survive re-runs by fingerprint.

Size: L, estimate 10–14 days. Dependencies: Q25, Q26, Q27.

### Phase 5. Reports and export

Scope (§18): professional and owner reports, zip export, versioning.

Deliverables: `packages/reports` React components rendered with `renderToStaticMarkup` (Cover, ScopeAndLimitations from `/content/report/scope_and_limitations.yaml`, SummaryBySeverity, FindingSection with `data-verbatim` evidence and an "Evidence: owner statement" label where Q22 allows it, ResolvedSinceLastVersion, TimelineSummary, DocumentIndex, ContentStatusAppendix), inlined print CSS and fonts; `htmlToPdf` in the worker (JavaScript off, fresh context; header/footer with title, version, content version, page numbers; draft banner on every page when any used item is draft); owner version using `owner_explanation` and `/content/report/severity_labels.yaml`; Report rows per generation with ReportFinding snapshots and stored HTML; zip export via `archiver` with the ten §12 folders (numbered), `00 Report` and `99 Unclassified` pending Q29, page ranges split per document, `index.xlsx` via `exceljs`; forbidden-words lint over rendered report text, UI string files and any professional-authored text shown to owners, excluding `data-verbatim` and the allowlist, blocking release; reports page with versions, release and export.

Tests proving "done when": generation without a current SignOff → 409; rendered HTML has `data-section` ids in §12 order and the cover carries company, engagement, date, professional with license snapshot and content version; every footer carries the exact §2 title; lint fails generation when a note injects a forbidden word; banner present with draft content and absent with test content marked verified; fixture 1 shows the exact "No issues identified in the documents reviewed." sentence under Q28's condition; owner version invisible until release; zip top-level folder names, after stripping the numeric prefix, equal the §12 names in §12 order, with `00 Report` and `99 Unclassified` present only if Q29 answers yes; index rows match files by sha256; a second generation after the Phase 4 resolution yields version 2 with a resolved section citing the relief letter while version 1 stays byte-identical; audit rows for generate, release, download and export.

Size: M, estimate 7–10 days. Dependencies: Q10 worker host for a hosted staging; Q28–Q31.

### Phase 6. Post-pilot

Scoped after pilot feedback: Stripe billing (§20), firm branding on reports, QuickBooks/Xero import for distribution records (parsed without a model), an export package for tax-insurance submissions, an in-app content editor writing ContentVersion snapshots so founder edits need no pull request, optional local OCR for scanned uploads, a model-aware request builder so a cheaper classification model can be configured safely, and SOC 2 Type 1 preparation. Production re-extraction through the Batch API is not in Phase 6 unless Q40 accepts its 29-day retention. Nothing in Phases 0–5 would need reworking for these.

## 4. Stack: agreements, disagreements and questions

Seven departures from §14 and §7 need a yes or "prefer the spec" from the founder: (1) structured output via `output_config.format` instead of forced tool use; (2) an always-on pg-boss worker; (3) Better Auth; (4) forced Postgres RLS on `firmId` in every tenant table; (5) one Docker host instead of Vercel; (6) AWS S3 with customer-managed KMS keys; (7) content edits through pull requests until a Phase 6 editor. Two smaller deviations: "Sign off" and "Release to owner" as two actions (§17 gives one button; owner release is per version and may be withheld while draft content is used, Q31), and `typical_steps` optionally structured (§7 strings still accepted).

| §14 item | Spec proposal | Recommendation | Why |
| --- | --- | --- | --- |
| Framework | Next.js App Router, TypeScript, Tailwind, shadcn/ui | Agree; route groups per audience; `output: 'standalone'`; monorepo with `packages/rules` importing no workspace package | Two audiences in one codebase (§17); §10 purity is only enforceable as a separate package with a lint rule |
| Database | Postgres (Neon or Supabase) with Prisma | Agree on Prisma; Neon default, Supabase fallback; plain Postgres 16 locally and in CI; pooled URL for web, direct URL for the worker and migrations | Supabase's differentiators go unused under §14; an always-polling worker keeps Neon compute awake, so free-tier compute hours are consumed continuously (poll interval 5–10 s as mitigation) |
| Tenant scoping | DAL requiring a firm ID on every query, with tests | DAL plus forced RLS under a non-owner role, `firmId` on every tenant table, six test layers | §15 keys client-data tables by engagementId only; RLS backstops raw queries and nested writes |
| Auth | Auth.js or Clerk; MFA for professionals; magic links for owners | Better Auth (free) with two-factor, magic-link and organization plugins, as of our check on 2026-09-24, verified on day one; Auth.js + otplib as fallback; Clerk only with §0.6 approval | Auth.js has no built-in MFA as far as we could check; Clerk is paid and adds a PII processor. The security lens preferred Clerk for MFA correctness; a maintained plugin beats hand-rolled TOTP and the pre-pilot review covers the flow either way |
| Storage | S3-compatible, server-side encryption, short-lived signed URLs | AWS S3 with SSE-KMS customer-managed key per environment, presigned POST uploads, 120 s audited GETs, MinIO in CI, filesystem adapter locally; envelope encryption for snippets, raw outputs and page text | The spec requires server-side encryption, which every S3-compatible provider offers. AWS is recommended because customer-managed keys make per-engagement crypto-shredding and SOC 2 key-policy evidence simpler; of the providers considered (R2, Backblaze B2, Supabase Storage) none we checked offers customer-managed KMS keys, verify per provider; any of them is acceptable if the founder prefers, with application-level encryption covering the original PDFs |
| Background jobs | Inngest or pg-boss | pg-boss on one always-on worker container | Extraction with thinking and Playwright rendering run for minutes; pg-boss keeps job data in our Postgres; singleton keys coalesce re-runs |
| Anthropic SDK | PDFs as document inputs; structured output via tool use | `output_config.format` via `messages.parse` on both models; citations as schema fields verified locally; base64 sub-PDFs per page range | Forced `tool_choice` returns 400 on `claude-opus-5-5`; API citations are incompatible with structured outputs (§5) |
| PDF reports | HTML rendered with Playwright | Agree, worker only; the same path renders fixture PDFs | Chromium on Vercel is possible only with trimmed binaries and sits close to the bundle-size limit and the per-invocation duration ceiling (exact values plan-dependent; verify on vercel.com/docs at Phase 0); the worker container is the supported path |
| Testing | Vitest for rules and parsers; Playwright e2e | Agree, plus record-and-replay model responses, a nightly live job, real Postgres in CI | Sampling parameters are rejected on both models, so replay is the only deterministic path; RLS needs real Postgres |
| Deploy | Vercel + managed Postgres and S3; dev/staging/prod; staging fixtures-only | Option A: Vercel Pro web + worker container. Option B: one Docker host (Railway) for web and worker. I recommend B; the build supports both | B removes Vercel's per-invocation duration ceiling and roughly 4.5 MB request-body limit (verify current values) and one processor; A keeps preview deployments. Staging fixtures-only becomes a code check against the fixture manifest |
| Content editing (§7) | Edit legal text without a deploy | Content in git; edit YAML → PR → CI lint → merge → ContentVersion snapshot published, minutes, no code change; engagements pin a version; in-app activation in Phase 6 | Bundled content avoids runtime file reads, which we do not want to depend on across hosts; snapshots let old reports reproduce their wording |
| Observability | Implied by §2/§16 | pino with a typed allowlist and redaction; no error tracker or analytics at MVP; AuditLog; `/health` | §2 forbids document text in logs and trackers; Sentry is paid beyond its free tier |

Paid services needing approval under §0.6, with the free default used until told otherwise: GitHub Pro or an organisation Team plan if the repository is private (branch protection and rulesets are not enforced on private repositories under a personal Free plan) → public repository, or private with CODEOWNERS and a PR-only workflow without enforced protection; GitHub Actions minutes beyond the private-repository allowance → e2e and fixture-render jobs only on PRs to `main`, rendered fixtures cached; Vercel Pro (Hobby is non-commercial) → none, a Dockerfile; managed Postgres beyond free tier → local cluster and CI containers; worker host (Railway, Fly.io or Render) → worker in docker-compose; AWS S3 + KMS → filesystem adapter and MinIO, no bucket; transactional email (SES, Postmark, Resend) → Nodemailer against `SMTP_URL`, file transport locally, Mailpit in CI; Clerk → not used unless chosen; Inngest → not recommended; Sentry → none, self-hosted GlitchTip if a tracker is wanted; Anthropic API usage → separate workspaces and keys per environment with spend limits, fixtures only until terms are confirmed; Vercel Remote Cache and Vanta/Drata → not in MVP. Free additions included without asking: ClamAV behind a flag, MinIO, Mailpit, osv-scanner, gitleaks, Dependabot. Nothing is provisioned until the founder answers Q10.

## 5. Extraction pipeline design

Verified API facts (paths relative to the bundled `claude-api` skill; "live" = platform.claude.com page fetched 2026-09-24 by the analysts):

| Fact | Source |
| --- | --- |
| `claude-sonnet-5` Active, 1M context, 128K output; `claude-opus-5-5` Active, "launching; use only when the user names it"; `claude-opus-5` Active; `claude-haiku-4-5` 200K context, 64K output | `shared/models.md` L61–L71 |
| Sonnet 5 $2/$10 per MTok; effort default `high`; adaptive thinking when omitted; non-default temperature/top_p/top_k and prefill return 400; ~30% more tokens than Sonnet 4.6 | `shared/model-migration.md` Sonnet 5 section |
| Opus 5.5 $4/$20 per MTok, cache reads $0.20; thinking cannot be disabled; effort default `medium`; forced `tool_choice` 400s; 512-token minimum cacheable prompt carries over from Opus 5 | `shared/model-migration.md` L1868, L2020 (Migrating to Claude Opus 5.5) |
| Forced `tool_choice` (`any`/`tool`) returns 400 on Opus 5.5, also on `count_tokens` and Batches; `auto` may not produce a call; `output_config.format` is the documented replacement | `shared/tool-use-concepts.md` L106 |
| Structured outputs supported on Fable 5/5.1, Mythos 5/5.1, Opus 5, Opus 4.8, Sonnet 5, Haiku 4.5 (Sonnet 4.6 not listed); need `additionalProperties: false`, no recursion, no numeric/string constraints (SDK strips and validates client-side); incompatible with Citations (400) and prefill; work with batches, streaming, thinking | `shared/tool-use-concepts.md` L523–L560 |
| `client.messages.parse` with `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`; `parsed_output` null on failure; shown non-streaming only | `typescript/claude-api/tool-use.md` L560–L590 |
| `client.messages.stream()` + `finalMessage()` returns the complete `Message` | `typescript/claude-api/streaming.md` L162–L194 |
| Minimum cacheable prompt: 512 tokens on Opus 5 and Opus 5.5; 1,024 on Sonnet 5, Sonnet 4.6 and Opus 4.8; 4,096 on Haiku 4.5 (not monotonic across tiers) | `shared/prompt-caching.md` L135–L140 |
| `effort: max` errors on Haiku 4.5; Haiku 4.5 output caps at 64K; adaptive-thinking support on Haiku 4.5 is not stated | `shared/model-migration.md` L178, L305, L342 |
| `models.retrieve` exposes `capabilities.structured_outputs.supported`, `capabilities.thinking.types.adaptive.supported`, `capabilities.effort.<level>.supported` | `shared/models.md` L12–L52 |
| PDF requests: 32 MB and 600 pages; no password-protected PDFs; each page processed as image plus text (1,500–3,000 text tokens per page plus image tokens); no server-side page-range parameter | live `pdf-support.md` |
| API citations attach to text blocks, not JSON fields; scanned PDFs are not citable | live `citations.md` |
| Files API persists files until deleted; Batches 50% off, up to 24 h, results kept 29 days; neither is ZDR-eligible | `typescript/claude-api/files-api.md`, `batches.md`; live retention page |
| Refusal is HTTP 200 with `stop_reason: "refusal"`; SDK retries 429/5xx, `maxRetries` default 2 | `typescript/claude-api/README.md`; `shared/error-codes.md` |
| Commercial Terms bar training on Customer Content; content not retained by default for the two spec models (neither is a Covered Model); ZDR is org-level via sales; trust-and-safety-flagged content may be kept up to 2 years | anthropic.com/legal/commercial-terms; live retention page |

Unverified, to check on day one of Phase 2 with the pinned SDK version recorded in the result: whether `messages.parse` streams in the TS SDK; whether `claude-sonnet-4-6` accepts `output_config.format` (the skill's model list omits it while its migration text implies it); the SDK `baseURL` / `ANTHROPIC_BASE_URL` override (documented for the CLI only); server-side refusal fallbacks on Sonnet 5; per-tier rate limits; image-token cost per Letter page.

Mechanism choices:
- Stages: `upload → store_encrypted → pdf_inspect → classify → split → extract[range] → mask_and_store_raw → verify_citations → score → queue_or_auto → reconcile → timeline → checks`. `pdf_inspect` and `split` are local additions to §8.1.
- Extraction (`ANTHROPIC_MODEL_EXTRACTION=claude-sonnet-5`): `messages.parse` with `output_config.format = zodOutputFormat(schema)`, no `tool_choice`, `thinking: {type: "adaptive"}`, effort from `ANTHROPIC_EFFORT_EXTRACTION` (default `medium`), `max_tokens` 16,000, one base64 sub-PDF per range, system prompt cached (above 1,024 tokens on Sonnet 5; the request builder reads each model's minimum from a per-model table) with no engagement identifiers, document block before a fixed instruction.
- Analysis (`ANTHROPIC_MODEL_ANALYSIS=claude-opus-5-5`): same schema mechanism, effort from `ANTHROPIC_EFFORT_ANALYSIS` (default `medium`, set explicitly), `max_tokens` 64,000 so it must stream. If `parse` cannot stream, the code path is `client.messages.stream({ output_config: { format: zodOutputFormat(schema) }, ... })`, `await stream.finalMessage()`, then `schema.safeParse(JSON.parse(textBlock))` client-side (`zodOutputFormat` still strips unsupported constraints); one pass per §8.2 clause category over a document block carrying `cache_control` (512-token minimum), documents over ~40 pages chunked and merged by category; a `max_tokens` stop splits the input rather than raising the cap.
- Classification (`ANTHROPIC_MODEL_CLASSIFICATION`, default `claude-sonnet-5`): text windows with `=== PAGE n ===` markers and ~1,500 characters per page returning `segments[{start_page, end_page, doc_type, confidence}]`. Haiku 4.5 is not an MVP option: its effort ladder, 4,096-token cache minimum, 64K output cap and undocumented adaptive-thinking support differ from the shared request builder; a model-aware builder is a Phase 6 cost lever.
- Refusal fallback: one identical retry on `ANTHROPIC_MODEL_FALLBACK_EXTRACTION` (default `claude-opus-5`, on the structured-outputs list; `claude-sonnet-4-6` allowed only once the boot check below passes) or `ANTHROPIC_MODEL_FALLBACK_ANALYSIS` (default `claude-opus-5`), `response.model` recorded, confidence capped at 0.7, never for `reasoning_extraction` declines; hand-rolled rather than the beta server-side fallback so it works with `messages.parse` and is auditable (Q14).
- Startup: `client.models.retrieve()` on every configured ID including fallbacks; refuse to boot on 404 or when `capabilities.structured_outputs.supported` or `capabilities.thinking.types.adaptive.supported` is false or the configured effort level is unsupported; production refuses a Covered Model unless `ACCEPT_30_DAY_RETENTION=true`.
- Confidence: enum map (high 0.9, medium 0.6, low 0.3) combined by `min()` with classification confidence and caps (no citation 0.3, `not_found` 0.4, `adjacent_page` 0.8, `no_text_layer` 0.6, value not on page 0.5, Zod failure 0.2 and always queued, cross-document disagreement 0.5, illegible 0.2, fallback-served 0.7); components persisted for the queue UI.
- Batches: `EXTRACTION_USE_BATCH` applies only to synthetic fixture workloads (recording runs, regression sweeps). Client documents never go through Batches or the Files API; production re-extraction after a prompt bump runs on `/v1/messages` unless Q40 accepts Batch retention.
- Cost: roughly $8–9 per engagement (200 extraction pages on Sonnet 5, 60 governing pages on Opus 5.5 at medium with cached multi-pass, 20% retries); an estimate to be measured on the first recorded fixture run.

## 6. Rules engine: TODO flags for founder review

### Where the spec contradicts itself (needs a ruling)

- C04 "non-qualifying trust" (Critical) overlaps C06 (High); fixtures 3 and 9 expect only C06. Until ruled, C04 skips trusts (TODO-C04-1).
- C13 needs accumulated E&P, gross receipts and passive investment income per year; §5, §6 and §8 collect none of them. Until ruled, professional manual entry (TODO-C13-1, C13-7; Q21).
- §5C collects marital status but not spouse identity, residency or marriage date, so C03 spousal consent and C05 cannot run; Phase 1 adds the fields (TODO-C03-2, C05-1).
- C14's "deemed election with the Form 2553" makes C14 unreachable unless C01 also fires (TODO-C14-1).
- §11 rows 1 and 12 are negatives ("No Critical or High", "No C07 finding") while the acceptance says "match exactly"; read as empty expected sets with `not_applicable` lists (Q23). Row 10 is read as C16 only, with dependents folded in (TODO-C16-5; Q23).
- §2 "every finding cites the documents and pages" cannot hold for fixtures 4, 5 and 10 or any absence finding (TODO-EVID-1; Q22).
- §1362(b) deadline, §1374 recognition period, counting conventions and tolerances are not stated; they are founder-supplied parameters (Q17–Q20).
- §17's single "Sign off and release report" button conflicts with §12's per-version owner release; two actions (§4).
- §7 "edit without a deploy" conflicts with "version the content directory"; pull-request path until Phase 6 (§4).

Rows that change a §11 fixture outcome are marked "F#n" in the ambiguity column: C02-1, C02-4, C04-1, C04-5, C05-1, C05-2, C05-4, C06-2, C06-4, C06-9, C07-3, C08-1, C09-1, C09-2, C09-7, C13-1, C13-6, C13-7, C14-3, C15-1, C16-5, C17-1, C18-2, C18-4, EVID-1. Each row is coded exactly as its last column says; none is resolved by guessing. Draft numeric values live in `/content/parameters.yaml` with `status: draft`; values the spec does not give are unset.

| id | check | ambiguity | code behavior until resolved |
| --- | --- | --- | --- |
| TODO-GEN-1 | C04–C09, C13 | Do "any period" checks look before the S effective date? | Evaluate `[S effective date, asOf]`; Info note lists ignored pre-election facts |
| TODO-C01-1 | C01 | Which documents other than CP261 count as "other IRS confirmation"? | Only CP261 satisfies the prong; other IRS letters → NC citing the letter |
| TODO-C01-2 | C01/C02 | Does a prior relief letter satisfy C01 or suppress C02? | Recorded as `irs.correspondence[reliefLetter]`; C01 → NC |
| TODO-C01-3 | C01 | Two relief paths, one severity; is "no 2553 but CP261" High? | Variants `no_2553`, `no_irs_confirmation`, `no_election_on_record`, all High |
| TODO-C01-4 | C01 | Intake says CP261 exists, nothing uploaded, not marked missing: High or NC? | NC; only "I don't have this" fires High |
| TODO-C02-1 | C02 | F#2 What is the §1362(b) deadline, as months and days after the tax-year start? (Q17) | NC "deadline parameter not configured" until set |
| TODO-C02-2 | C02 | Which date is "filed" when the form shows none? | `filedDate` only; absent → NC; signed date never substitutes |
| TODO-C02-3 | C02 | When does the first tax year of a new entity start? | Effective dates within the formation year → NC |
| TODO-C02-4 | C02/C18 | F#2 Is a CP261 for the intended date "relief on record"? What if its date differs? | Match + late → High as written; mismatch → C18 plus C02 NC |
| TODO-C02-5 | C02 | The 2553 schema has no relief-statement field | `reliefStatement` added; unextracted → NC when late |
| TODO-C03-1 | C03 | Is "election date" the effective date, the filing date, or every holder between? | Evaluate both dates; differing holder sets → NC |
| TODO-C03-2 | C03 | Intake C lacks the spouse's name; how are spousal consents matched? | Married holder in a CP state without spouse identity → NC (never from TIN kind) |
| TODO-C03-3 | C03 | Does "community-property interest" follow acquisition timing? | Proxy = married + resident of a `states.yaml` CP state; labelled "spec proxy"; draft banner |
| TODO-C03-4 | C03 | How strict is name matching; who signs for trusts and entities? | Normalized exact match; else NC with both names cited |
| TODO-C03-5 | C03 | When the 2553 is missing, is C03 High or suppressed? | NC referencing C01, never High |
| TODO-C03-6 | C03 | Consents on separate statements | `consentDocumentRef`; missing → NC |
| TODO-C04-1 | C04/C06 | F#3 F#9 Do trusts belong to C04 or C06? | C04 skips trusts; content list `trust_types_never_eligible` starts empty; type other/unknown → NC |
| TODO-C04-2 | C04 | What exception does "IRA (generally)" imply? | Critical with the content note "generally"; no exception coded |
| TODO-C04-3 | C04 | Is a single-member LLC eligible through its member? | NC requesting member identity and type |
| TODO-C04-4 | C04 | Are estates, tax-exempt organisations and qualified plan trusts eligible? The list names neither | NC variant `unlisted_shareholder_type` for any holding period by a type not on the C04 list, until confirmed |
| TODO-C04-5 | C04 | F#4 Residency evidence exists only in intake (see EVID-1) | Evidence ref of kind `intake`; emitted at NC until Q22; never inferred from TIN kind |
| TODO-C04-6 | C04 | Does a §1362(f) letter suppress or resolve? | Emitted and marked resolved with the letter as evidence |
| TODO-C05-1 | C05 | F#5 Intake lacks spouse residency periods and marriage date | NC for every married holder in a CP state until confirmed (fields added in Phase 1) |
| TODO-C05-2 | C05/C04 | F#5 Is the NRA spouse a deemed shareholder for C04? | Not injected; only C05 fires |
| TODO-C05-3 | C05 | Spouse residency changes over time | Periods; unknown sub-intervals → NC |
| TODO-C05-4 | C05/C03/C15 | F#5 F#1 Which states are community-property? §7 says "verify" | Nine §7 states `true` (draft); every other state `unknown` → NC; draft banner |
| TODO-C06-1 | C06 | How are "2 months and 16 days" counted? (Q19) | addMonths (clamped) then addDays(16), day received excluded; filings within ±7 days of the due date → NC; convention in the note |
| TODO-C06-2 | C06 | F#9 Where does the 2-year window start for testamentary and post-death grantor trusts? (Q19) | Post-death grantor trust from the death date (§5E collects it); testamentary → NC; ±7 days at window end → NC; fixture 9's period start unasserted |
| TODO-C06-3 | C06 | What cures a late election? | Relief letter resolves; late filing alone stays High |
| TODO-C06-4 | C06 | F#9 Is a living-grantor grantor trust qualifying without an election? (Q19; C06's post-death 2-year window implies yes, and fixture 9 depends on it) | Qualified when the grantor-trust indicator is confirmed; else NC |
| TODO-C06-5 | C06 | Voting and "other" trusts | NC |
| TODO-C06-6 | C06 | Is an election due from the window end, and effective by it? | Election near window end → NC |
| TODO-C06-7 | C06 | Trust held shares before the S effective date | `sharesReceivedDate` < S effective → NC |
| TODO-C06-8 | C06 | Trust type appears in both §5C and §5E | §5C is the source; conflicts → NC |
| TODO-C06-9 | C06 | F#3 Does the period start at receipt or when the due date passes? | Date received (fixture 3 asserts 2022-06-01) |
| TODO-C07-1 | C07 | Should family groups be validated genealogically? | None; only confirmed groups aggregate; raw > 100 with unconfirmed groups → NC |
| TODO-C07-2 | C07 | How do trusts, estates and ESBT beneficiaries count? | Each non-individual counts 1; within 10 of 100 with trusts/estates → NC |
| TODO-C07-3 | C07 | F#12 Fixture 12 relies on an unstated confirmation | `professional-facts.json` shipped; 12b locks the NC outcome |
| TODO-C07-4 | C07 | Are non-shareholder spouses group members? | Only shareholders are members |
| TODO-C08-1 | C08 | F#6 Which clause categories are automatic High versus review-only? | High only for liquidation by capital accounts, preferred returns, non-proportional tax or distribution clauses, explicit non-identical rights; voting never; capital-account maintenance and redemption pricing → Info variant |
| TODO-C08-2 | C08 | What counts as a "binding agreement"? | §6-listed types only |
| TODO-C08-3 | C08 | How are amendments scoped by date? | `[max(version effective, S effective), superseded ?? asOf]`; unknown dates → NC |
| TODO-C08-4 | C08 | Authorized-but-unissued second class | NC variant |
| TODO-C08-5 | C08 | Conflicting clauses (savings clause) | High with both snippets; code does not rank |
| TODO-C08-6 | C08 | Clause attributes must be structured | Required in schema; low-confidence clauses → NC |
| TODO-C09-1 | C09 | F#7 What amount tolerance? (Q20) | Draft parameter at exact equality, the literal text; any deviation → Medium with the computed deviation shown |
| TODO-C09-2 | C09 | F#7 What timing window; event-level or annual? | Event-level with dated records (draft: same calendar day), annual with K-1 only; true-ups do not clear |
| TODO-C09-3 | C09 | Does later equalisation cure a withholding subset? | Fires as written; Info note if equalised in the same year |
| TODO-C09-4 | C09 | Mid-year ownership change, annual data only | NC for that year |
| TODO-C09-5 | C09/C18 | Which percentage when ledger and K-1 conflict? | Conflicted → NC for that year; ledger stays the timeline source |
| TODO-C09-6 | C09 | §15 Distribution lacks `kind` | Added; no kind → cash |
| TODO-C09-7 | C09 | F#7 Dated records versus K-1 totals precedence | Dated records win; never report one event twice |
| TODO-C10-1 | C10 | What is an "ineligible creditor"? | Shareholder creditors use C04 rules; others → NC |
| TODO-C10-2 | C10 | Company-to-shareholder loans | Info note only |
| TODO-C10-3 | C10 | No promissory-note schema | Schema added; unextracted attributes → NC |
| TODO-C10-4 | C10 | Oral loans only in the GL | NC until the note is marked missing, then Medium |
| TODO-C11-1 | C11 | Does a plan with no awards fire? | Info variant |
| TODO-C11-2 | C11 | Severity of "informal promises" | Medium as written |
| TODO-C11-3 | C11/C03/C07 | Are award holders shareholders? | Not unless the ledger shows shares |
| TODO-C11-4 | C11 | Grants ended before the S effective date | Ignored by the window |
| TODO-C12-1 | C12 | Intake H lacks entity type and dates | NC until confirmed |
| TODO-C12-2 | C12 | Does any below-100% corporate subsidiary fire? | Fires at any percentage |
| TODO-C12-3 | C12 | QSub timing | Existence test only |
| TODO-C12-4 | C12 | Do subsidiaries later sold or diluted matter? | The holding period `[acquired, disposed]` is evaluated like any other; disposal itself creates no finding; Info variant notes the disposal date |
| TODO-C13-1 | C13 | F#8 Where do E&P, gross receipts and passive income come from? (Q21) | Manual entry plus a placeholder 1120-S schema; missing year → NC |
| TODO-C13-2 | C13 | Affected period after year three | The three years; note only |
| TODO-C13-3 | C13 | Definitions of passive investment income and gross receipts | Code consumes confirmed numbers; classification is a professional confirmation |
| TODO-C13-4 | C13 | Fewer than three S years or partial data | Info variant "fewer than three S years; test not yet applicable"; NC when available years lack data |
| TODO-C13-5 | C13 | E&P from acquired C corporations | NC when intake H reports an acquired corporation; otherwise Info note stating the limitation |
| TODO-C13-6 | C13 | F#8 E&P at close of each year or at some point? | Strictest reading: each year; fixture 8 satisfies it |
| TODO-C13-7 | C13 | F#8 Which real 1120-S lines carry the three inputs is unverified (Q21) | Fixture 8's synthetic layout is a placeholder; until confirmed these facts are professional manual entry only |
| TODO-C14-1 | C14 | Is the "deemed election with the 2553" unconditional? | Confirmed 2553 → pass with Info note; no 2553 → NC referencing C01 |
| TODO-C14-2 | C14 | 8832 effective later or other classification | NC |
| TODO-C14-3 | C14 | F#6 Does fixture 6 rely on an 8832 or the deemed election? | Fixture ships a Form 8832 |
| TODO-C15-1 | C15 | F#1 Which states require a separate election; which states first? (Q24) | Every state `unknown` in `/content` → NC, never pass; fixture home state set only in the fixture override |
| TODO-C15-2 | C15 | Do withholding-only filings count as "files in a state"? | Intake A list only |
| TODO-C15-3 | C15 | Late or defective state elections | Existence test only |
| TODO-C15-4 | C15 | State rules changing over time | Single value per state |
| TODO-C15-5 | C15 | Draft `states.yaml` on every report | Draft banner whenever consulted |
| TODO-C16-1 | C16 | What is a gap per dimension; does a single K-1 establish a year? | Ownership and distribution/K-1 coverage only; a K-1 for year Y establishes ownership for year Y; election absence left to C01/C06/C12/C14/C15 |
| TODO-C16-2 | C16 | Window start | S effective date |
| TODO-C16-3 | C16 | Granularity | One finding per gap interval per dimension |
| TODO-C16-4 | C16 | Are absent Recommended distribution records a gap? | Not by themselves |
| TODO-C16-5 | C16 | F#10 Do dependent NC results appear separately? (Q23) | Dependents report `not_evaluated` for gap periods, attached to the C16 finding |
| TODO-C16-6 | C16 | Closure when records never arrive | Open until records arrive or dismissed with reason |
| TODO-C17-1 | C17 | F#8 What is the §1374 recognition period, its start, and does it restart? (Q18) | NC until `recognition_period_years` is set; fixture 8 needs it above 3 |
| TODO-C17-2 | C17 | As of today or the sale date? | Today; sale date in the note |
| TODO-C17-3 | C17 | Never-C-corps holding C-corp-acquired assets | NC when intake H reports an acquired corporation; otherwise `not_applicable` with the limitation in the note |
| TODO-C18-1 | C18 | What tolerances for percentages, amounts, dates, names? (Q20) | Exact equality (draft); normalized-exact names plus `tin_last4`; ambiguous identity → NC |
| TODO-C18-2 | C18 | F#11 Period-weighted K-1 versus single-date ledger | Compare against time-weighted ledger; unconfirmed weighting → NC |
| TODO-C18-3 | C18 | MVP pair list | The six pairs in Phase 2 |
| TODO-C18-4 | C18 | F#11 Uniform Medium; one finding or several? | Uniform Medium; one finding per pair kind with multiple periods |
| TODO-C18-5 | C18 | Conflicted facts blocking dependents | Conflicted = unconfirmed elsewhere |
| TODO-C18-6 | C18/C16 | K-1 missing for some holders | Gap (C16) |
| TODO-EVID-1 | All | F#4 F#5 F#10 May a finding cite an intake answer or checklist status as evidence? (Q22) | Emitted at NC with reason `evidence_kind_pending_ruling`; document-cited findings unaffected |
| TODO-CONTENT-1 | Content | `severity_rules` shape | `{default, variants}`; unknown variant → default with a warning |
| TODO-INTAKE-2 | C14, C15, C08 | §4.1 and §5A capture the same fields | Both stored; conflict queued; dependents NC |
| TODO-EXTRACT-1 | All | Facts from scanned pages | Always queued; dependents NC |
| TODO-DRAFT-1 | Intake copy | Owners seeing draft copy | Shown with a professional-only marker |
| TODO-SEC-1 | Masking | Regex breadth | Loose separated pattern; unseparated 9 digits only with TIN context |
| TODO-SEC-2 | 2553/K-1 identity | 9 digits could be SSN or EIN | `tin_last4` + `tin_kind: unknown`; identity fact queued |
| TODO-SEC-3 | Owner report | Snippets and dismissed findings for owners | Owner DTOs expose explanation, severity, document name + page, next steps only |

Cross-cutting TODOs that are numbered questions rather than table rows: TODO-INTAKE-1 = Q5, TODO-EXTRACT-2 and TODO-CONF-1 = Q12, TODO-QUEUE-1 = Q9, TODO-REMED-1 = Q25, TODO-SIGNOFF-1 = Q26, TODO-REPORT-1 = Q28, TODO-AUTH-1 = Q35. Every other row is answered by editing its last column or `/content/parameters.yaml`.

## 7. Data model additions to §15

Cross-cutting: `firmId NOT NULL` on every tenant table with composite FK `(engagementId, firmId) → Engagement(id, firmId)`; `EvidenceRef` union `document {documentVersionId, pageRangeId, page, snippet} | intake {intakeResponseId, questionId} | checklist {checklistItemId, status} | reconciliation {reconciliationResultId}`, where `intake` and `checklist` are a §2 deviation pending Q22 and are never counted as a document citation; fact-bearing rows carry `sourceFactIds` and `confirmedStatus`.

- Identity and access: FirmMembership (userId, firmId, role `professional|owner`, isFirmAdmin), ProfessionalAttestation (immutable), Invitation (tokenHash, engagementId, role, expiry, revocation), MagicLinkToken, EngagementParticipant, Session, BreakGlassGrant, PlatformAdmin (no firm). AuditLog extended: firmId, engagementId, actorRole, action enum, targetType/Id, schema-checked metadata with no free-text keys, ip, userAgent, requestId, grantId.
- Engagement: createdBy, lead professional, status enum including `pending_deletion`, intakeSubmittedAt, signedOffAt, releasedAt, closedAt, typed expectedSaleTiming, pinned contentVersionId, encryptedDek + dekKeyVersion.
- Intake and checklist: IntakeSession, IntakeResponse (raw answer, answerKind `value|unknown|not_applicable`, answeredByRole, factId), ChecklistItem (requirement, status including `not_available`, yearsExpected/Covered).
- Documents: Document + DocumentVersion (sha256, pageCount, uploadSource, encryptionKeyRef, scan status), DocumentPageRange (docType, classification confidence and source, previousDocType, taxYear), GoverningDocument (kind, effective/superseded dates), GoverningProvision with structured `attributes`, encrypted verbatim snippet, analysis run and confirmation status.
- Extraction: ExtractionRun (kind, pagesSent, model as echoed, promptVersion, schemaVersion, request id, stopReason, stopDetails category, token counts, raw output key), PromptVersion, Fact (renamed ExtractedFact) with `source`, status including `asserted` and `conflicted`, subjectRefs, model/heuristic/combined confidence, thresholdAtTime, confirmedValue, supersededByFactId, feedsChecks; citations carry `verification`.
- Shareholders: Shareholder (kind picklist, linkedShareholderId), ShareholderAttributePeriod (citizenship/residency, marital status, state of residence, living status, spouse residency), SpouseRecord, OwnershipEvent with OwnershipPeriod derived, FamilyGroup + FamilyGroupMember (proposed/confirmed), TrustDetail, EstateDetail.
- Elections and history: Election extended (subjectKind, shareholderId, subsidiaryId, state, signedDate, acceptanceKind, evidenceStatus), StateFiling, CCorpHistoryPeriod, ReliefRecord (kind = content relief id, outcome, relatesTo), Subsidiary (with disposedDate), IrsCorrespondence.
- Money: DistributionEvent (kind `cash|property|state_withholding|composite_tax|other`) + DistributionAllocation, DebtInstrument (direction and the four C10 attributes as bool|unknown), EquityGrant (instrument kind, 83(b) status), TaxYearFinancials (entry source `manual|extracted`), ReconciliationResult.
- Review and output: CheckRun, Finding extended (fingerprint, variant, originalSeverity, severityOverride + reason, reviewDecision, resolution fields, clearedByCheckRunId, contentStatus, evidenceKinds), FindingNote, Task (`follow_up|remediation`), SignOff, Report extended (kind, versionNo, signOffId, sha256, includesDraftContent, autoAcceptedFactCount, status, htmlStorageKey), ReportFinding snapshot, ExportPackage, ContentVersion (hash, gitSha, item-status manifest, json), Notification, Firm settings (retentionDays, retentionAnchor, deletionGraceDays, threshold override), DeletionRun.

## 8. Security and tenancy commitments

- Three isolation layers: `firmId` on every tenant table; a DAL that is the only Prisma importer and sets `app.firm_id`, `app.user_id`, `app.role` transaction-locally; forced RLS under a non-owner runtime role with policy `firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid`, which fails closed with zero rows whether the GUC was never set or was cleared at the end of an earlier transaction on a pooled session. Owner rows are further scoped by EngagementParticipant and by `signedOffAt` for findings and reports. Workers build a tenant context from the job's firmId and never run cross-firm.
- Platform admin reads tenant data only through a time-boxed, reasoned, MFA-stepped-up BreakGlassGrant enforced in RLS; every read is audited and firm admins are notified. Usage views read system-computed aggregates.
- Encryption: TLS with `sslmode=verify-full`, HSTS, CSP with `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`; S3 SSE-KMS per environment with a bucket policy denying unencrypted or non-TLS puts and presigned POST policies carrying the SSE conditions; application-level AES-256-GCM under a per-engagement DEK for raw model outputs, prompt snapshots, all snippets, cached page text and intake free text; hard delete crypto-shreds the DEK.
- SSNs: no schema field holds a full SSN (`tin_last4` + `tin_kind`; EIN kept for reconciliation); model instruction; `maskTins()` on every stored string; storage-wide scan test in Phase 2; rules never depend on a full TIN.
- Logging: typed allowlist logger, pino redaction, `no-console`, SDK error messages never logged, job payloads carry ids only, no analytics, no tracker without approval and never with request bodies.
- Audit: append-only AuditLog written in the mutation's transaction, covering every §16 event plus auth, extraction, review, report, content, break-glass and retention; rows survive hard delete with reason fields nulled (Q32).
- Auth: mandatory TOTP before any engagement page, hashed recovery codes, step-up for irreversible actions, server-side sessions with rotation, rate limits on login and TOTP, versioned attestation text; owner magic links hashed, single-use, POST-consumed, bound to invite + email + engagement, 15-minute expiry, non-enumerating re-issue.
- Untrusted documents: uploads and model outputs are data; strict schemas; citation verification against the text layer; heuristics only lower confidence; rules never read prose; snippets rendered as text; Playwright renders with network aborted and a fresh context; pure-JS PDF libraries, size and page ceilings, no shell-outs; fixture 13 red-team test.
- Data minimisation toward Anthropic: only the classified page range is sent; no Files API; Batches only for synthetic fixtures (production re-extraction through Batches only if Q40 accepts 29-day retention); separate workspaces and keys per environment; production refuses a Covered Model without an explicit flag; subprocessor notice in the owner intake.
- Retention: per-firm `retentionDays` from `closedAt`, 14-day pending state with notice, idempotent deletion across S3, DB rows, DEK and queue archives, tested for zero residual rows and objects; PITR window documented as the residual.
- SOC 2 groundwork from Phase 0: security runbook kept private (Q1), branch protection where the plan enforces it, secret and dependency scanning, per-environment IAM, staging unable to reach production storage, `ALLOW_REAL_UPLOADS=false` outside production, monthly access-review script, incident one-pager, subprocessor list.

## 9. Questions for the founder

Grouped by the phase whose "done when" needs the answer; each carries the default applied if unanswered. Phase 0 blockers first.

Blocking Phase 0:
1. Repository home and visibility: build here as a pnpm monorepo, or in a new repository? GitHub Pages is enabled here and the repository is public (both verified); will it stay public? Building here touches nothing existing (`apps/` and `packages/` cannot collide with `index.html`, `privacy.html`); a later move is one refactor. A private repository on a personal Free plan loses enforced branch protection unless GitHub Pro is approved. Default: monorepo here, the two pages untouched, repository assumed public, so `docs/security.md` and infra notes stay out of it until it is private.
2. Auth library: Better Auth, Auth.js with hand-rolled TOTP, or Clerk (paid)? MFA is the sign-off control point. Default: Better Auth, plugins verified on day one.
3. Working code name (package scope, DB, env prefix) and domain (§20)? Hard to rename later. Default: `scr`/`@scr/*`; display "S-Corp Readiness (working name)".

Phase 1:
4. Email provider for magic links (SES, Postmark, Resend; all paid beyond free tiers)? Needed only for a hosted staging; local and CI use file transport and Mailpit. Default: Nodemailer against `SMTP_URL`; no provider chosen.
5. Do owner intake answers count as confirmed facts, or must a professional accept them? Decides whether any check can pass on owner assertion. Default: `asserted` until accepted per section.
6. Upload formats beyond PDF? §6 lists GL and bank exports. Default: PDF, JPEG, PNG, HEIC converted to PDF; CSV/XLSX parsed without a model in Phase 2; no DOCX.
7. Expected document volume per engagement? Sets limits and cost budgets. Default: 100 files, 3,000 pages, 50 MB and 500 pages per file, configurable per firm.
8. Can a user belong to more than one firm, and does an owner invited by two firms share an identity? Default: one membership in the UI, FirmMembership table from day one, one owner identity with per-firm access rows.
9. Who resolves queued facts by default, and may a professional fill intake on the owner's behalf? Default: professional; yes, audited.

Phase 2:
10. Hosting, as a yes or no: I recommend Option B, one Docker host (Railway) running web and worker, Neon free tier for Postgres, AWS S3 with a KMS key, at roughly $15–40 per month before Anthropic usage (estimate; current prices to be verified before provisioning). Approve? If no, name the vendor you prefer or say stay local-only. Nothing is provisioned until you say yes. Default: build for both options, run locally only.
11. Anthropic account: confirm a Commercial Console organisation with per-environment workspaces and spend limits, and whether to request zero-data-retention (§16). Default: fixtures only until confirmed; no ZDR request; the two spec models only.
12. Should any fact extracted by the model ever be used by a check without a person confirming it? Default: yes, when its citation is verified on the page and its confidence is above a threshold I will calibrate on the fixtures (placeholder 0.85, firm override allowed); no fact is used without a verified citation; every report states how many facts were auto-accepted.
13. Add local OCR for scanned uploads, or always queue those facts? Default: no OCR; always queued.
14. May a refused request be retried once on a fallback model with the serving model recorded? Default: yes, `claude-opus-5` for both routes, confidence capped at 0.7.
15. Read "no unmasked SSNs are stored" as derived stores only, since original PDFs contain SSNs? Default: yes; originals excluded from the scan.
16. Mask bank account numbers in GL/bank exports? §2 masks SSNs only. Default: not masked; no schema field stores them.

Values that gate Phase 3 (no defaults exist; fixtures named stay pending):
17. The §1362(b) election deadline, as N months and D days after the start of the tax year of the intended effective date, entered as a draft `parameters.yaml` value. Interim behaviour: C02 is NC everywhere and fixture 2 is pending.
18. The §1374 recognition period in years, its start date, and whether a later acquisition restarts it. Interim behaviour: C17 is NC everywhere and fixture 8 is pending.
19. Counting conventions: for "2 months and 16 days", calendar months then days, with the day shares are received excluded? For the 2-year window, the start date for testamentary trusts (post-death grantor trusts run from the date of death)? And is a grantor trust with a living grantor treated as qualifying without an election, as C06's post-death window implies (TODO-C06-4; fixture 9 depends on it)? Default: as TODO-C06-1/2/4, with a ±7-day NC band and fixture 9's period start unasserted.
20. Tolerances for C09 amounts and timing and for C18 percentages, amounts, dates and names. Default: exact equality, the spec's literal text, so any difference is reported; this errs toward reporting and does not gate Phase 3.
21. Which Form 1120-S lines (and Schedule B or M-2 items) carry gross receipts, passive investment income and accumulated E&P? Interim behaviour: these are professional manual entry and fixture 8's end-to-end path uses manual entry.
22. §2 requires every finding to cite documents and pages, but fixtures 4, 5 and 10 and every absence finding (C01, C16) rest on intake answers or checklist status. Proposal: allow intake-answer and checklist-status evidence, shown as "Evidence: owner statement, intake section C" and never counted as a document citation. Interim behaviour: such findings are emitted at Needs confirmation, so fixtures 4 and 5 are pending. If you say no, fixtures 4 and 5 can never produce their §11 severities and their expected sets become C04 NC and C05 NC.
23. Confirm that §11 rows 1 and 12 are read as an empty expected set with C06, C10–C14 and C17 reported as `not_applicable`, and row 10 as C16 only with dependent checks folded into the C16 finding. Default: yes.
24. Which states get `states.yaml` entries first (§20)? Every unlisted filing state yields C15 NC and every married holder outside the nine §7 states yields C03/C05 NC. Default: `/content` holds the nine community-property states as draft and every other value `unknown`; the fixtures' Colorado values live only in the fixture override.

Phase 4:
25. Should relief YAMLs declare `resolves_checks` so re-runs clear findings at check level, or is resolution an overlay? Default: overlay.
26. Must every finding, including Info and NC, receive a decision before sign-off, and who may sign off? Also confirm "Sign off" and "Release to owner" as two actions. Default: yes; any attested professional participant; two actions.
27. Can a sign-off be reverted, and does that withdraw a released owner report? Default: no; new evidence yields a new version after a new sign-off, prior versions marked superseded.

Phase 5:
28. Exact condition for "No issues identified in the documents reviewed", given fixture 1 permits Medium/Info? Default: only when the reviewed finding set is empty.
29. Export: include report PDFs under `00 Report`, does the owner receive the zip, and do unclassified documents go to `99 Unclassified`? Default: include; owner does not; yes, listed in the index.
30. Confirm forbidden-word inflections (certification, guaranteed, approval, validated, validity) and the allowlist: "certificate of incorporation/formation", "stock certificate", "certificate number", "not a legal opinion", plus technical inflections the UI needs ("validation", "invalidated sign-off"). The lint blocks release and covers UI copy. Default: as listed.
31. Final disclaimer and scope wording (§20, counsel), and may the owner version be released while draft content is used? Default: draft wording in `/content/report`; release allowed with the banner.

Policy and later:
32. Retention: default period (proposed 7 years from `closedAt`), early delete with a 7-day grace, and do audit rows survive hard delete? Default: 7 years; yes; yes with reasons nulled.
33. Owner staff: own invites or a shared link? Default: own invites.
34. Break-glass: self-issued with notification, or firm-admin approval? Default: self-issued, ≤ 60 minutes, notified.
35. License attestation: self-attestation or a manual review step? UI wording must not imply verification. Default: self-attestation, "attested".
36. Pricing model (§20): per engagement or firm subscription? Default: no billing until Phase 6.
37. Error tracking: none, self-hosted GlitchTip, or Sentry (paid beyond free tier)? Default: none.
38. Ask counsel whether CPA-firm use of an AI subprocessor for client tax documents needs specific client consent, and which state privacy laws apply to shareholder data in intake. Default: subprocessor notice and acknowledgment in the owner intake; professionals attest at signup that their engagement permits use.
39. Verification of every `/content` file before the first pilot (§20): who and when? Default: all content stays draft; every report shows the banner.
40. May production re-extraction after a prompt or schema change use the Batch API, given results are retained by Anthropic for 29 days and are not ZDR-eligible? Default: no; Batches only for synthetic fixtures.

## 10. What I will build first

Phase 0 tasks in order:
1. Start on the Q1–Q3 defaults (monorepo here, Better Auth, `scr`); initialise the pnpm/Turborepo workspace, `tsconfig`, ESLint flat config with the rules-purity and DAL-boundary restrictions, Prettier, `.env.example`, `docker-compose.yml`, `pnpm db:local`; verify the Better Auth plugins and record the verified Vercel limits.
2. `packages/config` (Zod env, `server-only`) and `packages/logger` (typed allowlist, redaction).
3. `packages/db`: Phase 0 Prisma schema with `firmId` everywhere, migrations with RLS SQL and the two roles, `withTenant`, query extension, `audit()`, pg-boss schema under the migrator role, and the isolation suite on the local cluster.
4. `packages/rules/src/types` (fact union, content schemas) and `packages/content`: skeleton `C01`–`C18`, `states.yaml` all `unknown` except the nine draft community-property states, `parameters.yaml` with unset tax values, `legal/attestation.md`, content hash, forbidden-words lint.
5. `apps/web`: auth wiring, sign-up with attestation, MFA gate, firm setup, users, engagement list and creation, owner invite with file-transport email, magic-link landing; route-group layouts in the file-room tone with axe checks.
6. `apps/worker`: pg-boss bootstrap, `/health`, Dockerfile on the Playwright 1.56.1 image, retention scheduler stub (added).
7. `packages/storage` (S3 and filesystem adapters), `packages/reports` (`htmlToPdf` only), `packages/fixtures`: DSL, `corpBase()`, registry, `s01-clean` with the CO override, the `form-2553` template with grounding test, comparator, `fixtures:seed` stub.
8. CI workflow, Dependabot, branch protection if the repository allows it; Phase 0 Playwright flows; the §0.3 phase summary with open TODOs.

The first commit contains workspace manifests (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, lockfile), root tooling configs, `docker-compose.yml`, `.env.example`, `.gitignore`, `docs/SPEC.md` unchanged, a `README.md` with local run steps (including `pnpm db:local`), and a CI workflow running lint and typecheck against an otherwise empty `apps/web` and `packages/config`. No application code, no security runbook. Each later step is its own PR with tests.

Needed to start: nothing blocks the first two weeks. Q1–Q3 have defaults I can start on; a rename later costs one refactor. A yes or no on Q10 is needed before anything is provisioned, and Q17–Q22 before Phase 3 can close.

## 11. Risks and mitigations

- Phase 3 cannot close on engineer effort alone: fixtures 2, 4, 5 and 8 wait on Q17, Q18, Q21 and Q22. Mitigation: the gate is stated as conditional up front; 8 of 12 fixtures go green independently; preconditions fail loudly with the question number.
- Under-specified rules decide other fixture outcomes (C06 counting, C09 timing, C13 data path). Mitigation: `parameters.yaml` with unset tax values, NC-by-default coding, exact-equality tolerances that err toward reporting, the §6 table as the review artefact.
- The spec's own guardrail (§2 evidence) contradicts its fixtures. Mitigation: interim NC so nothing Critical rests on an owner statement without a ruling; labelled evidence once Q22 is answered.
- Model drift or refusals break extraction silently. Mitigation: record-and-replay keyed by prompt version, nightly live job, boot capability checks on every configured ID including fallbacks, verified fallback default, local citation verification so wrong extractions land in the queue, not in a check.
- `claude-opus-5-5` is "launching"; pricing, rate-limit pool and retention are "confirm at launch"; `messages.parse` streaming is unverified. Mitigation: `claude-opus-5` as the documented fallback, `response.model` recorded per run, the stream-then-parse path specified in §5.
- This container has no Docker daemon. Mitigation: local Postgres cluster script, filesystem storage adapter, file mail transport; compose reserved for CI and the founder's machine, so every Phase 0 test runs here.
- Cross-tenant leak through a raw query, nested write or new table. Mitigation: forced fail-closed RLS with `NULLIF`, schema-contract test failing CI on any new tenant table without a policy, reflection-driven DAL tests.
- Owner-uploaded documents are attacker-controlled. Mitigation: §8 controls and fixture 13.
- Hard delete is not literal inside backup windows. Mitigation: DEK crypto-shredding, documented PITR residual, no S3 versioning or replication in production.
- Public repository and personal GitHub plan. Mitigation: security runbook outside the repository; branch protection listed as a paid item if the repository goes private.
- Cost per engagement (~$8–9) and hosting (~$15–40/month) are estimates. Mitigation: `count_tokens` gate per slice, measurement on the first recorded run, effort sweep, nothing provisioned before Q10.
- Fixture 12 (≈400 K-1 pages) makes live tests expensive. Mitigation: replay in CI, excluded from the nightly live job by default, timing budget on the rules run.
- Founder review load: 40 questions and 102 TODO rows. Mitigation: questions grouped by the phase they gate with defaults everywhere one exists; fixture-affecting rows marked; answers arrive as `/content` edits, not code changes.
- §17 accessibility and mobile scope is easy to defer. Mitigation: axe and 375 px checks are acceptance tests from Phase 1.
