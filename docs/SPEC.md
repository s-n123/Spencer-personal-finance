# S-Corp Readiness — Build Spec v0.1

Working name: **S-Corp Readiness** (placeholder; rename before launch).

## 0. Instructions for Claude Code

1. Read this entire file before writing any code.
2. Reply first with: (a) a phase-by-phase build plan, (b) any questions or disagreements with the proposed stack, and (c) what you will build first. Wait for approval before starting Phase 1.
3. Build one phase at a time (§18). At the end of each phase, run all tests, summarize what was built, and list open TODOs.
4. The tax logic lives in the rules engine (§10) and in editable content files (§7). Do not invent tax rules that are not in this spec. If a rule is ambiguous, implement it as a clearly flagged TODO for founder review instead of guessing.
5. Never use real client documents. All development, demos, and tests run on the synthetic fixtures in §11.
6. Ask before adding any paid third-party service.

## 1. Product in one paragraph

Software that helps CPAs, sell-side M&A advisors, and exit planners check whether a client's S corporation election has held up since it was made, before the client goes to market. The business owner completes a guided intake and uploads records. The system extracts facts from the documents, rebuilds the company's ownership and election history, runs a set of qualification checks, and produces a findings report with evidence and suggested fix paths. A licensed professional reviews and signs off on every finding before any report is released. The goal for sellers: find and fix S-corp problems before a buyer's diligence team does.

## 2. Non-negotiable guardrails

- **Not a legal opinion or certification.** The product never uses "certificate," "certified," "opinion," "guarantee," "approved," or "valid" as a conclusion. When no problems are found, say "No issues identified in the documents reviewed." Report title: "S-Corp Readiness Review: Findings for Professional Review."
- **Professional in the loop.** Owners never see a final report until a professional user has reviewed each finding and signed off. At signup, professionals attest to being a CPA, attorney, or enrolled agent and provide license type, number, and state.
- **Rules decide; the model extracts.** Model calls extract facts from documents and draft plain-English text. Every pass/fail determination is deterministic code running over confirmed facts. Every finding cites the documents and pages it relies on.
- **Low-confidence facts go to a human.** Extracted facts below a confidence threshold enter a confirmation queue. A check that depends on an unconfirmed or missing fact returns "Needs confirmation," never a pass.
- **Sensitive data.** Mask Social Security numbers at extraction (store last four digits at most). Encrypt documents at rest. Never write document text to logs or error trackers. Enforce per-firm tenant isolation everywhere.
- **Legal content is draft until verified.** All check descriptions, explanations, and relief paths live in `/content` with `status: draft` until the founder verifies them. If a generated report uses any draft content, show a visible "Draft content" banner on the report.

## 3. Users and roles

| Role | Who | Can do |
| --- | --- | --- |
| Firm admin | Owner of a CPA, advisory, or exit-planning firm | Manage firm settings and users |
| Professional | CPA, attorney, or enrolled agent at a firm | Create engagements, invite owners, confirm facts, review findings, sign off, generate reports, manage remediation |
| Owner | Business owner or their staff | Complete intake, upload documents, answer follow-ups, confirm facts when asked, view released reports |
| Platform admin | Founder | Manage content files and view usage. No default access to client documents; break-glass access is logged |

## 4. Core workflow

1. Professional creates an engagement: company name, state of formation, entity type (corporation or LLC), expected sale timing.
2. Professional invites the owner by email (magic link).
3. Owner completes the guided intake (§5) and uploads documents against a checklist (§6). Owner can mark any item "I don't have this."
4. System classifies each document and extracts facts (§8). Low-confidence facts go to the confirmation queue for the owner or professional.
5. System builds the company timeline (§9) and runs the checks (§10), producing findings.
6. Professional reviews each finding: confirm, change severity, dismiss with a required reason, or add a note. Professional can send the owner a follow-up request, which creates a task in the owner portal.
7. Professional signs off. The system generates the report and an organized document export (§12).
8. Remediation tracker (§13): each confirmed finding gets fix-path tasks. When new evidence is uploaded (for example, an IRS relief letter), checks re-run.

