# USDA FoodData Central (FDC): API and data for grounding calorie/macro estimates

Retrieved: 2026-10-29

**TL;DR.** FDC is a free REST API at `https://api.nal.usda.gov/fdc/v1/`. You authenticate with an api.data.gov key, passed as the `api_key` query parameter or the `X-Api-Key` header. The default limit is 1,000 requests per hour. Going over returns HTTP 429 `OVER_RATE_LIMIT`, and the key stays blocked for about an hour on a rolling window. `DEMO_KEY` is limited to 30 requests per hour and 50 per day per IP. There are six endpoints. The ones we need are `GET|POST /v1/foods/search` (keyword search, max `pageSize` 200, returns the full per-100 g nutrient list for each hit) and `GET /v1/food/{fdcId}` (detail, including `foodPortions` gram weights).

For "a plate of chicken and rice" the right sources are **Survey (FNDDS) 2021-2023** and **SR Legacy**:
- FNDDS has about 5,400 foods, including mixed/prepared dishes. Every food has the same 65-nutrient per-100 g profile (energy plus 64 nutrients), plus about 22k household portion weights.
- SR Legacy has 7,793 foods and was frozen in 2018. It includes "Restaurant Foods" and "Fast Foods" categories.
- **Foundation** has a few hundred raw or lightly processed foods with the newest analytical data. Its energy field is inconsistent: values may be in 2047/2048 (Atwater) rather than 1008, or missing.
- **Branded** has about 2M label-derived rows, roughly 432k unique UPCs. It floods keyword search, and its `foodNutrients` are per 100 g **or per 100 ml**, back-calculated from the per-serving label.

Key nutrient IDs and numbers: kcal 1008/"208", Atwater general 2047/"957", Atwater specific 2048/"958", kJ 1062/"268", protein 1003/"203", fat 1004/"204", carbohydrate by difference 1005/"205", fiber 1079/"291", total sugars 2000/"269", sodium 1093/"307", saturated fat 1258/"606".

The data is public domain (CC0 1.0). Attribution is requested, not required. Bulk downloads are small for everything except Branded. The latest full release is 2026-04-30 (Foundation and Branded). FNDDS is 2024-10-31 and SR Legacy is the final 2018-04 release. **Recommendation:** pre-seed Postgres from FNDDS + SR Legacy + Foundation (about 13.6k foods, a few tens of MB) and call the live API only for misses and packaged items.

