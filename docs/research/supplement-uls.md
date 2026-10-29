# Adult Tolerable Upper Intake Levels (ULs) for supplement nutrients (NIH ODS): scoping notes

Retrieved: 2026-10-29

**TL;DR.** This is a partial scoping pass. Nothing here is verified from a primary source.
- **Blocked sources.** The NIH ODS site was DNS-blocked from this container for both curl and WebFetch: `ods.od.nih.gov` gave `getaddrinfo ENOTFOUND`, and `api.ods.od.nih.gov` gave no connection. The cross-check sources were blocked too: `www.ncbi.nlm.nih.gov`, `pmc.ncbi.nlm.nih.gov`, `nap.nationalacademies.org`, `www.fda.gov` and `dsld.od.nih.gov` all returned curl status `000`.
- **Search ran out.** Only 11 WebSearch calls ran before the shared per-turn search budget (200 calls across all agents) was exhausted.
- **What we got.** ODS-domain search summaries cover **13 vitamins**: A, C, D, E, K, thiamin, riboflavin, niacin, B6, folate, B12, biotin and pantothenic acid. Every value is tagged `[search]`, and two of them are weak: vitamin K and B6.
- **What is missing.**
  - **Choline and all 17 minerals or trace elements:** calcium, iron, zinc, magnesium, selenium, iodine, copper, manganese, chromium, molybdenum, phosphorus, potassium, sodium, boron, fluoride, vanadium and nickel.
  - All four non-UL advisories: caffeine, melatonin, omega-3 and ashwagandha.
  - The ODS/DSLD machine-readable API check.
  - These rows say **NOT RETRIEVED**. I have not filled them from memory.
- **Design-relevant findings.** The scope of a UL really does vary by nutrient:
  - Niacin (35 mg) and folic acid (1,000 mcg) apply only to *supplemental* forms: supplements, fortified foods and medications.
  - Vitamin E (1,000 mg) applies to *supplemental* alpha-tocopherol in any form.
  - Vitamin A (3,000 mcg) applies to *preformed* vitamin A only. Beta-carotene/provitamin A has no UL.
  - Vitamins C (2,000 mg) and D (100 mcg = 4,000 IU) cover *total* intake from food, beverages and supplements.
  - No UL is set for thiamin, riboflavin, B12, biotin or pantothenic acid. Vitamin K is presumed no UL but unconfirmed.
- **Schema implication.** The UL table needs an `applies_to` scope plus "counted forms". Aggregation must sum only the counted forms. Each row needs a form-specific IU conversion where one applies (vitamin E differs for natural vs synthetic).
- **Before seeding.** Milestone 3 must re-verify every row against the live ODS pages. Either allowlist `ods.od.nih.gov`, or have a human paste in the tables.

Verification tags used:
- `[primary]` would mean I read it on the official page myself. **None in this file.**
- `[search]` means the value came from a WebSearch summary restricted to `ods.od.nih.gov`. It must be re-verified before coding.
- `[search-weak]` means the summary could not see the ODS table and the value rests on a secondary or non-ODS source, or on the search model's own inference.
- `[derived]` means I computed it from `[search]` numbers.
- `NOT RETRIEVED` means no source was read. Do not fill these from memory.

---

## 1. Access status (observed in this container, 2026-10-29)

| Source | Result |
|---|---|
| `https://ods.od.nih.gov/` (curl) | no connection (`000`) |
| `https://ods.od.nih.gov/factsheets/Choline-HealthProfessional/` (WebFetch) | `getaddrinfo ENOTFOUND ods.od.nih.gov` |
| `https://api.ods.od.nih.gov/dsld/v9/` (curl) | `000`. DSLD API availability could not be tested. |
| `https://dsld.od.nih.gov/` | `000` |
| `https://www.ncbi.nlm.nih.gov/books/...`, `https://pmc.ncbi.nlm.nih.gov/` | `000`. NCBI Bookshelf copies of the NASEM DRI reports are unreachable. |
| `https://nap.nationalacademies.org/` | `000` |
| `https://www.fda.gov/` | `000`. FDA caffeine/omega-3 advisories are unreachable. |
| GitHub search API (`/search/code`, `/search/repositories`) | 403: "sessions are bound to their configured repositories". I could not look for mirrored copies. |
| WebSearch | 11 calls succeeded, then "web search budget is used up (limit: 200 WebSearch calls per turn, shared by every agent in it)". |