## 5. Intake questionnaire

Branching, plain English, save-and-resume. Every answer is stored as a typed fact linked to the checks it feeds. Include a short "Why we ask" note on each section.

**A. Company basics.** Legal name; state of formation; entity type (corporation or LLC); formation date; whether it ever operated as a C corporation (and which years); states where it files returns.

**B. S election.** Date S status began; who prepared the election; whether the company has the IRS acceptance letter (notice CP261); any IRS letters about S status; any prior requests for IRS relief.

**C. Shareholder roster (past and present).** A wizard to list every person or entity that has ever held shares: name; shareholder type (picklist below); dates held; shares or percentage; citizenship or residency status (US citizen, US resident, nonresident alien, unknown); marital status and state of residence during the holding period.

Shareholder type picklist: individual; estate; trust (grantor, QSST, ESBT, testamentary, voting, other or unknown); tax-exempt organization; qualified retirement plan trust; IRA or Roth IRA; corporation; partnership; LLC (single-member or multi-member); other.

**D. Ownership events.** Has any shareholder died, divorced, gifted shares, moved shares into a trust, sold shares, had shares redeemed, moved abroad, or married someone who is not a US citizen or resident? Were new shares ever issued? Has any company, fund, partnership, or LLC ever held shares?

**E. Trusts.** For each trust that ever held shares: trust type if known; date it received shares; whether a QSST or ESBT election was filed and when; whether the grantor is living (and date of death if not).

**F. Distributions and money.** Were distributions always paid in proportion to ownership, in both amount and timing? Did the company ever pay state taxes on behalf of some shareholders but not others? Any loans between shareholders and the company? Any agreement giving someone a preferred return or a different payout?

**G. Equity and compensation.** Stock options, restricted stock (and any 83(b) elections), phantom equity, stock appreciation rights, profits-interest-style grants, or informal promises of equity to employees.

**H. Subsidiaries.** Does the company own other companies? What percentage? Were any elections filed for them (Form 8869)?

**I. Sale plans.** Expected timing; likely buyer type; known deal structure if any (asset sale, stock sale, §338(h)(10), §336(e), F reorganization, unknown).

## 6. Document checklist and classification

| Document | Why it matters | When required |
| --- | --- | --- |
| Form 2553, including shareholder consents | The election itself | Always |
| IRS acceptance letter (CP261) or other IRS confirmation | Shows the election was accepted | Always |
| Form 8832 | LLC classification as a corporation | LLCs, if filed |
| Articles or certificate of incorporation, with amendments | Classes of stock and rights | Corporations |
| Bylaws | Distribution and liquidation rights | Corporations |
| LLC operating agreement, with amendments | Distribution and liquidation rights | LLCs |
| Shareholder, buy-sell, and redemption agreements | Possible second class of stock | If any exist |
| Stock ledger or cap table; stock certificates | Ownership history | Always |
| Forms 1120-S and Schedules K-1, all available years (minimum: last three filed) | Ownership percentages and distributions | Always |
| Trust agreements; QSST or ESBT election statements | Trust eligibility | If trusts held shares |
| Estate documents for deceased shareholders | Estate and trust holding periods | If applicable |
| Promissory notes and loan agreements with shareholders | Straight-debt safe harbor | If applicable |
| Equity plan documents, award agreements, 83(b) elections | Equity compensation | If applicable |
| Form 8869 | Subsidiary elections | If subsidiaries exist |
| State S election filings | State-level status | If the state requires one |
| Distribution records (general ledger export or bank records) | Proportional distributions | Recommended |
| IRS correspondence, prior relief letters or rulings | Prior issues and fixes | If any exist |

