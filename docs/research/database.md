# Postgres + Drizzle on Vercel (Neon or Supabase), plus local dev and tests without a cloud account

Retrieved: 2026-10-29

**TL;DR.** Pin `drizzle-orm@0.45.4` and `drizzle-kit@0.31.11`. These are the npm `latest` tags. `1.0.0-rc.5` sits on the `rc` tag, and the docs site now defaults to v1-RC syntax (`migrate(db)` with no config, a migrations folder with no journal, `drizzle-orm@rc` installs). Read every docs snippet against the 0.45 `.d.ts`.

**Production driver.** Use **`drizzle-orm/node-postgres` with a module-scope `pg.Pool` registered with `attachDatabasePool()` from `@vercel/functions`**, pointed at Neon's pooled `DATABASE_URL` (the `-pooler` host, PgBouncer in transaction mode).
- This is Neon's current recommendation for Vercel Fluid (doc updated 2026-06-05).
- `attachDatabasePool` only hooks pools that expose `.on('release')` and `options.idleTimeoutMillis`. `pg.Pool` has both; postgres.js does not.
- Supabase warns that postgres.js's default pipelining can hang queries or return mismatched rows behind a transaction-mode pooler.
- `neon-http` cannot run interactive transactions: `db.transaction()` throws. It can only do atomic `db.batch([...])`.

**Local dev and tests.** Keep that single code path for local dev against any real Postgres. That can be a local server, or the zero-install **`pglite-server`** from `@electric-sql/pglite-socket`, which speaks the wire protocol.
- Unit tests use **`drizzle-orm/pglite`** in-process.
- PGlite 0.5.13 is **PostgreSQL 18.6**, the same as Neon's default for new projects, and it bundles `pg_trgm` as a contrib import.
- Booting PGlite and migrating took **2–4 s** fresh, or **0.4–1 s** from a `dumpDataDir()` snapshot. Resetting between tests with `TRUNCATE` took **8 ms**.
- PGlite is single-connection, so concurrency tests must run against a real server.

**Concurrency.** For "never two turns per user at once", use a **per-user lease row**: `UPDATE … SET lease_owner, lease_expires_at = now()+ttl WHERE user_id=$1 AND (lease_expires_at IS NULL OR lease_expires_at < now()) RETURNING …`. Pair it with webhook dedupe via **`UNIQUE(provider, provider_message_id)` + `INSERT … ON CONFLICT DO NOTHING RETURNING id`**. Use `FOR UPDATE SKIP LOCKED` only for a sweeper that recovers crashed turns. Both patterns are single statements, so they work through PgBouncer transaction mode, neon-http and PGlite. Session advisory locks are unsafe through transaction poolers; Neon and Supabase both list them as unsupported.

**Data handling.**
- Store instants as `timestamptz`.
- Compute the user's local date in app code and store it as a `date` column on log rows.
- Use `now() AT TIME ZONE users.timezone` only in SQL selectors such as the cron query.
- `DELETE` is one `DELETE FROM users WHERE id=$1` with `ON DELETE CASCADE` on every child FK (verified). Blobs and PITR history need separate handling.

**drizzle-kit workflow.** Use `generate` plus a programmatic `migrate()` over the **unpooled** URL. Beware: the 0.45 migrator applies only migrations whose journal timestamp is newer than the last applied one, so older-timestamped branch migrations are **silently skipped** (reproduced locally). It also takes no lock.

Tag legend: **[primary]** = read the official docs source myself. That means raw Markdown/MDX from the official docs repos (`neondatabase/website`, `supabase/supabase`, `drizzle-team/drizzle-orm-docs` at commit `75cad5e` 2026-10-23, `electric-sql/pglite`, `postgres/postgres` `REL_18_STABLE` SGML), or the Vercel docs via the Vercel docs MCP. **[sdk-source]** = read in the npm tarball (`npm pack` into `/tmp/research-database/`). **[sdk-source+run]** = also run locally in this container against PostgreSQL 16.15 (`/usr/lib/postgresql/16`, port 5499) and PGlite 0.5.13; the scratch scripts are in `/tmp/research-database/exp/src/exp*.ts`. **[search]** = WebSearch summary only; **re-verify before coding**. neon.com, supabase.com, orm.drizzle.team, pglite.dev and postgresql.org were not reachable directly (DNS). I read their sources on raw.githubusercontent.com / github.com instead.

---

## 0. Conflicts, staleness and surprises