**Consequence:** this file is a scaffold. The milestone 3 builder needs one of these:
- (a) `ods.od.nih.gov` allowlisted in the session's network settings. This is best, because the fact sheets can then be read directly.
- (b) A fresh research turn with search budget.
- (c) The product owner pasting the ODS UL tables in.

## 2. Definitions and global caveats

- **UL definition (ODS).** ULs, "which the FNB establishes for many nutrients, are the maximum daily intakes unlikely to cause adverse health effects." Source: MVMS fact sheet, https://ods.od.nih.gov/factsheets/MVMS-HealthProfessional/ `[search]`. "Many" means not every nutrient has a UL.
- **ND means "not determinable."** The ODS Pregnancy fact sheet uses ND "due to a lack of data of specific adverse effects", for example for thiamin, riboflavin and B12. Source: https://ods.od.nih.gov/factsheets/Pregnancy-HealthProfessional/ `[search]`. Our table should model this as `no_ul` with reason `ND`, not as a zero or a null amount.
- **Physician-care exclusion.** ODS says the ULs for **vitamin A**, **vitamin D** and **niacin** do not apply to people receiving that nutrient under a physician's care or medical supervision. Sources: the respective fact sheets `[search]`. Whether ODS says the same for every nutrient was not retrieved.
- **Authority.** The values are US Food and Nutrition Board (FNB, National Academies) ULs as republished by ODS. **EFSA (EU) ULs differ**:
  - EFSA vitamin E UL: 300 mg/day for adults, including pregnancy and lactation, covering all dietary sources. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11294871/ `[search]`
  - EFSA kept preformed vitamin A at 3,000 µg RE/day. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11154838/ `[search]`
  - EFSA vitamin D: 100 µg/day for adults. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10407748/ `[search]`
  - An EFSA 2023 vitamin B6 opinion exists (https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10189633/), but I did not retrieve its value.
  - The spec says to use NIH ODS, so use US values only and never mix the two.
- **Age bands.** DRI adult rows are "19+ years" (some tables use 19–50 and 51+). Our onboarding admits **18+**, so 18-year-olds fall in the **14–18** band, where several ULs are lower. Some 14–18 values were seen in passing; they are listed in the table's caveats column. See §6.

## 3. Reference table: adult (19+) ULs

Column "applies to":
- `total` = food + beverages + supplements.
- `supplemental only` = supplements, fortified foods and medications. This is not naturally occurring food content.
- `specific form` = only one chemical form counts.