Classification: the model assigns each upload a document type with a confidence score; the user can correct it. Multi-document PDFs are split into page ranges, each classified separately.

## 7. Content system (legal logic as editable content)

Keep all legal text out of code so the founder can edit it without a deploy.

- `/content/checks/<check-id>.yaml`: `id`, `title`, `what_it_tests` (plain English), `severity_rules`, `inputs` (fact types used), `owner_explanation`, `professional_note`, `relief_paths` (ids), `authorities` (citations), `status` (`draft` or `verified`), `verified_by`, `verified_on`.
- `/content/relief/<relief-id>.yaml`: `id`, `name`, `when_it_applies`, `authority`, `typical_steps` (these become remediation task templates), `notes`, `status`.
- `/content/states.yaml`: state-specific data, for example whether a separate state S election is required and whether the state is a community-property state. Starting community-property list (verify): Arizona, California, Idaho, Louisiana, Nevada, New Mexico, Texas, Washington, Wisconsin. All entries start as `draft`.
- Version the content directory. Every generated report records the content version it used.

## 8. Extraction pipeline

1. Upload → store encrypted in object storage → record page count → classify (§6).
2. Each document type has an extraction schema (Zod, exported as JSON Schema). Examples:
   - **Form 2553:** corporation name, EIN, tax year, election effective date, date signed, filing date if shown, each listed shareholder with shares and whether a consent signature is present, spousal consents.
   - **CP261:** notice date, effective date of S status.
   - **Schedule K-1 (1120-S):** tax year, shareholder name, ownership percentage, distributions.
   - **Stock ledger:** entries with date, transferor, transferee, shares, certificate number.
   - **Governing documents:** clauses on classes of stock, voting, distributions, tax distributions, liquidation, capital accounts, preferred returns, redemption and buy-sell pricing. Each clause stored with a verbatim snippet and page number.
   - **Trust agreement:** trust name, trustee, beneficiaries, grantor-trust indicators, income distribution requirements.
3. Send PDFs to the Anthropic API as document inputs and force structured output with tool use. Every extracted field carries a `citations` array (page number plus a short snippet).
4. Confidence per field combines the model's reported confidence with heuristics (for example, a field with no citation is low confidence). Threshold is configurable. Below it, the fact goes to the confirmation queue.
5. Cross-document reconciliation: compare the same fact across sources (ledger percentages vs K-1 percentages; shareholders on Form 2553 vs the ledger on the election date). Discrepancies become check C18 findings.
6. Mask Social Security numbers before storing any extracted text (regex pass plus a model instruction).
7. Model configuration via environment variables: `ANTHROPIC_MODEL_EXTRACTION` (default `claude-sonnet-5`) and `ANTHROPIC_MODEL_ANALYSIS` (default `claude-opus-5-5`, used for governing-document clause analysis). Verify current model names against docs.claude.com before the first run.
8. Store each raw model output (encrypted) linked to the document version and the prompt version, for audit.

## 9. Company timeline

Build a single dated history from confirmed facts:

- Election events: S election, state elections, Form 8832, QSub elections, QSST and ESBT elections.
- Ownership periods per shareholder (shares and percentage), including issuances, transfers, and redemptions.
- Shareholder attribute changes: residency, citizenship, marital status, death.
- Governing document versions with effective dates.
- Distributions per shareholder per date.
- Debt instruments and equity grants.

Derived values:

- Ownership percentage per shareholder on every distribution date.
- Shareholder count on every date, applying family aggregation. Family groups are user-defined sets (a common ancestor plus lineal descendants and spouses) that the professional confirms.

UI: a timeline view in which every event links to its source documents and pages.

## 10. Checks (MVP)

Severity scale:

- **Critical:** the facts indicate S status likely terminated or never took effect.
- **High:** likely defect that needs IRS relief or correction.
- **Medium:** risk that needs professional review or corrective action.
- **Info:** tax exposure or context, not a status problem.
- **Needs confirmation:** depends on missing or unconfirmed facts.