Verification tags:
- `[primary]`: read by me from an official page or the official doc-site source repo.
- `[sdk-source]`: read by me from an official machine-readable API definition (USDA's OpenAPI file, read via byte-identical GitHub mirrors because fdc.nal.usda.gov is blocked here).
- `[search]`: from a WebSearch summary, which must be re-verified. `[search](3p)` marks a fact I read myself from third-party GitHub code, notes or captured real API responses. That is not official, so treat it like `[search]` and re-verify with one live call before coding.

---

## 1. API surface

### Base URL and spec
- Server: `https://api.nal.usda.gov/fdc`. All paths are prefixed with `/v1`. `[sdk-source]`
- OpenAPI: USDA publishes `/v1/json-spec` and `/v1/yaml-spec`, plus HTML at `https://fdc.nal.usda.gov/api-spec/fdc_api.html`. Two versions are in circulation:
  - **1.0.0** ("Last modified: 2020-04-30"). It wrongly declares the search response as an *array* of `SearchResult`.
  - **1.0.1** (SwaggerHub `fdcnal/food-data_central_api/1.0.1`). It fixes the search response to a single object and adds POST search fields `startDate`, `endDate` and `tradeChannel`.
  - A July 2026 snapshot captured by a third party still reports `version: 1.0.0`. **Neither spec matches the field names the live search endpoint actually returns** (see the response-shape notes below). `[sdk-source]` for the spec contents, `[search](3p)` for the snapshot.
- The old NDB API (USDA Food Composition Databases) was discontinued on 2020-03-31. `[search](3p, copy of the API guide)`

### Endpoints `[sdk-source]`
| Path | Verb | Purpose | Limits |
|---|---|---|---|
| `/v1/food/{fdcId}` | GET | One food, full or abridged | `format`, `nutrients` (≤25). Unknown ID → **404** |
| `/v1/foods` | GET (`fdcIds=` comma list or repeated) / POST `{fdcIds:[...], format, nutrients}` | Multiple foods | ≤**20** IDs. Invalid or missing IDs are silently omitted (200 with fewer items) |
| `/v1/foods/list` | GET / POST | Paged list, always abridged | `dataType`, `pageSize` (1–200, default 50), `pageNumber`, `sortBy`, `sortOrder` |
| `/v1/foods/search` | GET / POST | Keyword search | see params below. Zero hits → 200 with `totalHits: 0` `[search](3p)` |
| `/v1/json-spec`, `/v1/yaml-spec` | GET | The spec itself | |

### Search parameters (`/v1/foods/search`)
- `query` (string, required). It accepts the FDC search operators:
  - `"exact phrase"`
  - `+required`, `-excluded`
  - `*` wildcard
  - `( )` grouping. **Unmatched parentheses cause an error.**
  - `field:` prefix, e.g. `description:`, `additionalDescriptions:`, `commonNames:`, `scientificName:`
  
  `[search]` (help page). A third-party client documents that the backend is a Lucene query parser: unbalanced `"`, `(`, `)`, `[`, `]`, `{`, `}` or a stray `/` return a bare **400**, so escape user text before sending. `[search](3p)`
- `dataType`: array, any of exactly `Branded`, `Foundation`, `Survey (FNDDS)`, `SR Legacy` (1–4 values). On GET it is `style: form, explode: false`, i.e. comma-separated (`dataType=Foundation,SR%20Legacy`). On POST it is a JSON array. "Experimental" is **not** in the enum. `[sdk-source]`
- `pageSize`: 1–200, default 50. `pageNumber`: integer. `[sdk-source]`
  - The spec says "offset = pageNumber × pageSize", but live responses echo `pageNumber: 1` / `currentPage: 1` for the first page. **Treat it as 1-based and verify.** `[search](3p)`
- `sortBy`: `dataType.keyword` | `lowercaseDescription.keyword` | `fdcId` | `publishedDate`. `sortOrder`: `asc` | `desc`, and it only applies with `sortBy`. With no `sortBy`, results are relevance-ranked (`score`). `[sdk-source]`
- `brandOwner` (string, Branded only). `[sdk-source]`
- 1.0.1 adds three POST-body-only fields. `[sdk-source]`
  - `startDate` / `endDate` (`YYYY-MM-DD`, published-date filter)
  - `tradeChannel` (array ≤3 of `CHILD_NUTRITION_FOOD_PROGRAMS`, `DRUG`, `FOOD_SERVICE`, `GROCERY`, `MASS_MERCHANDISING`, `MILITARY`, `ONLINE`, `VENDING`)
- `requireAllWords` (boolean) is **not in either OpenAPI version**. The website documents a "Require All Words" checkbox. Every captured live response echoes `"requireAllWords": false` in `foodSearchCriteria`, and several clients send it in the POST body. It probably works, but it is unofficial: verify before relying on it. `[search]` + `[search](3p)`
- `foodCategory` in the POST body is used by one third-party client. It is undocumented, so verify. `[search](3p)`
- `format` and `nutrients` are **not** search parameters. `[sdk-source]`

### `format` and `nutrients` (detail endpoints only) `[sdk-source]`
- `format=abridged|full`. The default is `full`. `/foods/list` is always abridged.
- `nutrients`: up to 25 **nutrient numbers** (legacy SR numbers such as `203,204,205,208` or `957,958`), **not** nutrient IDs (1003, 1008, …). It takes a comma list or repeated params. If none match, the food comes back with an empty `foodNutrients`. A third-party client confirms that sending IDs returns empty arrays. `[sdk-source]` + `[search](3p)`

### Response shapes (as actually returned)
**Search** (a single object, not an array). The following comes from real responses captured in 2024–2026 by third parties. `[search](3p)`
```
{ totalHits, currentPage, totalPages, pageList:[1..10],
  foodSearchCriteria:{ query, generalSearchInput, dataType?, pageNumber, numberOfResultsPerPage:50, pageSize, requireAllWords:false, foodTypes? },
  foods:[ SearchFood ], aggregations:{ dataType:{ "Branded":25638, "SR Legacy":89, "Survey (FNDDS)":42, "Foundation":6 }, nutrients:{} } }
```
`SearchFood` fields:
- All types: `fdcId`, `description`, `dataType`, `publishedDate` (**ISO `YYYY-MM-DD`**), `score`, `allHighlightFields` (HTML `<em>`), `foodCategory` (**string**), `foodNutrients[]`, `foodMeasures[]`, `additionalDescriptions`, `commonNames`, `microbes`, `foodAttributes`, `foodVersionIds`, `finalFoodInputFoods`.
- Foundation/SR add `ndbNumber` (**number** in JSON; the spec says string). Foundation adds `mostRecentAcquisitionDate`. Some records carry `scientificName`.
- FNDDS adds `foodCode` (e.g. `"72201100"`).
- Branded adds `gtinUpc`, `brandOwner`, `brandName`, `ingredients`, `marketCountry`, `servingSize` (number), `servingSizeUnit` (`g` / `ml` / `GRM` seen), `householdServingFullText` (e.g. `"5.5 ONZ"`, `"8 OZA"`), `packageWeight`, `tradeChannels`, `dataSource:"LI"`, `modifiedDate`.

`SearchFood.foodNutrients[]` fields: `nutrientId` (int, e.g. 1008), `nutrientNumber` (**string**, e.g. `"208"`), `nutrientName`, `unitName` (**UPPERCASE**: `KCAL`, `G`, `MG`, `UG`, `IU`, but `kJ`), `value` (per 100 g/ml), `derivationCode`, `derivationDescription`, `derivationId`, `foodNutrientSourceId`/`Code`/`Description`, `rank`, `indentLevel`, `foodNutrientId`. Foundation records add `dataPoints`, `min`, `max`, `median`. Branded records add `percentDailyValue`.
- Search hits carry the **full** nutrient list in the samples: FNDDS always 65, SR 116, Foundation 29–107, Branded 7–15. So a search call usually gives enough data to compute macros without a detail call. `[search](3p)`

`SearchFood.foodMeasures[]` is filled for FNDDS and empty for Foundation and SR in the samples. Each entry is `{disseminationText:"1 floweret", gramWeight:10, modifier:"60782", rank, measureUnitId:9999, measureUnitName:"undetermined", measureUnitAbbreviation}`. FNDDS always includes **`"Quantity not specified"` (modifier `90000`)**, which is a default typical portion in grams (e.g. 45 g broccoli, 155 g Eggs Benedict). That is a useful fallback when the user gives no portion. `[search](3p)`

**Detail (`format=full`)**. Top-level keys differ by type: `[sdk-source]` for the schema names, `[search](3p)` for observed records.
- Foundation: `fdcId`, `dataType`, `description`, `foodClass:"FinalFood"`, `ndbNumber`, `publicationDate` (**`M/D/YYYY`** string, e.g. `"10/30/2020"`), `foodCategory{id,code,description}`, `foodNutrients`, `foodPortions`, `foodComponents`, `inputFoods`, `nutrientConversionFactors` (e.g. `{type:".CalorieConversionFactor", proteinValue:3.36, fatValue:8.37, carbohydrateValue:3.6}`, `{type:".ProteinConversionFactor", value:6.25}`), `isHistoricalReference`, `scientificName`.
- SR Legacy: the same family (`foodClass:"FinalFood"`, `isHistoricalReference:true`).
- FNDDS: `foodClass:"Survey"`, `foodCode`, `startDate`, `endDate`, `wweiaFoodCategory{wweiaFoodCategoryCode, wweiaFoodCategoryDescription}`, `foodPortions`, `inputFoods` (the recipe ingredients, with `ingredientWeight`, `retentionFactor`, …).
- Branded: `brandOwner`, `brandName`, `brandedFoodCategory`, `gtinUpc`, `ingredients`, `servingSize`, `servingSizeUnit`, `householdServingFullText`, `labelNutrients`, `packageWeight`, `foodUpdateLog`, `marketCountry`, `discontinuedDate`, `foodPortions:[]`.
- Detail `foodNutrients[]`: `{type:"FoodNutrient", id, amount, dataPoints?, min?, max?, median?, nutrient:{id, number:"208", name, rank, unitName}, foodNutrientDerivation:{id?, code, description, foodNutrientSource:{id, code, description}}, nutrientAnalysisDetails?}`. Here `unitName` is **lowercase** (`kcal`, `g`, `mg`, **`µg`**, `IU`, `kJ`), the value key is `amount` (search uses `value`), and the ID is nested under `nutrient.id` (search uses a flat `nutrientId`). `[search](3p)`
- Abridged (`format=abridged`) per the spec: `foodNutrients[]` = `{number, name, amount, unitName, derivationCode, derivationDescription}`. I did not see a live abridged sample, so verify. `[sdk-source]`

**`foodPortions[]`** (detail). Schema fields: `id`, `amount`, `gramWeight`, `modifier`, `portionDescription`, `measureUnit{id,name,abbreviation}`, `sequenceNumber`, `dataPoints`, `minYearAcquired`. `[sdk-source]` Observed usage differs by type: `[search](3p)`
- SR Legacy: `{amount:1, modifier:"cup", gramWeight:202, measureUnit:{id:9999,name:"undetermined"}}`. The household unit text is in `modifier`, and grams = `amount`-unit × `gramWeight`.
- FNDDS: `{portionDescription:"1 fl oz (no ice)", modifier:"30001", gramWeight:31, measureUnit:{id:9999}}`. Here `modifier` is a numeric **portion code** and the text is in `portionDescription`.
- Foundation: often only `{amount:1, gramWeight:140, measureUnit:{id:1121, name:"RACC"}}`, i.e. the FDA Reference Amount Customarily Consumed.
- Branded: `foodPortions` is empty. Use `servingSize` + `servingSizeUnit` + `householdServingFullText`.

**Branded `labelNutrients`** (per **serving**, label-rounded). Keys: `fat`, `saturatedFat`, `transFat`, `cholesterol`, `sodium`, `carbohydrates`, `fiber`, `sugars`, `protein`, `calcium`, `iron`, `potassium`, `calories`, each `{value}`. The 1.0.0 spec misspells `postassium`; 1.0.1 and live data use `potassium`. It can be `{}`, and `servingSize` can be absent (seen in one record). `[sdk-source]` + `[search](3p)`

**Errors** (api.data.gov gateway, all agencies) `[primary]`:
- 403: `API_KEY_MISSING` | `API_KEY_INVALID` | `API_KEY_DISABLED` | `API_KEY_UNAUTHORIZED` | `API_KEY_UNVERIFIED`
- 400: `HTTPS_REQUIRED`
- 429: `OVER_RATE_LIMIT`
- 404: `NOT_FOUND`

The body is `{"error":{"code":"…","message":"…"}}` in JSON. The format follows the request, and errors can come back as XML, CSV or HTML. Branch on the HTTP status or `code`, never on the message. One third-party client reports that the rate-limit proxy sometimes returns **HTML with status 200**, and it guards with a `/^\s*<(!DOCTYPE\s+html|html[\s>])/i` check. `[search](3p)`

## 2. Auth and rate limits
- Get a free key at `https://api.data.gov/signup/` (also linked from `https://fdc.nal.usda.gov/api-key-signup/`). The key is a 40-character string sent by email. `[primary]` A key is required on every FDC request. `[search]`
- There are three ways to pass the key. `[primary]` (api.data.gov developer manual)
  - The `X-Api-Key: <key>` header.
  - The `api_key=` query parameter, which also works on POST.
  - HTTP Basic auth username.
  
  The FDC OpenAPI declares only `apiKey in: query name: api_key`. `[sdk-source]` Several FDC clients (2025–2026) send `X-Api-Key` successfully. `[search](3p)` One third-party catalog claims "no header support"; that conflicts with the other evidence and is probably wrong. **Recommendation:** use the header so the key stays out of URLs and logs, and smoke-test it once.
- Default limit:
  - api.data.gov says **1,000 requests/hour per key**, "applied across all api.data.gov API requests". In other words, one key shares its budget with any other api.data.gov service it is used for. The hourly counter is **rolling**. Exceeding it temporarily blocks the key, and the block lifts automatically after an hour. `[primary]`
  - The FDC API guide phrases it as "**1,000 requests per hour per IP address**… Exceeding this limit will cause the API key to be temporarily blocked for 1 hour". `[search]`
  - The per-key vs per-IP wording conflicts. On Vercel, where egress IPs are shared and variable, plan for **per key**.
- `DEMO_KEY`: **30 requests/IP/hour and 50 requests/IP/day**. Use it only for exploration. `[primary]`
- Usage headers on every response: `X-RateLimit-Limit` and `X-RateLimit-Remaining`. `[primary]` A 429 includes no reset timestamp per these docs. Honor `Retry-After` if present (one client does). `[search](3p)`
- Higher limits: api.data.gov says to contact the agency that runs the API. `[primary]` The FDC guide (third-party copy) says "Contact FoodData Central if higher request rates are needed". The FDC contact form is `https://nal.altarama.com/reft100.aspx?key=FoodData` (from the OpenAPI `info.contact`). `[sdk-source]` + `[search](3p)`
- Keys found in public code are deactivated by api.data.gov. `[search]` Many FDC keys are visible in public GitHub repos, so keep ours in env only.

## 3. Data types

| Data type | What it is | Size | Basis | Update cadence |
|---|---|---|---|---|
| **Foundation** | Raw or lightly processed commodity foods with extensive analytical metadata (samples, min/max/median, methods, acquisition dates) | 2026-04: 363 food objects in the JSON (plus 32 `null` slots) vs 469 `foundation_food` rows in the CSV. Of those 469, about 367 have complete energy/protein/fat/carb. **Counts conflict.** `[search](3p)` | per 100 g edible portion | April and October `[search]`. Latest v15.0, 2026-04-30 `[search]` |
| **SR Legacy** | Final release of the National Nutrient Database for Standard Reference. Includes food groups "Fast Foods" (2100), "Meals, Entrees, and Side Dishes" (2200), "Restaurant Foods" (3600), e.g. "SUBWAY, sweet onion chicken teriyaki sub…" | 7,793 foods `[search](3p)` | per 100 g | **Frozen** since April 2018 ("will not be updated") `[search]` |
| **Survey (FNDDS)** | Food and Nutrient Database for Dietary Studies, used to code NHANES/WWEIA intake. Foods "as eaten", **including mixed dishes**. WWEIA categories include poultry mixed dishes (3004), rice mixed dishes (3202), Asian, Mexican, pizza, sandwiches, soups. The 2021-2023 docs list 133 codes for poultry mixed dishes and 132 for rice mixed dishes. Derived from Foundation and SR Legacy plus recipes (`inputFoods`) | 2021-2023: ">5,400 foods", "~22,000 portion weights", 9,648 additional descriptions `[search]`. 5,432 in the JSON (one, "Milk, human" 2705383, has no nutrients) `[search](3p)` | per 100 g. **Energy plus 64 nutrients for every food, with no gaps** `[search]`. 65 nutrients seen on every FNDDS record `[search](3p)` | Every 2 years with NHANES cycles. Current 2021-2023, released 10/2024 (file 2024-10-31) `[search]` |
| **Branded** (Global Branded Food Products Database) | Label data from a public-private partnership (GS1, 1WorldSync, Label Insight…) for packaged and private-label foods | Branded CSV 2025-12-18: 1,993,975 rows but only 432,132 unique canonical GTINs, because the same UPC reappears under many `fdc_id`s over time `[search](3p)` | `foodNutrients` per **100 g or 100 ml** (whichever unit the provider supplied), calculated from per-serving label values. `labelNutrients` per serving `[search]` + `[search](3p)` | API and web **monthly** (log v15.1 May 21, 15.2 Jun 25, 15.3 Jul 23, 15.4 **Aug 20, 2026**). Download files April and October `[search]` |
| **Experimental** | Foods produced or studied under unique conditions (alternative management, experimental genotypes), often not commercially available. Published in peer-reviewed journals with USDA | not found | — | April/October as data become available `[search]`. Not a `dataType` value in the API spec `[sdk-source]`. **Irrelevant for us** |

Also hosted on FDC but out of scope: the FNS Child Nutrition Database (CN2026.09, 2026-09-24). `[search]`

**Which to use for our product.** This is my synthesis, not a USDA recommendation.
- **Meal photos of generic or home-cooked plates ("chicken and rice", "chicken teriyaki", "burrito bowl"): FNDDS first.** It has mixed and prepared dishes with oil and sauce built into the recipe, complete nutrient profiles, and household portions including "Quantity not specified". Use SR Legacy and Foundation for single ingredients when the model identifies components separately ("grilled chicken breast 150 g" + "white rice 200 g"). Prefer FNDDS or SR Legacy for cooked forms; Foundation is mostly raw.
- **Packaged or barcode items: Branded.** Match on `gtinUpc` or `brandOwner` + description. Use `labelNutrients` × servings, or `servingSize` grams × per-100 values.
- **Restaurant chains:** FDC coverage is thin and dated. SR Legacy "Restaurant Foods"/"Fast Foods" date from 2018 or earlier, and Branded is mostly retail packaged goods. Fall back to the closest FNDDS dish and ask about portion.
- Values for the "same" food differ across types. "Broccoli, raw" per 100 g is 39 kcal in FNDDS (2709643), 31 kcal in Foundation (747447) and 34 kcal in SR (170379). Foundation 747447 and SR 170379 also share NDB number 11090. `[search](3p)` So pick one priority order and stick to it so totals are reproducible.

## 4. Nutrient IDs and numbers
These come from FDC's `nutrient.csv` (columns id, name, unit_name, nutrient_nbr; copy of the 2025-04-24 release) and match a 2026 client's reference table and every captured record. `[search](3p)` The meanings of 2047 and 2048 are confirmed by the Foundation docs. `[search]`

| Nutrient | `id` (nutrientId / nutrient.id) | `number` (nutrientNumber; the `nutrients=` filter value) | unit | Carried by |
|---|---|---|---|---|
| Energy (kcal) | **1008** | 208 | KCAL | SR Legacy, FNDDS (the only energy row there), Branded. Some Foundation records |
| Energy (kJ) | **1062** | 268 | kJ | SR Legacy, some Foundation. **Never add it to kcal** |
| Energy (Atwater General Factors) | **2047** | 957 | KCAL | Foundation only (4/9/4 factors) |
| Energy (Atwater Specific Factors) | **2048** | 958 | KCAL | Foundation only (USDA Handbook 74 food-specific factors) |
| Protein | **1003** | 203 | G | all |
| Total lipid (fat) | **1004** | 204 | G | all |
| Carbohydrate, by difference | **1005** | 205 | G | all. For Foundation it is computed as 100 − (water + protein + fat + ash + alcohol) `[search]` |
| Carbohydrate, by summation | 1050 | 205.2 | G | Foundation (alternative; do not use as the main carb figure) |
| Fiber, total dietary | **1079** | 291 | G | all (often missing in Foundation) |
| Total dietary fiber (AOAC 2011.25) | 2033 | 293 | G | some Foundation |
| Total Sugars | **2000** | 269 | G | SR, FNDDS, Branded, Foundation (analytical) |
| Sugars, Total (summed) | 1063 | 269.3 | G | Foundation (derivation `AS` = summed). Use 2000 first, then 1063 |
| Sugars, added | 1235 | 539 | G | Branded (label) |
| Sodium, Na | **1093** | 307 | MG | all |
| Fatty acids, total saturated | **1258** | 606 | G | all (often missing in Foundation) |
| Water | 1051 | 255 | G | for sanity checks |

**Energy semantics:**
- Since October 2020, 1008 "Energy" is **no longer displayed for Foundation Foods** but continues for the other types. Foundation energy is published as 2047 and/or 2048. Profiles with 2048 usually also include 2047. The FNDDS documentation uses Foundation's 2047 as its energy (listed as "1008/2047"). `[search]`
- Real data is messier. Captured Foundation records published 2019-12-16 (eggs, broccoli) still return **1008 + 1062** in search, while records published 2020-10-30 (apples) have only 2047 + 2048. `[search](3p)`
- Two third-party scans of the 2026-04 Foundation release:
  - JSON: of 363 foods, 226 have 2047, 199 have 2048 and 95 still carry 1008. `[search](3p)`
  - CSV: of 367 complete foods, energy came from 2048 in 304, from 2047 in 32 and from 1008 alone in 31. `[search](3p)`
- Some Foundation foods have **no energy row at all**. Energy is only calculated when protein and fat values exist. `[search]`
- 2047 and 2048 can differ by about 10%. Apples, red delicious (1750339): 61.8 kcal general vs 55.6 kcal specific per 100 g. `[search](3p)`

**Basis:**
- Foundation, SR Legacy and FNDDS values are per **100 g edible portion**. `[search]`
- Branded `foodNutrients` are per **100 g, or per 100 ml when the label serving was in ml** (e.g. MCT oil, serving 15 ml, label 130 kcal → `1008` = 867 per 100 ml). Branded `labelNutrients` are per **serving** as printed. `[search]` + `[search](3p)`
- Derivation codes worth checking on Branded rows: `[search](3p)`
  - `LCCS` "Calculated from value per serving size measure"
  - `LCCD` "Calculated from a daily value percentage per serving size measure"
  - **`LCSL` "Calculated from a less than value per serving size measure"**. A label "<1 g" becomes 1 g, so for a 1 g serving it becomes 100 g/100 g.
- Other codes seen: `A` analytical, `NC` calculated, `AS` summed, `Z` assumed zero, `JA`/`JO` aggregated.

## 5. Licensing and attribution
- API guide, "Licensing": "USDA FoodData Central data are in the public domain and they are not copyrighted. They are published under CC0 1.0 Universal (CC0 1.0). No permission is needed for their use, but we request that users list FoodData Central as the source of the data, and when possible, notify us of the product that uses the data…" `[search]` (WebSearch summary of the API guide). The exact wording is quoted identically by several 2026 third-party notices. `[search](3p)` The OpenAPI `info.license` is "Creative Commons 0 1.0 Universal". `[sdk-source]`
- Suggested citation:
  - API guide: "U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov." `[search]`
  - Homepage variant: "U.S. Department of Agriculture, Agricultural Research Service, Beltsville Human Nutrition Research Center. FoodData Central. [Internet]. [cited YYYY-MM-DD]. Available from https://fdc.nal.usda.gov/." `[search](3p)`
  - Dataset-specific citations carry a version, e.g. "FoodData Central: Foundation Foods. Version Current: April 2024". `[search]`
- No branded-specific restriction was found on the FAQ, download or documentation pages (third-party audit, 2026-10-24). `[search](3p)` Bundling FDC data in our database is fine.
- One caveat: the Child Nutrition Database docs say FDC IDs are "intended for internal use only and should not be displayed to software users". `[search]` We would never show them in texts anyway.

## 6. Bulk downloads
Index page: `https://fdc.nal.usda.gov/download-datasets/`. The URL pattern is `https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_<type>_<csv|json>_<date>.zip`. Sizes below are from a third-party registry dated 2026-10-04, with the Foundation JSON byte count independently matching a third-party SHA-256-pinned download. `[search](3p)` The release dates also match WebSearch summaries of the download page. `[search]`

| File | Release | Zipped bytes | Unzipped (3p) |
|---|---|---|---|
| `FoodData_Central_csv_2026-04-30.zip` (all types) | 2026-04-30 | 481,517,495 | multi-GB |
| `FoodData_Central_foundation_food_json_2026-04-30.zip` | 2026-04-30 | 469,303 (SHA-256 `186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a`, 3p) | 6,721,650 B JSON |
| `FoodData_Central_foundation_food_csv_2026-04-30.zip` | 2026-04-30 | 3,825,741 | ~32 MB |
| `FoodData_Central_branded_food_json_2026-04-30.zip` | 2026-04-30 | 204,270,542 | — |
| `FoodData_Central_branded_food_csv_2026-04-30.zip` | 2026-04-30 | 448,767,220 | ~2.9 GB |
| `FoodData_Central_survey_food_json_2024-10-31.zip` (FNDDS 2021-2023) | 2024-10-31 | 3,835,292 | — |
| `FoodData_Central_survey_food_csv_2024-10-31.zip` | 2024-10-31 | 3,325,692 | — |
| `FoodData_Central_sr_legacy_food_json_2018-04.zip` | 2018-04 (final) | 13,456,312 | ~210 MB |
| `FoodData_Central_sr_legacy_food_csv_2018-04.zip` | 2018-04 (final) | 6,074,592 | ~54 MB |

- CSV packages are relational: `food.csv`, `food_nutrient.csv`, `nutrient.csv`, `food_portion.csv`, `measure_unit.csv`, `food_category.csv`, `sr_legacy_food.csv` (NDB↔fdc_id), `foundation_food.csv`, `branded_food.csv`, plus internal sample and sub-sample rows to exclude. `[search](3p)`
  - SR Legacy `food_portion.csv`: 14,449 rows covering 7,533 of 7,793 foods (`amount`, `modifier`, `gram_weight`).
  - Foundation: 10,951 portion rows. `[search](3p)`
- **Conflicts and unknowns:**
  - One third-party note says the FNDDS CSV is "200 M / 1.6 G". That is inconsistent with the 481 MB all-types zip containing a 449 MB Branded part, so I believe the 3.3 MB figure.
  - One third-party note (2026-09-26) treated Branded 2025-12-18 as current. The registry and the download-page summaries list 2026-04-30.
  - The **2026-04 Foundation JSON contains 32 `null` array entries** (third-party importers crashed on it). Handle it, or prefer the CSV.
  - The FDC homepage mentions "October 2026" new data, but no October 2026 download or log entry was confirmed as of today. **Re-check the download page and `https://fdc.nal.usda.gov/log/` before seeding.** `[search]`
- **FDC IDs are versioned.** "Each time the data in a food record changes, that food item receives a new FDC_ID", assigned randomly. NDB number (Foundation/SR), FNDDS food code and GTIN stay stable. `[search]` A new FNDDS cycle therefore brings all-new fdcIds (2021-2023 FNDDS IDs are in the ~2705xxx–2710xxx range `[search](3p)`).

## 7. Known pitfalls
1. **Branded floods search.** "apple" gives 25,775 hits: 25,638 Branded vs 6 Foundation, 89 SR, 42 FNDDS. The top results are Branded "APPLE" SKUs. `[search](3p)` Always pass `dataType` (`["Survey (FNDDS)","SR Legacy","Foundation"]` for generic foods) and use POST JSON, which avoids URL-encoding `Survey (FNDDS)`.
2. **Relevance is keyword (Lucene) scoring, not semantic.** "apple" ranks "Apple, candied" and "Crisp, apple" alongside "Apple, raw". `[search](3p)` Plain multi-word queries OR the terms unless you use `+` / `requireAllWords` / quotes. `[search]` Show the model the top N candidates (description + dataType + fdcId) and let it choose; do not blindly take hit #1.
3. **Lucene syntax 400s** on unbalanced quotes, brackets or parentheses and on stray `/` in user text (e.g. "w/o salt", `1/8"`). Escape them. `[search](3p)` + `[search]`
4. **Duplicates.**
   - Across types: same food in Foundation, SR and FNDDS with different values, and shared NDB numbers.
   - Within Branded: about 4.6 rows per unique UPC because of version history. `[search](3p)`
   - Dedupe Branded by GTIN and keep the newest `publishedDate`/`modifiedDate`.
5. **Energy may be absent from the field you expect.** Foundation can have 2047 and/or 2048 and/or 1008, or none. Use a deterministic fallback chain (see Implications). `[search]` + `[search](3p)`
6. **kJ vs kcal.** Rows 1062 (kJ) and 1008 (kcal) are both named "Energy". Always select by `nutrientId` and check `unitName`, never by name. `[search](3p)`
7. **Inconsistent casing, types and date formats.** `[search](3p)`
   - Search returns `KCAL`/`G`/`MG`/`UG`; detail returns `kcal`/`g`/`mg`/`µg`.
   - `nutrientNumber` is a string; `ndbNumber` is a number in search but a string in the spec.
   - Search uses `publishedDate` ISO; detail uses `publicationDate` `M/D/YYYY`.
   - Value key: `value` in search, `amount` in detail.
   - Zod schemas should coerce and normalize, with `.passthrough()`.
8. **Missing ≠ zero.** Foundation is incomplete by design: fiber, sugars and saturated fat are often absent. The FDC website's own aggregations treat missing values as zero. `[search]` Our sums must track coverage instead.
9. **Branded math traps.** `[search]` + `[search](3p)`
   - Per-100 ml vs per-100 g (check `servingSizeUnit`; `GRM` also appears).
   - Label rounding: a label zero stays zero per 100 g.
   - `LCSL` "<1 g" inflation. Example: matcha 2373333 reads 100 g protein + 100 g carbs + 100 g fiber per 100 g.
   - `labelNutrients` can be empty and `servingSize` can be missing.
   - Sanity-check that protein + fat + carb ≤ ~105 g per 100 g and kcal ≤ ~900 per 100 g, and reject anything outside.
10. **Portions are type-specific.** SR uses `modifier`="cup"; FNDDS uses `portionDescription`="1 cup" with a numeric `modifier` code; Foundation is often only an RACC portion. The docs say portions and weights are unique to each data type and should not be mixed across types. `[search]` + `[search](3p)`
11. **Spec drift.** The published OpenAPI files (1.0.0, 1.0.1) do not match live search responses: array vs object, `number`/`amount` vs `nutrientNumber`/`value`, `foodCategory` object vs string. Code against recorded real responses (fixtures), not the spec. `[sdk-source]` vs `[search](3p)`
12. **HTML instead of JSON** under rate-limiting or gateway errors (third-party report). Check the `content-type` and the body before `JSON.parse`. `[search](3p)`
13. **ID churn.** Any update creates a new fdcId. `[search]` A meal log that stores only an fdcId may later point at a superseded record. `/food/{id}` for old IDs probably still resolves, but I did not verify that.

---

## Implications for our design
These are recommendations for DECISIONS.md, not facts.
- **Local-first FDC table.** At deploy or seed time, import FNDDS 2021-2023 (≈5.4k), SR Legacy (7,793) and Foundation 2026-04 (via the **CSV**, because the JSON has null slots). That is about 13.6k foods.
  - Tables: `fdc_food(fdc_id PK, data_type, description, food_code, ndb_number, category, published_at, release)`, `fdc_food_nutrient(fdc_id, nutrient_id, amount, unit, derivation_code)` or denormalized macro columns, and `fdc_portion(fdc_id, label, gram_weight, seq)`.
  - Keep only about 15 nutrients. That is a few MB in Postgres.
  - Add Postgres full-text and trigram search over `description` + `additionalDescriptions`.
  - Call the live API only for (a) Branded/packaged items (search with `dataType:["Branded"]`, GTIN when visible) and (b) local misses. This keeps us far below 1,000 requests/hour and makes evals deterministic and offline.
- **Model picks, code computes.** The `log_meal` tool takes the model's food description, grams and confidence. Code runs the local (then API) search and returns the top ~5 candidates `{fdcId, dataType, description, kcal/100g}` to the model to choose from, or code picks with a priority rule. Code then computes `per100 × grams / 100`.
  - Priority for generic foods: FNDDS > SR Legacy > Foundation.
  - FNDDS mixed dishes already include typical oil and sauce, which reduces the need for clarifying questions. When the model logs a dish as one item, do not also add the oil separately.
- **Energy resolution (deterministic, record which was used):**
  1. `1008`
  2. `2047`
  3. `2048`
  4. `1062 ÷ 4.184`
  5. Atwater 4/9/4 from 1003/1004/1005, flagged `derived`
  
  Rationale: FNDDS (our main source) uses 1008 throughout and maps Foundation energy to 2047, so this keeps sources consistent. Log the decision. The alternative, preferring 2048 for Foundation, is defensible but up to about 10% lower.
- **Snapshot on log.** Store `fdc_id`, `data_type`, `description`, `release`, the per-100 g values used, and grams on every logged item. Never recompute history from live FDC, because IDs and values change.
- **Caching.**
  - Cache `fdcId → normalized record` indefinitely. An fdcId's content is effectively immutable, since updates mint new IDs.
  - Cache `normalized query + dataType filter → candidate IDs` for about 30 days, because Branded changes monthly.
  - Postgres works as the cache, so no Redis is needed.
- **HTTP client.**
  - POST `/v1/foods/search` with a JSON body and `X-Api-Key` from env `FDC_API_KEY`.
  - Timeout around 10 s.
  - Retry 429 and 5xx with backoff and `Retry-After`, while respecting the turn's time budget.
  - Read `X-RateLimit-Remaining` and alert when it falls below about 100.
  - Detect HTML bodies.
  - Escape Lucene special characters.
  - Zod-validate with normalization: lower-case units, map `UG`→`µg`, coerce numbers.
  - Use `DEMO_KEY` only in local dev or tests. Add `FDC_API_KEY` to `.env.example`.
- **Portions.** Use FNDDS `foodMeasures`/`foodPortions` (including "Quantity not specified") and SR `foodPortions` as **grounding hints** for the model's gram estimates (e.g. "1 cup cooked white rice = X g"). Expose them in the tool result rather than letting the model guess cup weights.
- **Branded.** Use `labelNutrients × servings` when the user says "1 bar" or "1 can". Otherwise use `servingSize` with a g or ml conversion. Run the sanity bounds and flag `LCSL`-derived values. For ml-based products, grams ≈ ml only for water-like drinks; ask or assume density 1 and log it.
- **Attribution.** Add "Nutrition data: USDA FoodData Central (fdc.nal.usda.gov)" to HELP text, the README and the website footer. This is not required but is requested and costs nothing.
- **Tests and evals.** Commit a handful of recorded FDC responses (search FNDDS, search Branded, detail Foundation with only 2047/2048, SR with kJ, Branded with ml and with `LCSL`) as Vitest fixtures for the normalizer and the energy chain.

## Open questions for the product owner
1. **Who registers the api.data.gov key?** The key is tied to a name and email at signup and is emailed to that address. I need you (or a company email) to sign up at https://api.data.gov/signup/ and put it in Vercel env as `FDC_API_KEY`. Until then, dev uses `DEMO_KEY` (30 requests/hour).
2. **How accurate must chain-restaurant meals be in the MVP?** FDC has little current chain-specific data: SR Legacy restaurant items date from 2018 or earlier, and Branded is mostly retail packaged goods. The default is the closest generic FNDDS dish plus a portion question. If chain-exact numbers ("Chipotle chicken bowl") are a launch requirement, we would need a separate, probably licensed, restaurant nutrition source, which has cost and licensing implications.

## Risks
- **Wrong-match risk.** Keyword search can return a plausible but wrong record (wrong preparation, raw vs cooked, a Branded SKU). Macros are then precisely wrong. Mitigate with dataType filters, model-side candidate selection, cooked-form preference and the sanity bounds.
- **Federal service availability.** There is no SLA. api.data.gov or FDC outages, maintenance or a funding lapse would break live lookups. The local seed mitigates this for generic foods; Branded lookups would degrade.
- **Shared, rolling rate limit.** 1,000 requests/hour per key is shared across all api.data.gov services that key touches, and a block lasts about an hour. A burst (eval runs, a backfill) could lock out production. Use separate keys for eval/dev and prod.
- **Undocumented behavior we may lean on.** `requireAllWords`, the `foodCategory` filter, the `X-Api-Key` header on FDC specifically, and 1-based `pageNumber` are all unofficial or inferred. Smoke-test each one and keep fallbacks.
- **Data-quality variance.** Branded label rounding and `LCSL` inflation, Foundation gaps (missing energy, fiber, sugars), and roughly 10–25% differences for the same food across data types. Totals are estimates. Our replies should not imply lab precision.
- **Release churn.** A new FNDDS cycle or a Foundation release mints new fdcIds and can change values. Seeded tables need a `release` column and a re-seed procedure. An October 2026 release may be appearing right now, which is unconfirmed.
- **Bulk file quirks.** The 2026-04 Foundation JSON has null entries, counts differ between the JSON and CSV packages, and the published OpenAPI disagrees with live responses. Build the importer and parser defensively and test against real files.
- **This note's own sourcing.** fdc.nal.usda.gov, api.nal.usda.gov and SwaggerHub were unreachable from this container. FDC-site facts come from WebSearch summaries, the official OpenAPI file (via GitHub mirrors), and third-party captured responses and analyses. Before coding, run one live `foods/search` and one `food/{id}` call per data type with our key and diff them against this note.

## Sources
- https://fdc.nal.usda.gov/api-guide/ (via WebSearch; blocked for direct fetch)
- https://fdc.nal.usda.gov/api-spec/fdc_api.html (via WebSearch)
- https://fdc.nal.usda.gov/api-key-signup/
- https://fdc.nal.usda.gov/download-datasets/ (via WebSearch)
- https://fdc.nal.usda.gov/log/ (via WebSearch)
- https://fdc.nal.usda.gov/faq/ (via WebSearch)
- https://fdc.nal.usda.gov/help/ (via WebSearch)
- https://fdc.nal.usda.gov/data-documentation/ (via WebSearch)
- https://fdc.nal.usda.gov/Foundation_Foods_Documentation/ and https://fdc.nal.usda.gov/docs/Foundation_Foods_Documentation_Apr2024.pdf (via WebSearch)
- https://fdc.nal.usda.gov/GBFPD_Documentation/ , https://fdc.nal.usda.gov/docs/GBFPD_Documentation_and_Download_User_Guide_Apr2023.pdf , https://fdc.nal.usda.gov/docs/Branded_Foods_Documentation_Apr2024.pdf (via WebSearch)
- https://fdc.nal.usda.gov/Experimental_Foods_Documentation/ (via WebSearch)
- https://fdc.nal.usda.gov/docs/CNDB_Documentation_June_2026.pdf (via WebSearch)
- https://www.ars.usda.gov/ARSUserFiles/80400530/pdf/fndds/2021_2023_FNDDS_Doc.pdf (via WebSearch)
- https://www.ars.usda.gov/ARSUserFiles/80400530/pdf/2123/Food_Categories_August%202021-August%202023.pdf (via WebSearch)
- https://api.data.gov/docs/developer-manual/ , read as source at https://raw.githubusercontent.com/GSA/api.data.gov/HEAD/content/docs/developer-manual/index.md [primary]
- https://api.data.gov/signup/
- FDC OpenAPI 1.0.0 (official, mirrored; 4 identical copies): https://raw.githubusercontent.com/gokhanmeteerturk/per-my-last-meal/HEAD/docs/fdc_api.yaml , https://raw.githubusercontent.com/dereksleung/calibrate-monorepo/HEAD/references/fdc_api.yaml
- FDC OpenAPI 1.0.1 (SwaggerHub fdcnal export, mirrored): https://raw.githubusercontent.com/joram/fda-nutrience/HEAD/fdcnal-food-data_central_api-1.0.1-resolved.yaml ; SwaggerHub: https://app.swaggerhub.com/apis/fdcnal/food-data_central_api/1.0.1
- Third-party captured live responses: https://raw.githubusercontent.com/gcasaldi/MediTwin_Lab/HEAD/data/ingestion/20261019T043307Z/usda_raw.json , https://raw.githubusercontent.com/delanoismynameo/Calbud/HEAD/src/food/__fixtures__/usda-search-egg.json , https://raw.githubusercontent.com/nneuwald/traffic-light-food-logger/HEAD/fixtures/fdc_search.json , https://raw.githubusercontent.com/albertzhzhou-droid/ParkinSUM/HEAD/test/fixtures/importers/usda_fdc_foundation_1750339_2026_04.json , https://raw.githubusercontent.com/radicle-co/KitchenSink/HEAD/packages/services/food-service/tests/e2e/__fixtures__/usda/food1750340Foundation.json , https://raw.githubusercontent.com/kiarashfa/eXir/HEAD/src/data/composition-sources/usda-2709176.json , https://raw.githubusercontent.com/kiarashfa/eXir/HEAD/src/data/composition-sources/usda-170674.json , https://raw.githubusercontent.com/kiarashfa/eXir/HEAD/src/data/composition-sources/usda-2373333.json , https://raw.githubusercontent.com/The-BRAIN-Diet/food-science/HEAD/scripts/data/fdc-candidates/2426574.json , https://raw.githubusercontent.com/blopa/musclog-app/HEAD/data/examples/api-samples/usda-food-2575290.json
- FDC nutrient.csv copy (2025-04-24): https://raw.githubusercontent.com/albertzhzhou-droid/ParkinSUM/HEAD/tool/data/fdc_2025-04-24/nutrient.csv ; food_category.csv copy: https://raw.githubusercontent.com/mrdbourke/nutrify/HEAD/data_exploration/data/FoodData_Central_Supporting_Data_csv_2021-04-28/food_category.csv
- Third-party client source: npm `@cyanheads/usda-mcp-server@0.2.0` (dist/services/fdc/fdc-service.js, nutrient-reference.js, skills/usda-guide/SKILL.md), https://www.npmjs.com/package/@cyanheads/usda-mcp-server ; https://raw.githubusercontent.com/JamesCliffordSpratt/macros/HEAD/src/core/usda.ts
- Third-party release and size notes: https://raw.githubusercontent.com/Knowledge-Graph-Hub/kg-registry/HEAD/resource/fooddata-central/fooddata-central.md , https://raw.githubusercontent.com/norish-recipes/norish/HEAD/.scratch/ingredient-nutrition/research.md , https://raw.githubusercontent.com/Cclicking/lightmemo/HEAD/docs/nutrition-databases.md , https://raw.githubusercontent.com/albertzhzhou-droid/ParkinSUM/HEAD/docs/FDC_ENERGY_METHOD_AND_FACTOR_RESEARCH_2026-10-01.md , https://raw.githubusercontent.com/Aurikology/shin/HEAD/docs/usda-branded-foods-measured-2026-09-26.md , https://raw.githubusercontent.com/ifsvivek/Sugar-Tracker/HEAD/usda..md (copy of API guide)
- Licensing quotes (3p): https://github.com/Its-The-Company/its-the-company.github.io/blob/HEAD/documents/hunt/h201.md , https://github.com/macdarenz-droid/Diet/blob/HEAD/docs/FOOD-DATA.md