| nutrient | adult UL | unit | applies to | form caveats | pregnancy/lactation | source URL | verification |
|---|---|---|---|---|---|---|---|
| Vitamin A (preformed: retinol/retinyl esters) | 3,000 | mcg (retinol; ODS expresses RAE, and for retinol 1 mcg = 1 mcg RAE, but verify the table's exact unit label) | specific form: **preformed vitamin A only**, from food + supplements | **No UL for beta-carotene or other provitamin A carotenoids.** The ULs do not apply to people taking vitamin A under a physician's care. | 19+ pregnancy: 3,000 mcg. ImmuneFunction sheet: "up to 3,000 mcg/day is safe for adults, including women who are pregnant or lactating". Pregnancy 14–18: 2,800 mcg. | https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/ (also https://ods.od.nih.gov/factsheets/ImmuneFunction-HealthProfessional/, https://ods.od.nih.gov/factsheets/Pregnancy-HealthProfessional/) | [search] |
| Vitamin C | 2,000 | mg | total (food, beverages, supplements) | 14–18 y: 1,800 mg. GI effects above the UL (diarrhea, nausea, cramps). Hemochromatosis caution (iron overload). Absorption falls below 50% above 1 g/day. | 2,000 mg (19+, pregnant or lactating, per ImmuneFunction sheet) | https://ods.od.nih.gov/factsheets/VitaminC-HealthProfessional/ (also https://ods.od.nih.gov/factsheets/VitaminC-Consumer/) | [search] |
| Vitamin D | 100 (= 4,000 IU) | mcg | total (food, beverages, supplements) | IU to mcg: 40 IU = 1 mcg (derived from 100 mcg = 4,000 IU). The ULs do not apply to vitamin D treatment under a physician's care. UL set by IOM in 2011. | NOT RETRIEVED. The search summary did not state pregnancy or lactation values. | https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/ (also https://ods.od.nih.gov/pdf/factsheets/vitamind-consumer.pdf) | [search] |
| Vitamin E (alpha-tocopherol) | 1,000 (= 1,500 IU natural or 1,100 IU synthetic) | mg | supplemental only: "all forms of supplemental alpha-tocopherol, including the eight stereoisomers present in synthetic vitamin E" | Store the IU equivalents per form: natural (d-/RRR) 1,500 IU, synthetic (dl-/all-rac) 1,100 IU. ODS notes the evidence is limited (small groups taking up to 3,200 mg/day for weeks or months). Risk is bleeding/hemorrhagic stroke. 14–18 y: 800 mg (1,200 IU). | 1,000 mg (adults including pregnant or lactating, per ImmuneFunction sheet) | https://ods.od.nih.gov/factsheets/VitaminE-HealthProfessional/ (also https://ods.od.nih.gov/factsheets/PrimaryMitochondrialDisorders-HealthProfessional/) | [search] |
| Vitamin K | **No UL established** (unconfirmed) | n/a | n/a | The search summary could not see the UL section. It said "from general knowledge… the 2001 FNB report did not set a UL". **Treat as unconfirmed.** A warfarin interaction caution is likely relevant but was not retrieved. | NOT RETRIEVED | https://ods.od.nih.gov/factsheets/VitaminK-HealthProfessional/ | [search-weak] |
| Thiamin (B1) | **No UL established** | n/a | n/a | FNB set no UL because there are no reports of adverse effects from high intakes (50 mg/day or more) from food or supplements. Absorption falls sharply above about 5 mg. | ND (Pregnancy sheet, 14–18 and 19–50) | https://ods.od.nih.gov/factsheets/Thiamin-HealthProfessional/ (also https://ods.od.nih.gov/HealthInformation/ODS_Frequently_Asked_Questions.aspx) | [search] |
| Riboflavin (B2) | **No UL established** | n/a | n/a | No adverse effects reported at 400 mg/day for at least 3 months | ND (Pregnancy sheet) | https://ods.od.nih.gov/factsheets/Riboflavin-HealthProfessional/ | [search] |
| Niacin (B3) | 35 | mg (niacin; **not** mg NE) | supplemental only: "supplements, fortified foods, medications", not niacin naturally present in food | Applies to **both** nicotinic acid and nicotinamide (niacinamide). Basis is flushing. Does not apply under medical supervision. Inositol hexanicotinate: NOT RETRIEVED. | Pregnancy 19–50: 35 mg; 14–18: 30 mg. Lactation: NOT RETRIEVED. | https://ods.od.nih.gov/factsheets/Niacin-HealthProfessional/ (also https://ods.od.nih.gov/factsheets/Pregnancy-HealthProfessional/, https://ods.od.nih.gov/factsheets/PrimaryMitochondrialDisorders-HealthProfessional/) | [search] (the UL table itself was not seen; 35 mg comes from the Pregnancy and Mitochondrial sheets) |
| Vitamin B6 | 100 | mg | NOT RETRIEVED (total vs supplemental) | Sensory neuropathy is the critical effect. ODS consumer page: high supplemental doses for a year or more "can cause severe nerve damage", which usually resolves after stopping. **Conflict check pending:** the EFSA 2023 B6 opinion exists and its value was not retrieved. | NOT RETRIEVED | https://ods.od.nih.gov/factsheets/VitaminB6-HealthProfessional/ (also https://ods.od.nih.gov/factsheets/VitaminB6-Consumer/) | [search-weak] (the ODS snippet cut off before the table; 100 mg comes from a patent citing FNB and from a passing mention in another ODS-domain summary) |
| Folate / folic acid | 1,000 | mcg **folic acid** (not mcg DFE) | supplemental only: folic acid from supplements and fortified foods. Natural food folate is excluded. | DFE: 1 mcg DFE = 1 mcg food folate = 0.6 mcg folic acid from supplements/fortified foods, so 1 mcg folic acid = 1.667 mcg DFE (derived). The consumer sheet example says 240 mcg folic acid = 400 mcg DFE. **Whether the UL covers L-methylfolate (5-MTHF) was NOT RETRIEVED.** | 19+ pregnancy and lactation: 1,000 mcg. Pregnancy 14–18: 800 mcg. | https://ods.od.nih.gov/factsheets/Folate-HealthProfessional/ (also https://ods.od.nih.gov/pdf/factsheets/folate-consumer.pdf, https://ods.od.nih.gov/factsheets/Pregnancy-HealthProfessional/) | [search] |
| Vitamin B12 | **No UL established** | n/a | n/a | ODS consumer: "has not been shown to cause any harm, even at high doses"; supplement doses of 500 or 1,000 mcg are "considered safe". The HP sheet's exact wording was not seen. | ND (Pregnancy sheet) | https://ods.od.nih.gov/factsheets/VitaminB12-HealthProfessional/ (also https://ods.od.nih.gov/pdf/factsheets/vitaminb12-consumer.pdf) | [search] |
| Biotin | **No UL established** | n/a | n/a | No human evidence of toxicity. No adverse effects at 10–50 mg/day; up to 200 mg/day oral in biotinidase deficiency. Whether ODS discusses biotin interference with lab tests was NOT RETRIEVED, but it is worth checking as a non-UL advisory. | NOT RETRIEVED | https://ods.od.nih.gov/factsheets/Biotin-HealthProfessional/ | [search] |
| Pantothenic acid | **No UL established** | n/a | n/a | No reports of toxicity in humans. About 10 g/day can cause mild diarrhea or GI distress. | NOT RETRIEVED | https://ods.od.nih.gov/factsheets/PantothenicAcid-HealthProfessional/ | [search] |
| Choline | NOT RETRIEVED | — | — | — | — | ODS URL not confirmed | — (search budget exhausted on this query) |
| Calcium | NOT RETRIEVED | — | — | — | — | https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/ (URL seen in search results; content not read) | — |
| Iron | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Zinc | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Magnesium | NOT RETRIEVED. The task brief says supplemental and medication forms only; **unverified**. | — | — | — | — | not confirmed | — |
| Selenium | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Iodine | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Copper | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Manganese | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Chromium | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Molybdenum | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Phosphorus | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Potassium | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Sodium | NOT RETRIEVED. The DRI framework for sodium may use a different limit concept than a UL; **verify**. | — | — | — | — | not confirmed (an ODS HP fact sheet may not exist; use NASEM DRI tables) | — |
| Boron | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Fluoride | NOT RETRIEVED | — | — | — | — | not confirmed | — |
| Vanadium | NOT RETRIEVED | — | — | — | — | not confirmed (an ODS HP fact sheet may not exist; use NASEM DRI tables) | — |
| Nickel | NOT RETRIEVED | — | — | — | — | not confirmed (an ODS HP fact sheet may not exist; use NASEM DRI tables) | — |

**ODS fact sheet URL pattern.** Every confirmed HP URL has the form `https://ods.od.nih.gov/factsheets/<Name>-HealthProfessional/`:
- Confirmed names: `VitaminA`, `VitaminC`, `VitaminD`, `VitaminE`, `VitaminK`, `Thiamin`, `Riboflavin`, `Niacin`, `VitaminB6`, `Folate`, `VitaminB12`, `Biotin`, `PantothenicAcid`, `Calcium`.
- Related sheets also confirmed: `Pregnancy`, `MVMS`, `ImmuneFunction`, `PrimaryMitochondrialDisorders`, `ExerciseAndAthleticPerformance`, `COVID19`.
- The path seems to be case-insensitive: search results returned both `folate-HealthProfessional` and `Folate-HealthProfessional`.
- Some search results carried tracking query strings (`?uid=…`). **Strip query strings** before storing a URL.
- Do not guess URLs for the unretrieved nutrients. Confirm each one when the site is reachable.

### 3a. Non-UL advisories ("advisory, not a UL")

None of these were retrieved. The values below are from the **task brief only** and are listed as items to verify, not facts.

| ingredient | advisory (unverified) | likely official source to read | verification |
|---|---|---|---|
| Caffeine | Task brief: FDA says 400 mg/day for healthy adults | FDA consumer page (fda.gov is blocked here) | NOT RETRIEVED |
| Omega-3 (EPA+DHA) | Task brief: FDA guidance of up to 5 g/day EPA+DHA from supplements | FDA, plus the ODS Omega-3 HP fact sheet | NOT RETRIEVED |
| Melatonin | Task brief: "safety cautions" (no number given) | ODS or NCCIH | NOT RETRIEVED |
| Ashwagandha | Task brief: liver-injury warnings | ODS Ashwagandha HP fact sheet | NOT RETRIEVED |

## 4. Unit conversions the code will need

| conversion | value | basis | verification |
|---|---|---|---|
| Vitamin D, IU to mcg | 1 mcg = 40 IU (multiply IU by 0.025) | ODS: UL 100 mcg = 4,000 IU; RDA 15–20 mcg = 600–800 IU (consistent) | [search] / [derived] |
| Vitamin E, IU to mg alpha-tocopherol, **for UL comparison** | natural (d-/RRR-α-tocopherol and its esters): 1,000 mg / 1,500 IU ≈ **0.667 mg per IU**. Synthetic (dl-/all-rac): 1,000 mg / 1,100 IU ≈ **0.909 mg per IU**. | ODS UL statement "1,000 mg/day (1,500 IU of natural or 1,100 IU of synthetic)" | [search] / [derived] |
| Vitamin E caveat | Verify whether ODS gives a **different** synthetic IU-to-mg factor for RDA/intake purposes, since only some stereoisomers count toward the RDA. If it does, **never use the RDA-basis factor for UL checks.** Simplest implementation: compare label IU directly to the form-specific UL in IU (1,500 or 1,100). | — | NOT RETRIEVED |
| Folate, DFE vs folic acid | 1 mcg DFE = 1 mcg food folate = 0.6 mcg folic acid (supplements or fortified foods), so **1 mcg folic acid = 1.667 mcg DFE**, and mcg folic acid = mcg DFE × 0.6 (when the label's folate is entirely folic acid). The task brief's "1.7" is the rounded form. | ODS Folate HP and consumer sheets (240 mcg folic acid = 400 mcg DFE) | [search] / [derived] |
| Folate caveat | Whether ODS lists a separate factor for folic acid taken on an empty stomach, and how labels split "mcg DFE (X mcg folic acid)": NOT RETRIEVED | — | NOT RETRIEVED |
| Vitamin A, IU to mcg RAE (retinol vs beta-carotene; supplement vs dietary beta-carotene) | **NOT RETRIEVED** | ODS Vitamin A HP fact sheet | — |
| Niacin, NE | The UL is in **mg of supplemental niacin**, so NE is not needed for UL checks. RDAs are in mg NE: 16 (men 19+), 14 (women 19+), 18 (pregnancy). The tryptophan-to-NE factor: NOT RETRIEVED. | ODS Niacin and Pregnancy sheets | [search] |

## 5. Machine-readable ODS data (DSLD / ODS API)

- **Not verified.** Both hosts named in the task brief failed from this container: `ods.od.nih.gov/api` (DNS) and `api.ods.od.nih.gov/dsld` (curl `000`). No WebSearch budget was left to read their docs.
- Still to establish:
  - Does the DSLD API exist, what version is it, and what is its base path?
  - Does it need auth or an api.data.gov key?
  - What are its rate limits?
  - Which endpoints matter: label by ID, search by product or UPC, and ingredient rows with amount, unit and form.
  - Does the ODS fact-sheet API return HTML/XML that contains the UL tables? If so, it is a candidate for automated re-verification of this table.
- Why it might matter: DSLD label rows could prefill or cross-check our Claude-vision label extraction, for example by UPC lookup. It is optional for milestone 3. Photo extraction stays the primary path.

## 6. Implications for our design

1. **Row shape for the `nutrient_uls` reference table.**
   - Identity: `nutrient_key` (canonical name), `aliases[]`.
   - Amount: `life_stage` (`adult_19_plus`, and optionally `age_14_18`, `pregnancy_19_plus`, `lactation_19_plus`), `ul_amount` (nullable), `ul_unit` (`mg` | `mcg`), plus optional `ul_amount_iu_by_form` (vitamin E natural 1,500 / synthetic 1,100; vitamin D 4,000).
   - Scope: `applies_to` (`total` | `supplemental_only` | `specific_form`), `counted_forms[]` (for example `preformed_retinol`, `folic_acid`, `nicotinic_acid`, `nicotinamide`, `alpha_tocopherol_any`), `excluded_forms[]` (`beta_carotene`, `food_folate`).
   - No-UL handling: `no_ul_reason` (`ND`).
   - Provenance: `physician_care_exclusion` (bool), `source_url` (no query string), `source_fact_sheet_updated` (the date shown on the page), `retrieved_at`, `verification` (`primary` before seeding).
   - Seed only rows with `verification = primary`. Carry the `NOT RETRIEVED` rows as TODOs, not nulls.
2. **Aggregation sums only counted forms.**
   - Vitamin A: sum preformed only. Ignore beta-carotene. If a label gives total vitamin A without a form split, the result is "indeterminate". Don't assume all of it is retinol or all beta-carotene; say "might exceed if it is mostly retinol".
   - Folate: sum **folic acid mcg**. Convert from DFE (×0.6) only when the form is folic acid.
   - Vitamin E: convert IU using the form-specific factor. If the form (d- vs dl-) is unknown, use the conservative synthetic factor (0.909 mg/IU), which gives the higher mg.
   - All of this happens in code, per the spec. The model only extracts amount, unit and form.
3. **Wording depends on scope.** We track supplements, not food micronutrients.
   - For `total` ULs (A, C, D), the supplement total is a lower bound, so phrase it as "from supplements alone you're at X; food adds more".
   - For `supplemental_only` ULs (niacin, folic acid, E), supplements cover nearly everything; only fortified foods are missing.
4. **The extraction schema must capture form,** not just amount and unit: retinol/retinyl palmitate vs beta-carotene, folic acid vs methylfolate vs food folate, d- vs dl-alpha-tocopherol, nicotinic acid vs niacinamide. It must also capture IU vs mcg vs mg, and mcg DFE with the folic acid in parentheses. Minerals need an "elemental vs compound weight" field. This was not researched here; verify the FDA Supplement Facts rules.
5. **No-UL nutrients** (thiamin, riboflavin, B12, biotin, pantothenic acid, and probably K): never flag "over UL". Duplicate detection still applies.
6. **Physician-care exclusion.** If a user says a dose was prescribed (for example high-dose vitamin D), acknowledge it and defer to their doctor rather than flagging it as over the UL.
7. **18-year-olds.** Users aged 18 are in the 14–18 DRI band, where lower ULs were seen: A 2,800 mcg (pregnancy row), C 1,800 mg, E 800 mg, niacin 30 mg (pregnancy row), folic acid 800 mcg (pregnancy row). Sensible default: apply 19+ adult values, because we don't collect age, and log this in DECISIONS.md. Optionally store the 14–18 rows for later.
8. **Pregnancy and lactation.** Store the values when verified, but don't personalize thresholds. Per the spec, pregnancy triggers "check with a pharmacist or doctor".
9. **Daily basis.** ULs are daily maxima. Normalize the stack to a per-day amount (serving × servings per day × days per week ÷ 7). Also flag single-day doses above the UL, for example a weekly 50,000 IU vitamin D. Whether ODS gives guidance on averaging intermittent doses was not retrieved.

## 7. Open questions for the product owner

1. **Network access for milestone 3.** Please allowlist `ods.od.nih.gov` (and ideally `www.ncbi.nlm.nih.gov` and `nap.nationalacademies.org` for the NASEM DRI tables) in the session's network settings. Otherwise, approve a follow-up research turn with WebSearch budget. Without one of these, the 18 missing nutrients and the advisories can't be sourced. The spec forbids filling them from memory.

## 8. Risks

- **Every value here is `[search]` or weaker.** Search summaries paraphrase, and they sometimes add the model's own inference; the vitamin K summary admitted "from general knowledge". Re-verify each row on the live ODS page before seeding.
- **Coverage gap.** 18 of the 31 nutrients (choline and all minerals) plus all advisories and the DSLD check were not covered, because the shared search budget ran out after 11 queries.
- **ODS pages change.** Each fact sheet shows an "Updated" date. Store it alongside `retrieved_at` and re-check periodically.
- **US vs EU divergence.** EFSA vitamin E is 300 mg/day vs US 1,000 mg supplemental. B6 also differs (the EFSA value was not retrieved). Users may quote other numbers; we cite ODS.
- **Form ambiguity on labels** can produce false positives (beta-carotene counted as retinol) or false negatives (synthetic E IU converted with the wrong factor, or a mineral compound weight mistaken for elemental weight).
- **Methylfolate (5-MTHF).** It is increasingly common in supplements, and its UL coverage was not retrieved. Treating it as folic acid may over-warn; ignoring it may under-warn.
- **Scope of "over UL" messaging.** It must stay general-wellness. A UL is not a toxicity threshold, and the ULs explicitly do not apply under physician care.

## 9. Sources

- https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/
- https://ods.od.nih.gov/factsheets/VitaminC-HealthProfessional/
- https://ods.od.nih.gov/factsheets/VitaminC-Consumer/
- https://ods.od.nih.gov/pdf/factsheets/vitaminc-Consumer.pdf
- https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/
- https://ods.od.nih.gov/pdf/factsheets/vitamind-consumer.pdf
- https://ods.od.nih.gov/factsheets/VitaminE-HealthProfessional/
- https://ods.od.nih.gov/pdf/factsheets/vitamine-consumer.pdf
- https://ods.od.nih.gov/factsheets/VitaminK-HealthProfessional/
- https://ods.od.nih.gov/factsheets/Thiamin-HealthProfessional/
- https://ods.od.nih.gov/factsheets/Riboflavin-HealthProfessional/
- https://ods.od.nih.gov/factsheets/Niacin-HealthProfessional/
- https://ods.od.nih.gov/pdf/factsheets/Niacin-Consumer.pdf
- https://ods.od.nih.gov/factsheets/VitaminB6-HealthProfessional/
- https://ods.od.nih.gov/factsheets/VitaminB6-Consumer/
- https://ods.od.nih.gov/factsheets/Folate-HealthProfessional/
- https://ods.od.nih.gov/pdf/factsheets/folate-consumer.pdf
- https://ods.od.nih.gov/factsheets/VitaminB12-HealthProfessional/
- https://ods.od.nih.gov/pdf/factsheets/vitaminb12-consumer.pdf
- https://ods.od.nih.gov/factsheets/Biotin-HealthProfessional/
- https://ods.od.nih.gov/factsheets/PantothenicAcid-HealthProfessional/
- https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/ (URL only; content not read)
- https://ods.od.nih.gov/factsheets/Pregnancy-HealthProfessional/
- https://ods.od.nih.gov/factsheets/MVMS-HealthProfessional/
- https://ods.od.nih.gov/factsheets/ImmuneFunction-HealthProfessional/
- https://ods.od.nih.gov/factsheets/PrimaryMitochondrialDisorders-HealthProfessional/
- https://ods.od.nih.gov/HealthInformation/ODS_Frequently_Asked_Questions.aspx
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11154838/ (EFSA vitamin A/β-carotene UL opinion; cross-check only)
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11294871/ (EFSA vitamin E UL opinion; cross-check only)
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10407748/ (EFSA vitamin D UL opinion; cross-check only)
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10189633/ (EFSA vitamin B6 UL opinion; title only, value not retrieved)
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9574221 (patent citing the FNB B6 UL of 100 mg; secondary, weak)

## Critic addendum (2026-10-29)

Completeness-critic pass, appended to this file without changing the content above. Tags as above, plus **[primary-mirror]** = official regulation text read verbatim from the eCFR GitHub mirror (snapshot 2025-02-06) that `compliance.md` also uses. ecfr.gov itself is DNS-blocked here, so re-check on ecfr.gov before citing.

**Status of the UL gap: still open.** I tried to close the mineral and choline rows with WebSearch restricted to `ods.od.nih.gov` (magnesium, zinc, iron, calcium, selenium, iodine). Every call returned "web search budget is used up (limit: 200 WebSearch calls per turn)". `ods.od.nih.gov`, `web.archive.org`, `en.wikipedia.org`, `www.cdc.gov` and `www.ecfr.gov` all returned curl `000` from this container. Per the search tool's instruction I did not work around the limit. **No new UL values were added, and none were filled from memory.** Milestone 3 still needs one of: (a) `ods.od.nih.gov` allowlisted, (b) a new turn with search budget, or (c) the owner pasting in the ODS tables. This is the single biggest sourcing gap across all research notes, because SPEC §6 requires every UL row to carry its ODS source URL.

**Closed: how Supplement Facts labels state amounts (this shapes the extraction schema now).** Source: 21 CFR 101.36 and 101.9 [primary-mirror].
- **Mineral amounts on labels are elemental.** §101.36(b)(2)(ii): "The quantitative amounts by weight shall represent the weight of the dietary ingredient rather than the weight of the source of the dietary ingredient (e.g., the weight of calcium rather than that of calcium carbonate)." §101.36(b)(3)(ii) says the same for "other dietary ingredients" (the weight of the ingredient, "not the weight of any component, or the source"). The source compound may appear as "Calcium (as calcium carbonate)" (§101.36(d)). **Design consequence:** the extractor should take the number next to the nutrient name as the elemental amount, and store the "(as …)" compound separately as `source_form`. This also resolves item 4 of §6 above ("elemental vs compound weight… not researched").
- **Folate and folic acid.** §101.9(c)(8)(vii): the name "folate" covers natural folate, "synthetic folate as a component of dietary supplement, such as calcium salt of L-5-MTHF", folic acid, or a mix. The amount is declared **in mcg DFE**. When folic acid is added, "folic acid" and its amount **in mcg of folic acid** go **in parentheses** after the folate line. **Design consequence:** for the folic-acid UL, read the parenthetical mcg folic acid directly, with no DFE conversion. A folate line with **no** folic-acid parenthetical (for example, a label that says "as L-5-MTHF") has no folic acid to count toward that UL. Whether the ODS UL covers 5-MTHF is still NOT RETRIEVED; flag it as "indeterminate" rather than over the limit.
- **Vitamin A form split.** §101.36(b)(2)(i)(B)(*3*): the percent of vitamin A present as beta-carotene "may be declared" (it is required only when a beta-carotene claim is made). Example: "Vitamin A (90% as beta-carotene)". It may also carry mcg: "Vitamin A (90% (810 mcg) as beta-carotene)". **Design consequence:** when present, preformed = total − beta-carotene share. When absent, the preformed share is unknown, so treat it as "indeterminate", as §6 item 2 already says.
- **Vitamin D units.** §101.36(b)(2)(ii)(B): mcg is mandatory, and IU is optional, "in parentheses after the declaration of the amount of vitamin D in mcg". **Design consequence:** prefer the mcg figure, and use IU only as a fallback (for old or foreign labels).
- **Vitamin E.** 101.9 has a record-keeping rule for mixtures of *all rac*- and RRR-α-tocopherol (§101.9(g)(10)(vi)). This confirms that the synthetic/natural distinction matters for the declared mg. The (c)(8)(iv) table of units (mcg RAE, mg α-tocopherol, mg NE) did **not** survive the mirror's Markdown conversion: NOT RETRIEVED.
- **Per serving vs per day.** Amounts are per serving, and serving size is expressed in units such as "tablets" or "capsules" (§101.36(b)(1)). Labels **may** add a "Per Day (3 Caplets)" column, or text such as "Multiply amounts by 3 for total daily amount" (§101.36(e)(9)(ii)). **Design consequence:** the extractor should capture `per_day_multiplier` when a label states one. Otherwise ask the user for servings per day, because UL checks are daily.
- **Proprietary blends.** §101.36(c)(3): only the **total** weight of the blend's "other dietary ingredients" is given. Individual amounts are not disclosed. Vitamins and minerals inside a blend are still declared individually per (b)(2) (§101.36(c)(1)). **Design consequence:** never treat a blend's total weight as any single ingredient's amount. Record each component as present with an unknown amount, and report "can't total" rather than "under the UL".
- **Canonical label order and names**, which are useful as extraction aliases (§101.36(b)(2)(i)(B)): Vitamin A, vitamin C, vitamin D, vitamin E, vitamin K, thiamin, riboflavin, niacin, vitamin B6, folate and folic acid, vitamin B12, biotin, pantothenic acid, choline, calcium, iron, phosphorus, iodine, magnesium, zinc, selenium, copper, manganese, chromium, molybdenum, chloride, sodium, potassium, fluoride. Permitted synonyms: "Vitamin C (ascorbic acid), thiamin (vitamin B1), riboflavin (vitamin B2)" (§101.36(b)(2)(i)(B)(*2*)).

**Suspicious or weak items in this file (critic view):**
- The vitamin K "no UL" row says "from general knowledge" in the search summary. That is effectively memory, so it fails the SPEC's "don't rely on memory" rule. Keep it out of the seed until it is primary-verified.
- The B6 100 mg row rests on a patent and an incidental mention. Treat it as unverified.
- The 14–18 band values are pregnancy-row values seen in passing, not the general 14–18 UL rows. Don't use them as the 18-year-old default without verification.

Sources for this addendum:
- https://raw.githubusercontent.com/lucas-amberg/ecfr-analyzer/main/public/ecfr/2025-02-06/21/I/B/101/C/101.36/101.36.md (mirror of https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101/subpart-C/section-101.36)
- https://raw.githubusercontent.com/lucas-amberg/ecfr-analyzer/main/public/ecfr/2025-02-06/21/I/B/101/A/101.9/101.9.md (mirror of https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101/subpart-A/section-101.9)