All relief paths below are draft content (§7) for founder verification.

| ID | Check | Flags when | Default severity | Likely relief path (draft) |
| --- | --- | --- | --- | --- |
| C01 | Election on file | No Form 2553, or no IRS acceptance or confirmation | High | Obtain IRS confirmation; if no election is on record, late election relief |
| C02 | Election timing | Filed after the §1362(b) deadline for the intended effective date, with no relief on record | High | Rev. Proc. 2013-30 (time limits apply); otherwise a letter ruling |
| C03 | Shareholder consents | A shareholder on the election date, or a spouse with a community-property interest, did not sign a consent | High | Late consent under Treas. Reg. §1.1362-6(b)(3)(iii); Rev. Proc. 2022-19 |
| C04 | Eligible shareholders | Any period with an ineligible shareholder: nonresident alien, corporation, partnership, multi-member LLC, IRA (generally), or non-qualifying trust | Critical | §1362(f) inadvertent termination relief |
| C05 | Nonresident alien spouse | A shareholder married to a nonresident alien while living in a community-property state | Critical | §1362(f) |
| C06 | Trust shareholders | A trust held shares without qualifying status: missing or late QSST or ESBT election (due within 2 months and 16 days of receiving shares), or the 2-year window for a post-death grantor trust or testamentary trust was exceeded | High | Rev. Proc. 2013-30 (late QSST or ESBT election); §1362(f) |
| C07 | Shareholder count | More than 100 shareholders at any time after family aggregation | Critical | §1362(f) |
| C08 | Governing provisions | Articles, bylaws, operating agreement, or binding agreements give non-identical distribution or liquidation rights (for example, liquidation by capital accounts, preferred returns, non-proportional tax distribution clauses) | High | Amend provisions; Rev. Proc. 2022-19; §1362(f) |
| C09 | Distributions | Distributions not proportional to ownership in amount or timing, including state withholding or composite tax paid for only some shareholders | Medium | Corrective distributions; Rev. Proc. 2022-19 (professional review) |
| C10 | Shareholder debt | Debt that may fall outside the §1361(c)(5) straight-debt safe harbor: convertible, interest contingent on profits, ineligible creditor, or no written unconditional promise to pay | Medium | Professional review; restructure the debt |
| C11 | Equity compensation | Options, restricted stock (note 83(b) elections), phantom equity, SARs, or profits-interest-style grants | Medium | Professional review |
| C12 | Subsidiaries | A 100%-owned corporate subsidiary with no QSub election, or a less-than-100% corporate subsidiary | Medium | Late QSub relief under Rev. Proc. 2013-30 |
| C13 | Passive income (former C corps) | Accumulated earnings and profits plus passive investment income above 25% of gross receipts for 3 consecutive years (§1362(d)(3)) | Critical | §1362(f) |
| C14 | LLC classification | LLC with an S election but no evidence of corporate classification (Form 8832, or a deemed election with the Form 2553) | Medium | Late entity classification relief under Rev. Proc. 2013-30 |
| C15 | State elections | Company files in a state that requires a separate S election, with none on record | Medium | State-specific relief |
| C16 | Record gaps | Any period where ownership, elections, or distributions cannot be established from the records | Needs confirmation | Obtain the missing records |
| C17 | Built-in gains period | Former C corporation still within the §1374 recognition period | Info | Flag for deal-structure discussion |
| C18 | Records conflict | Cross-document discrepancies (for example, ledger percentages vs K-1 percentages) | Medium | Reconcile the records |

Implementation:

- Each check is a pure function over the timeline and confirmed facts, unit-tested against the fixtures in §11.
- Each finding records: check ID, severity, affected period(s), evidence references (document, page, snippet), owner explanation, professional note, relief path IDs, and the content version used.

## 11. Test fixtures (synthetic only)

