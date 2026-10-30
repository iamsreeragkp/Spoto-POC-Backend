# Sporto POC Backend

Express + PostgreSQL API for football player scouting reports. No auth (POC).

## Run

```bash
docker compose up -d        # Postgres 16 on :5432 (or point DATABASE_URL at your own instance)
npm install
cp .env.example .env
npm run db:setup            # create tables + import data/Reports_Players_Test_English.xlsx (re-runnable; truncates first)
npm start                   # http://localhost:4000   (npm run dev for watch mode)
```

## Data model (from the 175-row Excel sheet)

| Table | Purpose |
|---|---|
| `players` | one row per player (name, age group, jersey, position, strong foot, team, parents' heights) |
| `teams` | clubs (player teams and home/away teams) |
| `scouts` | people who wrote reports |
| `matches` | event, date/time, format, home/away team |
| `reports` | the scouting report: player + match + scout, Physical/Mental/Technical/Tactical/Deadball/X-factor text, 0-10 scores, overall score/potential, comment, recommendation |

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
