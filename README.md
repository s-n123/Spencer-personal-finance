# iMessage AI nutrition coach

An AI nutrition coach used entirely over iMessage. Users text meal photos, menus, supplement labels and questions; the coach logs meals, totals the day and suggests what to order. It is a general-wellness tool, not medical advice.

**Status:** Milestone 1 of 7, the scaffold. The simulator, the message pipeline, photo handling and an agent that describes photos all work. Meal logging arrives in M2. See `docs/PLAN.md` §8 for the milestones.

## Run it locally (no API key needed)

Requires Node 22.18 or later.

```sh
npm ci
cp .env.example .env.local
# No Anthropic key yet? Set LLM_PROVIDER=fake in .env.local for the offline demo model.
npm run dev
```

Open http://localhost:3000/dev/chat. It's an iMessage-style simulator using fictional numbers (`+1 201 555 01XX`). `npm run dev` starts a local PGlite database on 127.0.0.1:54330 and runs migrations, so you don't need to install Postgres. The dev server listens on 127.0.0.1 only. To try it from your phone, run `npm run dev -- -H 0.0.0.0` and open `http://<this computer's LAN IP>:3000/dev/chat`; anyone on your network can then use the simulator and your API key.

To get real replies, set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic` in `.env.local`.

## Checks

```sh
npm run check     # typecheck, lint, migration check, unit tests (no network)
npm run test:pg   # real Postgres 16 suite (uses TEST_DATABASE_URL or local PG16 binaries)
```

## Where things are

| | |
|---|---|
| `SPEC.md` | The product spec (source of truth) |
| `docs/PLAN.md` | Architecture, data model, milestones |
| `DECISIONS.md` | Every default chosen without asking |
| `CLAUDE.md` | Conventions, invariants and gotchas for contributors |
| `src/server/` | Pipeline, agent, media, channels, DB |
| `src/app/dev/chat` | The simulator UI (dev only; always off in production) |

Never commit real phone numbers, photos of people or meals, or secrets. This repository is public.
