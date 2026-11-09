# Sporto POC Backend

Express + PostgreSQL API for football player scouting reports. No auth (POC).

## Run

```bash
cp .env.example .env        # set OPENAI_API_KEY
docker compose up -d        # Postgres 16 + pgvector on :5432 and the API on :4000
npm install
npm run db:setup            # tables + Excel import + derived data + geocoding + embeddings (re-runnable; truncates first)
```
Without Docker for the API: `npm start` (or `npm run dev`) with Postgres from `docker compose up -d db`.
After code changes: `docker compose up -d --build api`.

## Chatbot
`POST /api/chat` and SSE `GET /api/chat/stream`; see [CHAT_API.md](CHAT_API.md). Flow:
1. **Plan:** one LLM call routes the question (`data` / `general` / `help` / `clarify` / `refuse`) and, for data questions, fills a JSON query spec. The spec is validated against whitelists ([src/chat/spec.js](src/chat/spec.js)); the LLM never writes SQL.
2. **Retrieve:** parameterised SQL ([src/chat/builder.js](src/chat/builder.js)) over `player_latest` (one row per player, maintained by triggers), `report_facts` (one row per report), `report_tags`, per-field full-text indexes (`player_text`, `reports.tsv_*`) and cached driving times. Meaning searches ([src/chat/retrieval.js](src/chat/retrieval.js)) embed the question, find the closest **unique** scout sentences/tags with pgvector, and have the LLM confirm which really match.
3. **Answer:** counts, lists and statistics are templated from SQL results, so their numbers are exact. Profiles, comparisons and comment judgements are written by the LLM from a redacted shortlist of reports, citing `#report_id`.
4. **Remember:** turns are stored in `chat_messages` for follow-ups.

All chatbot queries run on a read-only connection with a statement timeout (`chat_reader` role). Scout/team names are redacted before text goes to the LLM; `CHAT_ALLOW_COMMENT_LLM=false` stops it entirely.
New report text is split into sentences by a trigger and embedded by a background worker in the API (`EMBEDDINGS_WORKER`); `npm run db:embed` does it by hand.

| Command | What it does |
|---|---|
| `npm test` | Unit + golden tests for every route/intent against an isolated `sporto_poc_test` database (created automatically), with the LLM and embeddings mocked. No network, no cost; your data is untouched. |
| `npm run eval:chat` | Live evaluation: 42 realistic questions through the real OpenAI planner against your database; prints pass/fail and latency (a few cents per run). |
| `npm run db:synth` | Adds 300k synthetic players / 1M reports for scale testing (~7 min). Synthetic players are named `Player S-…`. `npm run db:synth:clean` removes them. |
| `npm run db:embed` | Embeds any sentences still waiting for an embedding. |

## Data model (from the 175-row Excel sheet)

| Table | Purpose |
|---|---|
| `players` | one row per player (name, age group, jersey, position, strong foot, team, parents' heights) |
| `teams` | clubs (player teams and home/away teams) |
| `scouts` | people who wrote reports |
| `matches` | event, date/time, format, home/away team |
| `reports` | the scouting report: player + match + scout, Physical/Mental/Technical/Tactical/Deadball/X-factor text, 0-10 scores, overall score/potential, comment, recommendation |

Chatbot tables (derived, kept in sync by triggers; see [src/db/chat_v2_schema.sql](src/db/chat_v2_schema.sql)): `player_latest`, `player_text`, `report_tags`, `text_chunks` (unique sentences/tags + embeddings), `report_chunks` (which report contains which sentence), `places` / `drive_time` (geo cache), `chat_conversations` / `chat_messages`.

Sheet columns that are completely empty (`dateOfBirth`, `yearOfBirth`, `notes`, `matchLocation`, `matchAgeGroup`, `Score Deadball`, `Score X-factor`) still have columns so they can be filled via the API.

## Endpoints

Each of `/api/players`, `/api/reports`, `/api/matches`, `/api/teams`, `/api/scouts` supports:

| Method | Path | |
|---|---|---|
| GET | `/api/<resource>` | list (paginated) |
| GET | `/api/<resource>/:id` | get one |
| POST | `/api/<resource>` | create |
| PUT / PATCH | `/api/<resource>/:id` | update (only supplied fields change) |
| DELETE | `/api/<resource>/:id` | delete |

Extras: `GET /api/players/:id/reports`, `/api/scouts/:id/reports`, `/api/matches/:id/reports`, `/api/teams/:id/players`, `GET /api/stats`, `GET /health`.

Body fields use the snake_case column names (e.g. `player_id`, `overall_score`); unknown fields return 400.

### List query params
- Paging/sorting: `page`, `limit` (max 200), `sortBy`, `order=asc|desc`; `search` does free-text across the key columns.
- players: `name, gender, ageGroup, position, secondaryPosition, strongFoot, location, teamId, team, jerseyNumber`
- reports: `playerId, player, scoutId, scout, matchId, recommendation, stageOfGrowth, position, ageGroup, overallScore, minOverallScore, maxOverallScore, minPotentialScore, dateFrom, dateTo`
- matches: `event, gameFormat, homeTeamId, awayTeamId, team, dateFrom, dateTo`
- teams/scouts: `name`

Response shape: `{ "data": [...], "pagination": { page, limit, total, totalPages } }`.
Errors: `{ "error": "...", "details": ... }` with 400 (bad input / score outside 0-10), 404, 409 (duplicate name / bad foreign key).

## Notes
- `players.name` is unique (the sample has "Player 1…175"); drop that constraint in `src/db/schema.sql` if real data may repeat names.
- Excel dates/times are converted to real `DATE`/`TIME` values on import.