Build a fixture generator that produces synthetic PDFs for each scenario plus an expected-findings file. Use obviously fake identifiers (for example, SSN 000-00-0000 and EIN 00-0000000) and invented names.

| # | Scenario | Expected findings |
| --- | --- | --- |
| 1 | Clean S corp, three shareholders, complete records | No Critical or High findings |
| 2 | Late election, no relief on record | C02 High |
| 3 | Shares gifted to a trust, no QSST or ESBT election | C06 High |
| 4 | Shareholder moves abroad and becomes a nonresident alien | C04 Critical |
| 5 | Texas shareholder marries a nonresident alien | C05 Critical |
| 6 | LLC electing S, operating agreement liquidates by capital accounts | C08 High |
| 7 | State withholding paid only for out-of-state shareholders | C09 Medium |
| 8 | Former C corp with accumulated E&P and rental income above 25% for three years | C13 Critical; C17 Info |
| 9 | Grantor dies; trust holds shares 30 months with no election | C06 High |
| 10 | K-1s missing for one year | C16 Needs confirmation |
| 11 | Ledger shows 50/50; K-1s show 60/40 | C18 Medium |
| 12 | 120 individual shareholders, under 100 after family aggregation | No C07 finding |

Acceptance: for every scenario, generated findings match the expected set exactly (IDs and severities), and every finding has at least one evidence citation.

## 12. Report and exports

- **Professional PDF report**, in this order: cover (company, engagement, date, reviewing professional, content version); scope and limitations (documents reviewed, what was not reviewed, statement that this is not a legal opinion); summary of findings by severity; each finding (what was found, why it matters, evidence with document and page, suggested next steps, professional notes); timeline summary; document index.
- **Owner version** in plain English, released only after sign-off.
- **Document export:** a zip with a standard folder structure (Election; Governing Documents; Ownership; Trusts; Returns and K-1s; Distributions; Debt and Equity; Subsidiaries; IRS Correspondence; Remediation) plus an index spreadsheet.
- **Versioning:** regenerating after remediation shows each resolved finding with its supporting evidence (for example, the IRS relief letter).
- Report generation is blocked until sign-off.

## 13. Remediation tracker

For each confirmed finding, create tasks from the relief path's `typical_steps` (for example, "Collect late shareholder consents," "Amend operating agreement," "Make corrective distributions," "Prepare late election relief filing"). Each task has an assignee (professional or owner), due date, status, and attached evidence. When the professional marks a finding resolved with evidence attached, checks re-run.

## 14. Tech stack (proposed)

- Next.js (App Router) with TypeScript; Tailwind; shadcn/ui components.
- Postgres (Neon or Supabase) with Prisma. Tenant scoping enforced in a data-access layer where every query requires a firm ID, with tests proving isolation.
- Auth: Auth.js or Clerk. MFA required for professionals; magic links for owners.
- Storage: S3-compatible bucket with server-side encryption and short-lived signed URLs.
- Background jobs for extraction and checks (Inngest or pg-boss).
- Anthropic TypeScript SDK; PDFs sent as document inputs; structured output via tool use; model names from environment variables.
- PDF reports: HTML templates rendered to PDF with Playwright.
- Testing: Vitest for the rules engine and extraction parsers; Playwright for end-to-end flows.
- Deploy: Vercel plus managed Postgres and S3. Separate dev, staging, and production environments; staging uses fixtures only.

## 15. Data model (starting point)