| Topic | Finding | Resolution |
|---|---|---|
| Drizzle docs are v1-RC first | The `drizzle-orm-docs` sidebar opens with "Upgrade to v1.0 RC". Snippets install `drizzle-orm@rc`/`drizzle-kit@rc`, show a migrations folder of per-migration directories (`20242409125510_name/migration.sql` + `snapshot.json`, no `journal.json`), and call `migrate(db)` with no config [primary: `src/content/docs/pg/migrations.mdx`, `pg/v0-v1-changes.mdx`]. npm `latest` is still `drizzle-orm@0.45.4` (2026-10-08) and `drizzle-kit@0.31.11`. `1.0.0-rc.5` is on tag `rc` (2026-10-21) [sdk-source: `npm view`]. | Use 0.45/0.31. In 0.45, `migrate(db, { migrationsFolder })` is **required** and reads `meta/_journal.json` + `<tag>.sql` [sdk-source: `migrator.js`]. Treat v1-only items as unavailable: `defineRelations`, the `snakeCase.table` casing API, `drizzle-orm/zod`, `push --explain`, the commutativity `check`. |
| Neon driver advice vs Drizzle tutorials | Neon: "With Vercel Fluid, we recommend you use a standard Postgres TCP connection (for example, with the node-postgres package) and a connection pool". Its example uses `drizzle-orm/node-postgres` + `attachDatabasePool` [primary: neon `guides/vercel-connection-methods.md`, updatedOn 2026-06-05]. Neon's decision table lists Vercel (Fluid) → `pg` [primary: `connect/choose-connection.md`, 2026-09-14]. Drizzle's Next.js+Neon tutorials still use `drizzle-orm/neon-http` [primary: `tutorials/drizzle-nextjs-neon.mdx` L77]. | Follow Neon (newer, and specific to Fluid). |
| postgres.js behind transaction poolers | Supabase: "`postgres.js` pipelines queries by default. Combined with the shared pooler transaction mode, this can hang queries or return mismatched rows… `max_pipeline: 0` breaks `sql.begin()` transactions instead" (upstream issue porsager/postgres#1189) [primary: supabase `guides/database/postgres-js.mdx`]. node-postgres `pg@8.23.1` has an opt-in `pipeline` client option, `Boolean(c.pipeline)`, so the default is off [sdk-source: `pg/lib/client.js` L101]. | Prefer `pg` over postgres.js for production. |
| `attachDatabasePool` vs postgres.js | `attachDatabasePool(dbPool)` registers listeners only when the pool has `.on` plus `options.idleTimeoutMillis` (pg), `config.connectionConfig`/`config.idleTimeout` (mysql), `options.maxIdleTimeMS` (mongo) or `options.socket` (ioredis) [sdk-source: `@vercel/functions@3.10.4` `db-connections/index.js` L94-147]. A postgres.js `sql` object has `typeof sql.on === 'undefined'` [sdk-source+run]. The `.d.ts` still marks the function `@experimental`. | With postgres.js the call would silently do nothing. One more reason for `pg`. |
| PGlite is Postgres 18 | `select version()` → `PostgreSQL 18.6 (PGlite 0.5.13) on wasm32-unknown-emscripten … 32-bit` [sdk-source+run]. Changelog: 0.5.0 moved to PG 18.3, 0.5.9 to 18.6 [primary: pglite `packages/pglite/CHANGELOG.md`]. The README badge still says "status-alpha". | Create the Neon project on **PG 18**, the Neon default since 2026-06-05 [primary: neon `changelog/2026-06-05.md`]. Avoid PG-18-only SQL such as `uuidv7()` while anyone develops on PG 16 (the local binary here is 16.15). |
| PGlite node-postgres adapter | `createPgConfig()` (`@electric-sql/pglite/node-postgres`) is new in 0.5.13, released 2026-10-28 [primary: CHANGELOG]. Locally, simple queries and a `db.transaction` worked on a fresh instance. **Drizzle's `node-postgres` migrator hung (>15 s)** over it, and sharing one PGlite instance between this adapter and `drizzle-orm/pglite` also hung [sdk-source+run]. | Don't rely on it yet. Use `drizzle-orm/pglite` in-process, or `pglite-server` over TCP. |
| Drizzle docs ship a typo | The Neon page installs `drizzle-orm@rc postres` (sic) for postgres.js [primary: `pg/connect-neon.mdx`]. | Ignore. |

---

## 1. Packages and versions (all verified with `npm view` / `npm pack`)

- `drizzle-orm@0.45.4`: peer deps include `pg >=8`, `@types/pg *`, `postgres >=3`, `@neondatabase/serverless >=0.10.0`, `@electric-sql/pglite >=0.2.0`, all optional [sdk-source: package.json].
- `drizzle-kit@0.31.11`: bin `drizzle-kit`; deps `esbuild ^0.25.4`, `tsx ^4.21.0`, `@drizzle-team/brocli` [sdk-source].
- `pg@8.23.1` (2026-09-30, engines node >= 16); `@types/pg@8.23.1` [sdk-source: npm view].
- `@neondatabase/serverless@1.2.0` (2026-10-01), engines `node >=19.0.0` [sdk-source].
- `postgres@3.4.9` (`latest`; `beta` = `3.0.0-rc.3`) [sdk-source].
- `@electric-sql/pglite@0.5.13` (2026-10-28). No runtime deps. Exports `.`, `./contrib/*`, `./node-postgres`, `./nodefs`, `./worker`, `./live`, `./template`, … [sdk-source].
- `@electric-sql/pglite-socket@0.2.16` (2026-10-28), bin `pglite-server`, peer `@electric-sql/pglite: 0.5.13` [sdk-source].
- `@vercel/functions@3.10.4` (2026-10-29) [sdk-source].
- `drizzle-zod@0.8.3`: peer `zod ^3.25.0 || ^4.0.0`, `drizzle-orm >=0.36.0` (zod `latest` = 4.6.7) [sdk-source: npm view].

---

## 2. Driver choices

### 2.1 Neon

| Drizzle import | Transport | Interactive `db.transaction()` | Batch | Notes |
|---|---|---|---|---|
| `drizzle-orm/neon-http` | HTTPS `fetch`. One query per request; endpoint default `https://<host>/sql` [sdk-source: neon `CONFIG.md` `fetchEndpoint`] | **No.** `NeonHttpSession.transaction()` does `throw new Error("No transactions support in neon-http driver")`, and so does the nested tx [sdk-source: `neon-http/session.js` L151-158] | **Yes.** `db.batch([q1, q2, …])` calls `client.transaction(builtQueries)`: a single HTTP request, one non-interactive, atomic transaction [sdk-source: `neon-http/session.js` L117-133; primary: `pg/batch-api.mdx`]. Allowed builders: `select/insert/update/delete/query.*.findMany/findFirst` | Lowest setup cost (~3 round trips) [primary: neon vercel guide]. Its `migrate()` is **not transactional**: "if any part of a migration fails, no rollback will be executed" [sdk-source: `neon-http/migrator.d.ts`]. `$withAuth(token)` for RLS JWTs [sdk-source]. Options: `fetchOptions` (e.g. `AbortController` timeout), `arrayMode`, `fullResults`, `authToken`, and transaction `isolationMode`/`readOnly`/`deferrable` [sdk-source: CONFIG.md]. Since 1.0.0 `sql()` must be called as a tagged template; use `sql.query(text, params)` or `sql.unsafe()` instead [sdk-source: CHANGELOG]. |
| `drizzle-orm/neon-serverless` | WebSocket `Pool`/`Client` (a pg-compatible API) | Yes. `pool.connect()` gives a dedicated client: `begin`/`commit`/`rollback`, savepoints for nested txs [sdk-source: `neon-serverless/session.js` L178-211] | — | Node ≤ 21 needs `neonConfig.webSocketConstructor = ws` (or drizzle `{ connection, ws }`). Node 22 has a global `WebSocket`. Neon: "In serverless environments such as Vercel Edge Functions or Cloudflare Workers, WebSocket connections can't outlive a single request… Pool or Client objects must be connected, used and closed within a single request handler" [sdk-source: README]. I found no Neon statement on module-scope WebSocket pools under Fluid **(unverified)**. |
| `drizzle-orm/node-postgres` + `pg.Pool` | TCP | Yes. On a Pool it does `await this.client.connect()`, then `begin…commit/rollback`, then `release()` [sdk-source: `node-postgres/session.js` L180-195] | — | **Recommended on Vercel Fluid** [primary: neon vercel guide + choose-connection]. Drizzle passes a statement `name` only when you call `.prepare('name')`, so ordinary queries are unnamed and safe behind PgBouncer transaction mode [sdk-source: `node-postgres/session.js` `prepareQuery`]. |
| `drizzle-orm/postgres-js` | TCP | Yes, via `client.begin()`; nested txs via `savepoint()` [sdk-source: `postgres-js/session.js` L116-150] | — | Drizzle passes `prepare: name !== undefined` on each `client.unsafe()` call, so drizzle queries are unprepared unless named [sdk-source: L94-107, L33-47]. Pool defaults: `max: 10`, `idle_timeout: 0`, `prepare: true`, `connect_timeout: 30`, `max_lifetime` random 30–60 min [sdk-source: postgres README]. Has the pipelining risk above, and `attachDatabasePool` doesn't work with it. |

**Neon pooler facts** [primary: neon `connect/connection-pooling.md`, updatedOn 2026-10-19]
- PgBouncer runs with `pool_mode=transaction`, `max_client_conn=10000`, `default_pool_size=0.9 × max_connections` (per user+database pair), `max_prepared_statements=1000`, `query_wait_timeout=120`. These are not user-configurable.
- `max_connections` by compute size: 0.25 CU → 104 (7 reserved, so 97 usable), 0.5 → 209, 1 → 419, 2 → 839 … capped at 4000.
- Pooled host = endpoint ID + `-pooler`, e.g. `ep-…-123456-pooler.us-east-2.aws.neon.tech`.
- **Not supported when pooled:** `SET`/`RESET`, `LISTEN`/`NOTIFY`, `WITH HOLD CURSOR`, SQL-level `PREPARE`/`DEALLOCATE`, temp tables with `PRESERVE`/`DELETE ROWS`, `LOAD`, **session-level advisory locks**. Protocol-level prepared statements work (PgBouncer ≥ 1.22.0).
- Use the **direct** connection for schema migrations, `pg_dump`, logical replication and `CREATE INDEX CONCURRENTLY` [primary: choose-connection].

**Neon "double pooling" pitfall:** "If you use a pooled Neon connection, avoid adding client-side pooling on top… If you must use client-side pooling, release connections back to the pool promptly" [primary: choose-connection]. Neon's own Fluid example still pairs `new Pool({ connectionString: process.env.DATABASE_URL })` with `attachDatabasePool` [primary: vercel guide]. So keep the pg Pool small (see §10).

**Vercel integration env vars** [primary: neon `guides/vercel-managed-integration.md`]
- `DATABASE_URL` = pooled (PgBouncer).
- `DATABASE_URL_UNPOOLED` = direct.
- `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, plus legacy `POSTGRES_*`.
- Preview branching gives each Preview Deployment a copy-on-write branch `preview/<git-branch>`, with env vars injected per deployment. Neon suggests running migrations in the build command.

**Neon compute lifecycle** [primary: neon `introduction/compute-lifecycle.md`]
- Scale to zero after **5 min** idle (can be disabled on paid plans).
- Activation "generally takes a few hundred milliseconds", longer after 7+ idle days. Buffers are cold after wake-up.
- Advisory locks, prepared statements, `SET` values and temp tables are lost on suspend.
- An "idle-in-transaction" connection counts as active, so it blocks scale-to-zero.

**Why `pg` + `attachDatabasePool` on Fluid** [primary: neon vercel guide]: "Vercel Fluid… keeps a function alive just long enough to safely close idle connections before the function is suspended." TCP setup costs ~8 round trips once per warm instance; HTTP costs ~3 per query. Neon still advises benchmarking: apps with "a very high number of cold starts" may do better with HTTP. How it works in code: `attachDatabasePool` listens to pg `release` events and holds the instance open via `waitUntil` for `idleTimeoutMillis + 100 ms`. pg's default `idleTimeoutMillis` is 10000 (the code falls back to 1e4 when it isn't a number) [sdk-source: `db-connections/index.js` L28-31, L63-82; sdk-source+run: `new pg.Pool().options.idleTimeoutMillis === 10000`]. Vercel docs: "Call attachDatabasePool() right after creating a database pool to ensure idle pool clients are released before functions suspend in Fluid Compute" [primary: Vercel docs MCP, `functions/functions-api-reference/vercel-functions-package`]. Fluid is the default for new projects since 2025-04-23 [primary: Vercel docs MCP, `project-configuration/vercel-ts`].

### 2.2 Supabase

[primary: supabase `guides/database/connecting-to-postgres.mdx`, `…/pooling-and-limits.mdx`, `guides/database/drizzle.mdx`; Drizzle `pg/connect-supabase.mdx`]

| Mode | Host:port | Notes |
|---|---|---|
| Direct | `db.[REF].supabase.co:5432` | IPv6 unless you buy the IPv4 add-on. Use for migrations, `pg_dump` and replication. |
| Shared pooler (Supavisor), session mode | `aws-[INDEX]-[REGION].pooler.supabase.com:5432` | IPv4. User is `postgres.[REF]`. |
| Shared pooler, **transaction mode** | `aws-[INDEX]-[REGION].pooler.supabase.com:6543` | Use for serverless. **Doesn't support prepared statements** or pipelining. Session state (SET, session advisory locks, LISTEN/NOTIFY, temp tables) is lost between transactions. |
| Dedicated pooler (PgBouncer, Pro+) | `db.[REF].supabase.co:6543` | Transaction mode only. Supports prepared statements (PgBouncer ≥ 1.21). |

- The serverless client recipe is `postgres(url, { max: 1, prepare: false, ssl: 'require' })` created at module scope. Supabase: "Set the pool to 1 connection… caps the instance, not the request". For Drizzle the setting is `prepare: false`.
- With `pg` this is a non-issue for Drizzle: queries are unnamed unless you call `.prepare(name)` (see §2.1).
- Supabase installs dashboard-enabled extensions into the **`extensions` schema**; its SQL example is `create extension … with schema extensions` [primary: `guides/database/extensions.mdx`]. If `pg_trgm` lives there, unqualified `gin_trgm_ops`/`similarity()` need `extensions` on the `search_path` [search].

### 2.3 Recommendation (late 2026, Vercel Fluid, Node runtime)

1. **Neon** via the Vercel Marketplace, created on **PG 18**.
2. **`drizzle-orm/node-postgres` + `pg.Pool`**, created at module scope from `process.env.DATABASE_URL` (pooled), with `attachDatabasePool(pool)`, a small `max`, and `idleTimeoutMillis` around 5–10 s.
3. Use `DATABASE_URL_UNPOOLED` for `drizzle-kit` and migrations.
4. Keep every correctness-critical primitive a **single statement** (see §5), so a switch to neon-http or a transaction pooler stays possible.
5. If we ever moved to Supabase: same `pg` code, the transaction pooler on 6543, and nothing named-prepared.

---

## 3. One code path for prod, dev and tests

### 3.1 Driver layering

- App code should depend on a DB type rather than a concrete driver. Either export `type Db = NodePgDatabase<typeof schema>`, or type helpers against the base `PgDatabase<PgQueryResultHKT, typeof schema>` from `drizzle-orm/pg-core`. The drivers subclass it [sdk-source: `pg-core/db.d.ts`].
- **Raw `db.execute()` results differ by driver:**
  - node-postgres and PGlite return `{ rows }`; postgres.js returns an array.
  - `count(*)` comes back as **string `"4"`** from node-postgres and postgres.js, but **number** from `drizzle-orm/pglite` [sdk-source+run].
  - Use typed builders, `db.$count(table)` (returns a number), or `` sql<number>`count(*)`.mapWith(Number) `` (verified to return a number).
  - Drizzle's node-postgres session overrides the parsers for TIMESTAMPTZ/TIMESTAMP/DATE/INTERVAL so raw strings reach the column mappers. A raw `now()` came back as a string [sdk-source: `node-postgres/session.js` L21-54; sdk-source+run].

### 3.2 Local dev without any cloud account

| Option | How | Fidelity | Caveats |
|---|---|---|---|
| A. Local PostgreSQL server (brew/apt/Postgres.app; PG 16.15 in this container) | Same `pg` driver, `DATABASE_URL=postgres://…localhost…` | Real multi-connection server; extensions from the OS package (`pg_trgm` 1.6 present at `/usr/share/postgresql/16/extension`) [sdk-source+run] | Version may differ from Neon (pick 18 where possible). The server's `TimeZone` was `Etc/UTC` here. |
| B. **`pglite-server`** (`@electric-sql/pglite-socket@0.2.16`) | `npx pglite-server -d ./.pglite -p 5432 -e pg_trgm`, then the normal `DATABASE_URL` | PG 18.6, same as Neon's default | README: "Although PGlite is a single-connection database… multiple simultaneous connections" are multiplexed via `-m, --max-connections` (default **1**); "not all use cases are guaranteed to work" [sdk-source: README]. Locally with `-m 1`, `pg.Pool({max:1})` + drizzle node-postgres migrate took **76 ms**, `db.transaction` worked, and `drizzle-kit migrate` connected via the `pg` driver [sdk-source+run]. Other options: `--include-database-url`, `-r/--run <cmd>`, `-u <unix socket>`. |
| C. `drizzle-orm/pglite` in-process with a `dataDir` | `drizzle('./.pglite')` or `drizzle({ connection: { dataDir } })` [primary: `pg/connect-pglite.mdx`] | PG 18.6 | Changes the driver type in dev. One process owns the data dir (my assumption; unverified). Not recommended for `next dev`. |
| Docker | — | — | The Docker daemon isn't running in this container; don't depend on it. |

### 3.3 Unit tests with PGlite (`drizzle-orm/pglite`)

- Construct with `new PGlite({ extensions: { pg_trgm } })` (`import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'`), then `drizzle({ client, schema, casing: 'snake_case' })`.
- Apply migrations with `migrate(db, { migrationsFolder: './drizzle' })` from `drizzle-orm/pglite/migrator` [sdk-source+run]. Without the `pg_trgm` extension loaded, `CREATE EXTENSION IF NOT EXISTS pg_trgm` fails [sdk-source+run].
- `pg_available_extensions` lists only the loaded ones (`pg_trgm`, `plpgsql`) [sdk-source+run].
- Bundled contrib extensions (tarballs in `dist/`) include `pg_trgm`, `btree_gin`, `btree_gist`, `citext`, `fuzzystrmatch`, `unaccent`, `pgcrypto`, `uuid-ossp`, `hstore`, `ltree`, `pg_stat_statements` and others. `pg_trgm` metadata: `importPath: '@electric-sql/pglite/contrib/pg_trgm'`, `core: true`, size 16208 B [sdk-source: dist listing; primary: pglite `docs/extensions/extensions.data.ts`]. pgvector, PostGIS etc. moved to separate npm packages in 0.5.0 [primary: CHANGELOG].
- Timings in this container (Node 22.22.0, one CPU-throttled run each) [sdk-source+run]:
  - First `new PGlite()` ready: **4363 ms**. Fresh boot + migrate: **2097–3985 ms**. `migrate()` alone: **65 ms** (vs **53 ms** on PG16).
  - `clone()`: **884 ms**.
  - `dumpDataDir('none')`: 93 ms, 40,765,952 bytes. Boot with `loadDataDir: dump`: **375–966 ms**. The API docs say the dump "may not be compatible with other Postgres versions; it is only designed for importing back into PGlite" [primary: pglite `docs/docs/api.md`].
  - `TRUNCATE … RESTART IDENTITY CASCADE`: **8.1 ms**. A `db.transaction(… tx.rollback())` round trip: 2.5 ms, and it throws `TransactionRollbackError`.
- Suggested harness (design, not verified end-to-end):
  1. Vitest `globalSetup` boots PGlite, migrates and writes `dumpDataDir()` to a temp file.
  2. Each test file loads it via `loadDataDir`.
  3. `beforeEach` truncates all app tables.
- Fidelity limits:
  - **Single connection.** 20 "concurrent" lease attempts produced 1 winner on PGlite as on PG16, but only because they serialize. Racy read-then-write code would also pass.
  - Lease, `SKIP LOCKED` and advisory-lock contention tests must target a real server (an optional `TEST_DATABASE_URL`).
  - PGlite's `TimeZone` = `UTC`, and initdb has run with `TZ=UTC` since 0.5.12 [primary: CHANGELOG]. `pg_timezone_names` has **598** rows vs **499** on Ubuntu PG16 [sdk-source+run].

---

## 4. drizzle-kit 0.31 and migrations

**Commands** (`npx drizzle-kit --help`): `generate`, `migrate`, `introspect` (pull), `push`, `studio`, `up`, `check`, `drop`, `export` [sdk-source+run].

- `generate`: diffs the schema against the last snapshot and writes `<out>/NNNN_<name>.sql` + `meta/NNNN_snapshot.json` + `meta/_journal.json`. Flags: `--name`, `--custom` (empty file for hand-written SQL), `--prefix index|timestamp|supabase|unix|none` (default `index`), `--breakpoints`.
  - Output, verified: `drizzle/0000_extensions.sql`, `drizzle/0001_init.sql`, journal `{"version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1793283826295,"tag":"0000_extensions","breakpoints":true}, …]}`.
  - Statements are separated by `--> statement-breakpoint`.
  - FKs come out as `ALTER TABLE … ADD CONSTRAINT "meals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;`.
  - The trigram index comes out as `CREATE INDEX "foods_name_trgm_idx" ON "foods" USING gin ("name" gin_trgm_ops);` [sdk-source+run].
- `migrate`: applies pending migrations, recorded in `drizzle.__drizzle_migrations (id serial, hash text, created_at bigint)`. Change it with `migrations: { table, schema }` [sdk-source: `pg-core/dialect.js` L44-72; primary: drizzle `drizzle-kit-migrate.mdx`].
- `push`: introspects the DB, diffs it and applies directly with no files. Flags: `--verbose`, `--strict` (always prompt), `--force` ("Auto-approve all data loss statements") [sdk-source+run: `push --help`]. With `strict: true` and no TTY, the prompt render crashed [sdk-source+run]. In 0.x, push/pull manage only `public` unless `schemaFilter` is set [primary: `pg/v0-v1-changes.mdx`].
- `check`: validates migration files ("Everything's fine 🐶🔥") [sdk-source+run]. The commutativity checks are v1 only [primary].
- Driver auto-pick for `dialect: 'postgresql'`: tries **`pg` → `postgres` → `@vercel/postgres` → `@neondatabase/serverless`** (Neon only "through a websocket"). It connects postgres.js with `max: 1`. `driver: 'pglite'` is explicit [sdk-source: `bin.cjs` L78876-79147]. Prints "Using 'pg' driver for database querying" [sdk-source+run].

**Config shape (0.31 `Config` type)** [sdk-source: `index.d.ts` L113-175]
```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',              // required
  schema: './src/db/schema.ts',       // string | string[] (globs ok)
  out: './drizzle',
  casing: 'snake_case',               // 'camelCase' | 'snake_case' – must match drizzle({ casing })
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED! }, // or {host,port,user,password,database,ssl}
  // driver: 'pglite', dbCredentials: { url: './.pglite' }    // PGlite variant
  migrations: { table: '__drizzle_migrations', schema: 'drizzle', prefix: 'index' },
  breakpoints: true, strict: true, verbose: true,
  // tablesFilter, schemaFilter, extensionsFilters: ['postgis'], entities: { roles: { provider: 'neon' | 'supabase' } }
});
```

**Programmatic migrator internals (0.45.4)** [sdk-source: `migrator.js`, `pg-core/dialect.js`, `neon-http/migrator.js`]
- `readMigrationFiles` throws `Can't find meta/_journal.json file` if the journal is missing. It hashes each file with sha256 and splits on breakpoints.
- `dialect.migrate` runs `CREATE SCHEMA IF NOT EXISTS drizzle` and creates the table, then reads **only the last row** (`order by created_at desc limit 1`). It applies every migration with `lastDbMigration.created_at < folderMillis` inside **one transaction**, so all pending migrations commit or roll back together.
- **Only timestamps are compared, never hashes.** A migration whose journal `when` is older than the last applied one is **silently skipped**. Reproduced: I added `0002_branch` with `when = 0001.when − 60000`, and `migrate()` returned OK, `to_regclass('public.branch_table') = null`, with 2 rows applied [sdk-source+run].
- **No advisory lock.** Two concurrent `migrate()` runs (e.g. two deploys) can race. DDL in a tx will make one fail rather than corrupt anything, but the deploy fails.
- neon-http `migrate` runs statements one by one with **no transaction**.
- Custom SQL (extensions, data backfills) comes from `drizzle-kit generate --custom --name=…`. The Drizzle docs have no API to create extensions: "There is no specific code to create an extension inside the Drizzle schema" [primary: `pg/extensions.mdx`]. Put `CREATE EXTENSION IF NOT EXISTS pg_trgm;` in a custom migration **ordered before** the migration that creates the `gin_trgm_ops` index.
- "Migrations for teams" in the docs only says it will be updated after the v3 folder structure ships (v1) [primary: `kit-migrations-for-teams.mdx`].

**Recommended workflow (0.x)**
- Local prototyping: `drizzle-kit push` against a throwaway local DB is fine.
- Committed changes: `drizzle-kit generate --name=<desc>`, then review the SQL and commit both `.sql` and `meta/`. Never edit an already-applied migration.
- Deploy: a `scripts/migrate.ts` calls `migrate()` over **`DATABASE_URL_UNPOOLED`** in the Vercel build. Neon's integration suggests a build-command override; preview deployments migrate their own preview branch.
  - Take `pg_advisory_lock(<const>)` on that dedicated direct connection around `migrate()`. Session locks are safe there because the connection is direct and not pooled.
- CI gate: run `drizzle-kit check`, then fail the PR if any journal entry's `when` is ≤ the max `when` on `main` (the "rebase and regenerate" rule). Then run `migrate()` against PGlite as a smoke test.
- Use `--force` only in CI, and never `push` against production.

---

## 5. Concurrency primitives under serverless

Verified locally on PG 16.15 with `pg.Pool({max:5})` and on PGlite [sdk-source+run]. Semantics come from the Postgres docs [primary: postgres `REL_18_STABLE` `doc/src/sgml/mvcc.sgml` §advisory-locks, `ref/select.sgml`, `ref/insert.sgml`].

| Primitive | Behaviour | Works via PgBouncer txn mode / neon-http / PGlite? | Verdict |
|---|---|---|---|
| **Dedupe:** `UNIQUE(provider, provider_message_id)` + `INSERT … ON CONFLICT (provider, provider_message_id) DO NOTHING RETURNING id` | RETURNING yields "Only rows that were successfully inserted or updated" [primary: insert.sgml]. Drizzle: `.onConflictDoNothing({ target: [t.provider, t.providerMessageId] }).returning({ id })` produced exactly `… on conflict ("provider","provider_message_id") do nothing returning "id"`. First call returned 1 row, the duplicate 0 rows [sdk-source+run]. | Yes / yes / yes (single statement) | **Use.** Insert *before* returning 200. Empty RETURNING means a duplicate, so skip it. |
| **Lease row:** `UPDATE leases SET lease_owner=$me, lease_expires_at=now()+ttl WHERE user_id=$u AND lease_expires_at < now() RETURNING …` | Row-level locking plus re-check of the WHERE after a concurrent update means **exactly one winner**. 20 concurrent attempts gave **1** winner on PG16 (and on PGlite, trivially) [sdk-source+run]. A crash is recovered automatically when the TTL expires. | Yes / yes / yes | **Recommended.** No long-held transaction or connection. |
| `pg_try_advisory_lock(key)` (session level) | Held "until explicitly released or the session ends"; does **not** honour transaction semantics [primary: mvcc.sgml]. Demo through `pg.Pool`: locked on backend pid 6719. `pg_advisory_unlock(42)` from the other pooled backends returned `false`, so the lock stays stuck to whichever connection took it [sdk-source+run]. | **No.** Neon and Supabase list session advisory locks as unsupported in transaction mode [primary]. Through PgBouncer the next transaction on that backend may belong to another client, and a lock taken via HTTP lives on whatever backend served it. Neon also drops them on compute suspend [primary]. | **Don't use** (except the dedicated direct connection in the migrate script). |
| `pg_try_advisory_xact_lock(key)` (transaction level) | Released automatically at end of transaction [primary]. Txn A got `true`; txn B in parallel got `false`; txn C after A committed got `true` [sdk-source+run]. Key with `hashtextextended(user_id::text, 0)` (bigint). | Pooler: yes. **neon-http: useless**, because a non-interactive `transaction([...])` ends immediately. PGlite: yes (single connection). | Viable only if you **hold a DB transaction open for the whole turn**. With LLM calls taking 10–60 s that pins a pooler backend, counts as "idle in transaction" (blocks Neon scale-to-zero), and dies with the function at `maxDuration`. **Not recommended** for turns. Fine for short critical sections. |
| `SELECT … FOR UPDATE SKIP LOCKED` | "any selected rows that cannot be immediately locked are skipped… can be used to avoid lock contention with multiple consumers accessing a queue-like table" [primary: select.sgml]. Drizzle: `.for('update', { skipLocked: true })` produced `… limit $1 for update skip locked` (`LockStrength = 'update' \| 'no key update' \| 'share' \| 'key share'`; `noWait` and `skipLocked` are mutually exclusive) [sdk-source: `select.types.d.ts` L60-69; sdk-source+run]. Three concurrent claimers over 4 rows took 2, 0 and 2 rows [sdk-source+run]. | Needs an interactive transaction: pooler yes, **neon-http no**, PGlite yes but not concurrent. | **Use for the sweeper** that reclaims expired leases or unprocessed messages. Or fold it into one statement: `UPDATE … WHERE user_id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING …`. |

**Recommended design (database side)**
1. `inbound_messages`: `UNIQUE(provider, provider_message_id)`, plus `processed_at timestamptz NULL` and a partial index `WHERE processed_at IS NULL`. Drizzle index builders support `.where(sql\`…\`)` [primary: `pg/indexes-constraints.mdx`].
2. Per-user state row (e.g. `conversation_state`): `user_id PK FK→users ON DELETE CASCADE`, `process_after timestamptz` (debounce: each inbound sets `now() + interval '4 seconds'`), `lease_owner text NULL`, `lease_expires_at timestamptz NULL`.
3. Claiming a turn is one `UPDATE … WHERE user_id=$1 AND process_after <= now() AND (lease_expires_at IS NULL OR lease_expires_at < now()) RETURNING`. Zero rows means "someone else has it or the debounce was extended", so exit.
4. Every write made under the lease includes `AND lease_owner = $me` (fencing). Release with `UPDATE … SET lease_owner=NULL, lease_expires_at=NULL WHERE user_id=$1 AND lease_owner=$me`, then **re-check for messages that arrived during the turn** and loop.
5. TTL must exceed the processing route's `maxDuration`: Hobby default and max are 300 s (see `docs/research/vercel-next.md` §Functions). Example: `maxDuration = 120` with lease 150 s, and stop early using `getDeadline()`.
6. Recovery: Hobby cron runs **at most daily** (vercel-next.md §1), so also sweep opportunistically. On every inbound webhook, and on every cron run, look for users with unprocessed messages and expired leases (`SKIP LOCKED`).
7. Delivery is at-least-once. A zombie worker can lose its lease after sending a reply. Fencing makes it abort its writes but cannot unsend the message. This is acceptable for a chat coach; record the outbound provider ID to avoid double-sends on retry.

---

## 6. Timezones

- Use `timestamp({ withTimezone: true })` for every instant. In 0.45 the default mode is `'date'`: writes use `value.toISOString()` (UTC), and reads do `new Date(value)` for timestamptz [sdk-source: `pg-core/columns/timestamp.js` L30-36]. Generated DDL: `timestamp with time zone DEFAULT now() NOT NULL` [sdk-source+run].
- Drizzle docs: for timestamptz "you will get back string converted to a timezone set in your Postgres instance" in `string` mode, so check `show timezone` [primary: `pg/column-types.mdx`]. Never depend on session `TimeZone`. **`SET TIME ZONE` isn't possible through Neon's transaction pooler** (`SET` is not supported) [primary]. Write explicit `AT TIME ZONE` instead.
- `date()` returned a **string** (`'2026-10-29'`) by default, which avoids JS `Date` day-shift bugs [sdk-source+run].
- **SQL, verified on PG16 and PGlite** [sdk-source+run]:
  - User's local date: `(now() AT TIME ZONE u.timezone)::date` (e.g. `2026-10-29` for `America/Los_Angeles`).
  - UTC instant of the user's local midnight: `date_trunc('day', now() AT TIME ZONE tz) AT TIME ZONE tz` → `2026-10-29 07:00:00+00`.
  - Semantics: `timestamptz AT TIME ZONE zone` gives local wall-clock `timestamp`, and `timestamp AT TIME ZONE zone` gives `timestamptz`.
- **Recommendation:**
  - Compute `localDate` in app code from an injected clock with `Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' })` (format not verified here; standard ECMA-402).
  - **Store it** on `meals.local_date` at insert time. Moving timezones later doesn't rewrite history, the "today" query is `WHERE user_id=$1 AND local_date=$2` (index `(user_id, local_date)`, verified to generate), and tests are deterministic.
  - Use SQL `AT TIME ZONE` for set-based selection, e.g. the cron query picks users whose local hour is due (`extract(hour from now() AT TIME ZONE timezone)`) and checks quiet hours.
- Validate `users.timezone` in app code (Zod refine: `Intl.supportedValuesOf('timeZone')` or try `new Intl.DateTimeFormat(undefined,{timeZone})`). Postgres throws on unknown zone names inside `AT TIME ZONE`. Tz name sets differ between ICU and the server (598 names on PGlite vs 499 on PG16 here), so store canonical IANA names only.

---

## 7. Food-name search

- **pg_trgm availability:**
  - Neon: listed for PG14–18, all v1.6 [primary: neon `extensions/pg-extensions.md`, `extensions/pg_trgm.md`; enable with `CREATE EXTENSION IF NOT EXISTS pg_trgm;`].
  - Supabase: available from the dashboard or SQL, installed into the `extensions` schema [primary: `guides/database/extensions.mdx`; search].
  - PGlite: `@electric-sql/pglite/contrib/pg_trgm`, which must be passed in `extensions` [sdk-source+run].
  - Local PG16: contrib 1.6 [sdk-source+run].
- Drizzle index: `index('foods_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops'))` [sdk-source+run]. The docs' generic form is `.using('btree', col.asc(), sql\`lower(${col})\`, col.op('text_ops'))` [primary: `pg/indexes-constraints.mdx`].
- Queries (raw `sql`; Drizzle has no trigram operators):
  - `name % $q` uses the GIN index; similarity threshold default 0.3 (Postgres docs, not verified here).
  - `similarity(name,$q)`: 'chiken brest' → 'Chicken breast, roasted' **0.346** [sdk-source+run].
  - `word_similarity($q,name)`: 'yoghurt' → 'Greek yogurt, plain' **0.5** [sdk-source+run].
  - Results were identical on PG16 and PGlite.
- Full-text alternative: Drizzle's guide uses `index(...).using('gin', sql\`to_tsvector('english', ${t.title})\`)` with `@@ plainto_tsquery / websearch_to_tsquery` [primary: `guides/postgresql-full-text-search.mdx`]. FTS stems words but doesn't fix typos. **Trigram suits short food names and misspellings better**; we could combine both later.
- Supabase caveat: if `pg_trgm` is in `extensions`, the opclass may need qualifying (`extensions.gin_trgm_ops`). Keep a custom migration per provider, or create the extension in `public` explicitly.

---

## 8. "DELETE wipes all my data"

- Declare every user-owned table with `references(() => users.id, { onDelete: 'cascade' })` (`UpdateDeleteAction = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default'`) [sdk-source: `pg-core/foreign-keys.d.ts`].
- Then one `DELETE FROM users WHERE id=$1` removes everything. Verified: inbound_messages, meals and turn_leases went to 0 rows on PG16 and PGlite [sdk-source+run].
- Run it in one statement or transaction **after** the confirmation step. Keep a non-PII tombstone (e.g. phone hash + deleted_at) only if needed for STOP/abuse handling (product decision).
- Not covered by CASCADE:
  - Blob/S3 images: delete them first, in app code, by listing keys from the DB before the row delete.
  - Stripe customer: see `docs/research/stripe.md`.
  - Logs.
  - **Neon instant-restore history:** default **6 h on Free, 1 day on paid**, configurable up to 7 days (Launch) or 30 days (Scale) [search: neon.com/docs/introduction/branching, cost-optimization].
  - **Preview branches:** these are copy-on-write copies of production *data* [primary: neon vercel-managed-integration]. Neon offers **schema-only branches** (beta) to avoid copying PII [primary: neon `guides/branching-schema-only.md`].
- Rows referencing users from shared tables (e.g. a global FDC cache) must not cascade. Keep shared caches free of user IDs.

---

## 9. Schema typing notes (0.45)

- `pgEnum('provider', ['simulator','sendblue'])` → `CREATE TYPE "public"."provider" AS ENUM(...)` [sdk-source+run]. Adding values later needs `ALTER TYPE … ADD VALUE`, which drizzle-kit generates. Prefer `text` + Zod/check constraints for sets that will change often (design opinion).
- `jsonb().$type<MealItem[]>()` gives compile-time typing only. It "**won't** check runtime values" [primary: `pg/column-types.mdx`]. Round-trip verified [sdk-source+run]. Validate with Zod before insert.
- `uuid().primaryKey().defaultRandom()` → `DEFAULT gen_random_uuid()` (core since PG13) [sdk-source+run].
- `casing: 'snake_case'` in both `drizzle({ casing })` and `drizzle.config.ts` maps `providerMessageId` → `provider_message_id` [sdk-source+run].
- Third-arg array syntax `(t) => [index(...), uniqueIndex(...)]` works in 0.45 [sdk-source+run].
- Transactions: `db.transaction(async (tx) => …, { isolationLevel: 'read committed'|'repeatable read'|'serializable'|'read uncommitted', accessMode, deferrable })`. Nested `tx.transaction` uses savepoints. `tx.rollback()` throws [primary: `pg/transactions.mdx`; sdk-source+run].
- Prepared statements: name them with `.prepare('name')` only if the pooler supports protocol-level prepares. Neon does (`max_prepared_statements=1000`); the Supabase shared pooler does not [primary]. Default to unprepared.

---

## Implications for our design

1. **Production DB:** Neon (Vercel Marketplace, PG 18, same region as functions; Vercel's default is `iad1`).
2. **Driver:** `drizzle-orm/node-postgres` + `pg@8.23.1` with a module-scope `Pool({ connectionString: DATABASE_URL, max: ~5, idleTimeoutMillis: ~5000 })` and `attachDatabasePool(pool)`. **No** postgres.js and **no** neon-http in the main path. Log the decision in DECISIONS.md.
3. **Env vars:** `DATABASE_URL` (pooled, runtime) and `DATABASE_URL_UNPOOLED` (migrations, drizzle-kit). Locally both point at the same local DB. Add both to `.env.example`.
4. **Local dev:** any local Postgres ≥ 16, or `npx pglite-server -d ./.pglite -e pg_trgm`. The `pg` driver is identical in every case, and no cloud account is needed.
5. **Tests:** `drizzle-orm/pglite` with migrations applied from `./drizzle`, a snapshot via `dumpDataDir`/`loadDataDir`, and `TRUNCATE` between tests. A separate `*.pg.test.ts` suite for lease/dedupe/SKIP LOCKED races runs only when `TEST_DATABASE_URL` is set; this container can use `/usr/lib/postgresql/16`.
6. **Migrations:** `drizzle-kit generate` (custom migration `0000` creates `pg_trgm`), `migrate()` in a build-time script over the unpooled URL inside a session advisory lock, and a CI check that journal timestamps are monotonic.
7. **Concurrency:** webhook dedupe through a unique constraint with `ON CONFLICT DO NOTHING RETURNING`, a per-user lease row with debounce (`process_after`), fencing on `lease_owner`, and an opportunistic plus cron sweeper using `SKIP LOCKED`. No advisory locks in request paths.
8. **Time:** `timestamptz` everywhere. Meal rows carry `local_date date` computed in app code from `users.timezone` (IANA, Zod-validated). Cron selection uses `AT TIME ZONE` in SQL.
9. **Search:** a `foods` cache table with a GIN `gin_trgm_ops` index; query with `%` plus `similarity()`/`word_similarity()` ordering.
10. **Deletion:** every user-owned FK uses `ON DELETE CASCADE`. The DELETE command removes blobs first, then the user row. Document the PITR window in the privacy notice. Use schema-only or seed-data preview branches, never copies of prod data.
11. Pin exact versions (`drizzle-orm@0.45.4`, `drizzle-kit@0.31.11`, `pg@8.23.1`, `@electric-sql/pglite@0.5.13`, `@electric-sql/pglite-socket@0.2.16`). Reassess the drizzle v1 upgrade (`drizzle-kit up`) only after 1.0 reaches `latest`.

## Open questions for the product owner

1. **Retention after DELETE.** Neon's restore history keeps deleted rows for 6 h on Free and 1 day by default on paid plans (up to 7–30 days if raised) [search]. Is that acceptable to disclose in the consumer health data notice, or should we set the minimum window and say "deleted from backups within N hours/days"? This is legal wording only you can approve.

## Risks

- **Docs/version drift:** the Drizzle docs default to v1 RC. Copying snippets (`migrate(db)`, `defineRelations`, `drizzle-orm/zod`, folder layout) into 0.45 code will break. Pin versions and check against `.d.ts`.
- **Silent skipped migrations** (timestamp-only comparison) and **no migration lock** in 0.45. Mitigate with the CI rule plus an advisory-locked migrate script.
- **PGlite gaps:** single connection (race bugs invisible), PG 18 vs a dev's local PG 16, different tz database, and different raw-result typing (number vs string). It is also "alpha", and the node-postgres adapter hung my migrator test.
- **`pglite-server` multiplexing** is "not guaranteed to work" for all cases. Keep `-m 1` and `pool max 1` locally.
- **`attachDatabasePool` is marked `@experimental`.** If Vercel changes it, idle TCP connections could leak on suspend. Neon's 10,000 client-connection cap gives headroom.
- **Neon scale-to-zero** adds a few hundred ms to the first query after 5 min idle. Long or idle transactions block suspend (cost).
- **Lease TTL vs `maxDuration`:** a TTL that is too short causes double processing; too long delays recovery after a crash. `after()`/`waitUntil` work is not durable (vercel-next.md), so the sweeper is mandatory.
- **Extension ordering/placement:** `pg_trgm` must exist before the index migration. Supabase installs it into `extensions`.
- **Preview deployments** with Neon branching copy production health data unless schema-only branches are used. A build-time migrate also runs on every preview build.
- **postgres.js** (if anyone swaps it in) has pipelining hazards on transaction poolers (Supabase docs).

## Sources

- Drizzle docs repo (commit 75cad5e, 2026-10-23): https://github.com/drizzle-team/drizzle-orm-docs — `src/content/docs/pg/connect-neon.mdx`, `pg/connect-supabase.mdx`, `pg/connect-pglite.mdx`, `pg/migrations.mdx`, `pg/drizzle-kit-push.mdx`, `pg/drizzle-kit-migrate.mdx`, `pg/kit-custom-migrations.mdx`, `pg/transactions.mdx`, `pg/batch-api.mdx`, `pg/indexes-constraints.mdx`, `pg/column-types.mdx`, `pg/extensions.mdx`, `pg/v0-v1-changes.mdx`, `upgrade-v1.mdx`, `kit-migrations-for-teams.mdx`, `perf-serverless.mdx`, `guides/postgresql-full-text-search.mdx`, `tutorials/drizzle-nextjs-neon.mdx`
- npm tarballs: https://www.npmjs.com/package/drizzle-orm/v/0.45.4 , https://www.npmjs.com/package/drizzle-kit/v/0.31.11 , https://www.npmjs.com/package/@neondatabase/serverless/v/1.2.0 (README.md, CONFIG.md, CHANGELOG.md) , https://www.npmjs.com/package/postgres/v/3.4.9 , https://www.npmjs.com/package/pg/v/8.23.1 , https://www.npmjs.com/package/@electric-sql/pglite/v/0.5.13 , https://www.npmjs.com/package/@electric-sql/pglite-socket/v/0.2.16 , https://www.npmjs.com/package/@vercel/functions/v/3.10.4 , https://www.npmjs.com/package/drizzle-zod
- Neon docs (raw source): https://raw.githubusercontent.com/neondatabase/website/main/content/docs/guides/vercel-connection-methods.md (https://neon.com/docs/guides/vercel-connection-methods) ; …/connect/choose-connection.md ; …/connect/connection-pooling.md ; …/introduction/compute-lifecycle.md ; …/extensions/pg-extensions.md ; …/extensions/pg_trgm.md ; …/guides/vercel-overview.md ; …/guides/vercel-managed-integration.md ; …/guides/branching-schema-only.md ; …/reference/compatibility.md ; …/postgresql/postgres-version-support.md ; https://raw.githubusercontent.com/neondatabase/website/main/content/changelog/2026-06-05.md
- Neon (search only): https://neon.com/docs/introduction/branching , https://neon.com/docs/introduction/cost-optimization , https://neon.com/faqs/databases-recover-accidental-data-deletion
- Supabase docs (raw source): https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/connecting-to-postgres.mdx ; …/database/connecting-to-postgres/pooling-and-limits.mdx ; …/database/postgres-js.mdx ; …/database/drizzle.mdx ; …/database/extensions.mdx ; search: https://supabase.com/docs/guides/database/extensions
- PGlite docs (raw source): https://raw.githubusercontent.com/electric-sql/pglite/main/docs/docs/api.md ; …/docs/docs/about.md ; …/docs/extensions/extensions.data.ts ; https://raw.githubusercontent.com/electric-sql/pglite/main/packages/pglite/CHANGELOG.md
- PostgreSQL docs source (REL_18_STABLE): https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/doc/src/sgml/mvcc.sgml (https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) ; …/ref/select.sgml (https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) ; …/ref/insert.sgml (https://www.postgresql.org/docs/current/sql-insert.html)
- Vercel docs (via Vercel docs MCP): https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package (attachDatabasePool) ; https://vercel.com/docs/project-configuration/vercel-ts (Fluid default since 2025-04-23) ; https://vercel.com/docs/fluid-compute
- Sibling research: /home/user/Spencer-personal-finance/docs/research/vercel-next.md (durations, cron limits, `after()`), /home/user/Spencer-personal-finance/docs/research/stripe.md
- Local experiments (scratch, not committed): /tmp/research-database/exp/src/schema.ts, exp.ts, exp2.ts, exp3.ts, exp4.ts, exp5.ts, exp6.ts; logs /tmp/research-database/exp/out.log, out2.log