- **Firm:** id, name, settings (retention period, branding).
- **User:** id, firmId, role, name, email, license type/number/state (professionals), MFA status.
- **Engagement:** id, firmId, companyName, stateOfFormation, entityType, expectedSaleTiming, status.
- **Document:** id, engagementId, storageKey, docType, classificationConfidence, pageRanges, uploadedBy, version.
- **ExtractedFact:** id, engagementId, factType, value (JSON), citations, confidence, status (auto, queued, confirmed, rejected), confirmedBy.
- **Shareholder:** id, engagementId, name, type, citizenship/residency history, marital status history, familyGroupId.
- **OwnershipPeriod:** shareholderId, shares, percentage, startDate, endDate, sourceFactIds.
- **Election:** type (S, state S, 8832, QSub, QSST, ESBT), filedDate, effectiveDate, acceptedDate, sourceFactIds.
- **GoverningProvision:** documentId, category, snippet, page, effectiveDate.
- **Distribution:** date, shareholderId, amount, sourceFactIds.
- **Finding:** id, engagementId, checkId, severity, periods, evidenceRefs, status (open, confirmed, dismissed, resolved), dismissReason, notes, contentVersion.
- **RemediationTask:** findingId, title, assignee, dueDate, status, evidenceDocumentIds.
- **Report:** engagementId, version, generatedAt, signedOffBy, contentVersion, storageKey.
- **AuditLog:** actor, action, target, timestamp.

## 16. Security and privacy

- Encryption in transit and at rest; role-based access; tenant isolation tests in CI.
- Audit log for every document view, download, edit, sign-off, and report generation.
- MFA for professionals; session timeouts.
- SSN masking at extraction; no document contents in logs, analytics, or error trackers.
- Per-firm data retention setting, with hard delete of engagement data and documents.
- Secrets in environment variables; dependency scanning in CI.
- Send the model only the pages it needs. Confirm the Anthropic API commercial data terms before any real client data is used.
- Design with SOC 2 in mind for later.

## 17. UI direction

- **Two audiences.** Professionals need a dense, precise review workspace. Owners need a calm, guided, plain-English portal that works on mobile.
- **Professional workspace:** engagement list; engagement page with findings (severity and status), timeline, documents, and confirmation queue; finding detail with a side-by-side document viewer that highlights the cited page and snippet.
- **Owner portal:** step-by-step intake with progress; document checklist with "Why we ask" notes; follow-up requests.
- **Visual tone:** sober and document-centric, like a well-kept file room. Reserve color for severity. Avoid generic grids of identical cards. Sentence case throughout; buttons say exactly what they do ("Upload documents," "Sign off and release report").
- **Accessibility:** full keyboard support, WCAG AA contrast, responsive layouts.

## 18. Build phases and acceptance criteria

| Phase | Scope | Done when |
| --- | --- | --- |
| 0. Foundation | Repo, stack, auth, roles, firms, CI, fixture generator skeleton | A professional can sign up, create a firm, and invite an owner; tenant isolation tests pass |
| 1. Intake and documents | Engagements, owner invite, questionnaire, uploads, checklist, classification | An owner completes intake for fixture 1 and every document is classified correctly |
| 2. Extraction | Schemas, extraction with citations, confidence, confirmation queue, SSN masking, reconciliation | Every required field in fixtures 1–12 is either confirmed or queued; no unmasked SSNs are stored |
| 3. Timeline and checks | Timeline builder, content system, checks C01–C18 | All 12 fixtures produce exactly their expected findings |
| 4. Review and remediation | Review UI, sign-off, follow-ups, remediation tracker, re-runs | A professional resolves a finding by uploading a relief letter, and the re-run clears it |
| 5. Reports and export | Professional and owner reports, zip export, versioning | Reports cannot generate without sign-off; each report lists its content version; export structure is correct |
| 6. Post-pilot | Billing (Stripe), firm branding, QuickBooks/Xero import for distributions, export package for tax insurance submissions | Scoped after pilot feedback |

## 19. Out of scope for the MVP

Filing anything with the IRS or states; e-signatures; selling directly to owners without a professional; legal opinions or certifications; insurance quoting; tax return preparation.

## 20. Open questions for the founder

- Product name and domain.
- Pricing: per engagement or firm subscription.
- Which states to support first for state-election and community-property rules.
- Final disclaimer and scope-and-limitations wording (have counsel review).
- Verification of every file in `/content` before the first pilot.
