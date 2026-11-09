# Sporto POC – API Documentation

**Base URL:** `http://localhost:4000` (set by `PORT` in `.env`)
**Auth:** none. **Format:** JSON (`Content-Type: application/json` for POST/PUT/PATCH). **CORS:** enabled for all origins.

## Conventions

- **Naming:** all request and response fields are `snake_case`. Query-string filter names are `camelCase` (e.g. `minOverallScore`).
- **Dates:** `YYYY-MM-DD` strings. **Times:** `HH:MM:SS`. `created_at` / `updated_at` are ISO timestamps.
- **Scores** (`overall_score`, `score_*`, …) are integers 0–10 (the data currently uses 3–6).
- **Numeric averages** (`avg_overall_score`, `avg_potential_score`) come back as **strings** like `"4.50"` – convert with `Number()`.
- **Multi-value text** (`physical`, `mental`, `technical`, `tactical`, `deadball`, `x_factor`) are comma-separated strings of tags, e.g. `"Acceleration, Agility – quick feet, Turns"`.
- **Updates:** `PUT` and `PATCH` behave identically – only the fields you send are changed. An empty string `""` is saved as `null`.
- **Unknown body fields** return `400`. `id`, `created_at`, `updated_at` and the joined/read-only fields cannot be set.

### Success shapes

| Case | Shape |
|---|---|
| Single record (GET one / POST / PUT / PATCH) | `{ "data": { ... } }` (POST returns `201`) |
| List | `{ "data": [ ... ], "pagination": { "page": 1, "limit": 20, "total": 175, "totalPages": 9 } }` |
| Sub-resource lists (`/:id/reports`, `/teams/:id/players`) | `{ "data": [ ... ] }` (not paginated) |
| Delete | `{ "message": "players deleted", "id": 12 }` |

### Error shape

```json
{ "error": "Missing required field(s): name", "details": null }
```

| Status | When |
|---|---|
| 400 | invalid id, missing required field, unknown field, bad date/number format, score outside 0–10, invalid `sortBy`, invalid JSON |
| 404 | record or route not found |
| 409 | duplicate unique `name`, or a foreign key points to a non-existent row (e.g. bad `team_id`) |
| 500 | unexpected server error |

### Common list query params (all list endpoints)

| Param | Default | Notes |
|---|---|---|
| `page` | 1 | |
| `limit` | 20 | max 200 |
| `search` | – | free-text, case-insensitive "contains" across the key columns listed per resource |
| `sortBy` | per resource | allowed values listed per resource, otherwise `400` |
| `order` | `asc` | `asc` or `desc` |

Text filters marked *contains* are case-insensitive partial matches; the others are exact matches.

---

## Players – `/api/players`

| Method | Path | Description |
|---|---|---|
| GET | `/api/players` | List players |
| GET | `/api/players/:id` | Get one player |
| GET | `/api/players/:id/reports` | All reports for the player (newest first) |
| POST | `/api/players` | Create |
| PUT / PATCH | `/api/players/:id` | Update |
| DELETE | `/api/players/:id` | Delete (also deletes the player's reports) |

**Writable fields:** `name` (**required**, unique), `gender`, `date_of_birth`, `year_of_birth`, `age_group` (birth-year cohort, e.g. `2012`), `jersey_number`, `location`, `position`, `secondary_position`, `strong_foot` (`Right` / `Left` / `Both feet`), `team_id`, `mother_height`, `father_height` (ranges such as `"161-170"`), `notes`.

**Extra read-only fields in responses:** `id`, `created_at`, `updated_at`, `team_name`, `report_count`, `avg_overall_score`, `avg_potential_score`.

**Filters:** `name` *(contains)*, `gender`, `ageGroup`, `position` *(contains)*, `secondaryPosition` *(contains)*, `strongFoot`, `location` *(contains)*, `teamId`, `team` *(team name, contains)*, `jerseyNumber`
**search** covers: name, position, location, team name
**sortBy:** `id` (default), `name`, `ageGroup`, `position`, `team`, `location`, `jerseyNumber`, `reportCount`, `avgOverallScore`

Example – `GET /api/players?position=back&ageGroup=2012&sortBy=avgOverallScore&order=desc&limit=2`

```json
{
  "data": [
    {
      "id": 5, "name": "Player 5", "gender": "Male",
      "date_of_birth": "2012-03-14", "year_of_birth": 2012, "age_group": 2012,
      "jersey_number": 18, "location": "Aalborg",
      "position": "Left centre-back", "secondary_position": "Left back", "strong_foot": "Right",
      "team_id": 4, "team_name": "AaB",
      "mother_height": "161-170", "father_height": "181-190", "notes": null,
      "report_count": 1, "avg_overall_score": "5.00", "avg_potential_score": "5.00",
      "created_at": "2026-10-30T04:48:59.030Z", "updated_at": "2026-10-30T04:48:59.030Z"
    }
  ],
  "pagination": { "page": 1, "limit": 2, "total": 38, "totalPages": 19 }
}
```

Create – `POST /api/players`
```json
{ "name": "Player 176", "age_group": 2013, "position": "Right back", "team_id": 3 }
```

---

## Reports – `/api/reports`

A report is one scout's assessment of one player at one match.

| Method | Path | Description |
|---|---|---|
| GET | `/api/reports` | List reports |
| GET | `/api/reports/:id` | Get one report |
| POST | `/api/reports` | Create |
| PUT / PATCH | `/api/reports/:id` | Update |
| DELETE | `/api/reports/:id` | Delete |

**Writable fields:** `player_id` (**required**), `match_id`, `scout_id`, `report_date`, `stage_of_growth` (`Very Early developed` / `Early developed` / `Average developed` / `Late developed` / `Very Late developed`), `height_now` (range, e.g. `"141-150"`), `physical`, `mental`, `technical`, `tactical`, `deadball`, `x_factor`, `score_physical`, `score_mental`, `score_technical`, `score_tactical`, `score_deadball`, `score_x_factor`, `overall_score`, `overall_potential_score`, `overall_comment`, `recommendation`.

`recommendation` values currently in the data: `Scout recommends this player!`, `Needs to be watched again!`, `Golden Boy!!!`, `Not good enough – discontinue monitoring!` (free text – not enforced).

**Extra read-only fields in responses:** `id`, `created_at`, `updated_at`, `player_name`, `player_age_group`, `player_position`, `scout_name`, `event`, `match_date`, `home_team`, `away_team`.

**Filters:** `playerId`, `player` *(name, contains)*, `scoutId`, `scout` *(name, contains)*, `matchId`, `recommendation` *(contains)*, `stageOfGrowth`, `position` *(player position, contains)*, `ageGroup` *(player birth year)*, `overallScore`, `minOverallScore`, `maxOverallScore`, `minPotentialScore`, `dateFrom`, `dateTo` *(YYYY-MM-DD, inclusive, on report_date)*
**search** covers: player name, scout name, overall comment, recommendation, event, physical/mental/technical/tactical/x-factor text
**sortBy:** `date` (default, newest first), `id`, `player`, `scout`, `overallScore`, `potentialScore`

Example – `GET /api/reports/3`
```json
{
  "data": {
    "id": 3, "player_id": 3, "match_id": 3, "scout_id": 3,
    "report_date": "2024-08-05",
    "stage_of_growth": "Average developed", "height_now": "151-160",
    "physical": "Acceleration, Agility – quick feet, Pace/speed, Turns",
    "mental": "Presence/energy, Attitude, Forward-thinking, Natural leader",
    "technical": "Good football decisions – on the ball, Carries the ball past the first press",
    "tactical": "Strong defensive 1v1, Defends proactively",
    "deadball": null,
    "x_factor": "Composed on the ball and good at defending",
    "score_physical": null, "score_mental": null, "score_technical": null,
    "score_tactical": null, "score_deadball": null, "score_x_factor": null,
    "overall_score": 5, "overall_potential_score": 5,
    "overall_comment": "He is composed on the ball, has very good technique ...",
    "recommendation": "Scout recommends this player!",
    "player_name": "Player 3", "player_age_group": 2012, "player_position": "Left back",
    "scout_name": "René Lybek Hansen",
    "event": "Vildbjerg Cup final - U13 (Second-highest division)", "match_date": "2024-08-05",
    "home_team": "FS Holstebro", "away_team": "Allerød FK",
    "created_at": "2026-10-30T04:48:59.030Z", "updated_at": "2026-10-30T04:48:59.030Z"
  }
}
```

Create – `POST /api/reports`
```json
{
  "player_id": 3, "scout_id": 3, "match_id": 3, "report_date": "2026-10-01",
  "overall_score": 5, "overall_potential_score": 6,
  "overall_comment": "Re-watched, improving.", "recommendation": "Needs to be watched again!"
}
```

---

## Matches – `/api/matches`

| Method | Path | Description |
|---|---|---|
| GET | `/api/matches` | List matches |
| GET | `/api/matches/:id` | Get one match |
| GET | `/api/matches/:id/reports` | Reports written about this match |
| POST | `/api/matches` | Create |
| PUT / PATCH | `/api/matches/:id` | Update |
| DELETE | `/api/matches/:id` | Delete (reports are kept, their `match_id` becomes `null`) |

**Writable fields:** `event` (**required**, e.g. `"Match - U12 (Top division)"`), `match_date`, `match_time`, `location`, `age_group` (e.g. `"U12"`), `game_format` (`8:8` / `11:11`), `home_team_id`, `away_team_id`.

**Extra read-only fields:** `id`, `created_at`, `updated_at`, `home_team_name`, `away_team_name`, `report_count`.

**Filters:** `event` *(contains)*, `gameFormat`, `homeTeamId`, `awayTeamId`, `team` *(home or away name, contains)*, `dateFrom`, `dateTo`
**search** covers: event, home team, away team, location
**sortBy:** `date` (default, newest first), `id`, `event`, `reportCount`

Example – `GET /api/matches/1`
```json
{
  "data": {
    "id": 1, "event": "Ongoing monitoring - U11 (Second-highest division)",
    "match_date": "2024-01-25", "match_time": "10:00:00", "location": "Fredericia",
    "age_group": "U11", "game_format": "8:8",
    "home_team_id": 1, "away_team_id": 2,
    "home_team_name": "Erritsø IF", "away_team_name": "FC Fredericia", "report_count": 1,
    "created_at": "2026-10-30T04:48:59.030Z", "updated_at": "2026-10-30T04:52:17.286Z"
  }
}
```

---

## Teams – `/api/teams`

| Method | Path | Description |
|---|---|---|
| GET | `/api/teams` | List teams |
| GET | `/api/teams/:id` | Get one team |
| GET | `/api/teams/:id/players` | Players on the team |
| POST | `/api/teams` | Create – body `{ "name": "AaB" }` (`name` **required**, unique) |
| PUT / PATCH | `/api/teams/:id` | Update – body `{ "name": "..." }` |
| DELETE | `/api/teams/:id` | Delete (players/matches keep existing, their team field becomes `null`) |

**Response fields:** `id`, `name`, `player_count`, `created_at`, `updated_at`.
**Filters:** `name` *(contains)* · **search:** name · **sortBy:** `name` (default), `id`, `playerCount`

---

## Scouts – `/api/scouts`

| Method | Path | Description |
|---|---|---|
| GET | `/api/scouts` | List scouts |
| GET | `/api/scouts/:id` | Get one scout |
| GET | `/api/scouts/:id/reports` | Reports written by the scout |
| POST | `/api/scouts` | Create – body `{ "name": "Jørgen Larsen" }` (`name` **required**, unique) |
| PUT / PATCH | `/api/scouts/:id` | Update – body `{ "name": "..." }` |
| DELETE | `/api/scouts/:id` | Delete (reports are kept, `scout_id` becomes `null`) |

**Response fields:** `id`, `name`, `report_count`, `created_at`, `updated_at`.
**Filters:** `name` *(contains)* · **search:** name · **sortBy:** `name` (default), `id`, `reportCount`

---

## Other

### `GET /api/stats`
Dashboard-style summary.
```json
{
  "data": {
    "counts": { "players": 175, "reports": 175, "matches": 157, "teams": 109, "scouts": 20 },
    "byRecommendation": [ { "recommendation": "Needs to be watched again!", "count": 127 } ],
    "byOverallScore":   [ { "overall_score": 5, "count": 80 } ],
    "byPosition":       [ { "position": "Right centre-back", "count": 21 } ],
    "byScout":          [ { "scout": "Claus Engen", "reports": 12 } ]
  }
}
```

### `GET /health`
`200 { "status": "ok", "db": "up" }` or `503 { "status": "error", "db": "down", "message": "..." }`.

---

## Quick reference

| Resource | List | One | Create | Update | Delete | Extras |
|---|---|---|---|---|---|---|
| players | GET `/api/players` | GET `/:id` | POST | PUT/PATCH `/:id` | DELETE `/:id` | GET `/:id/reports` |
| reports | GET `/api/reports` | GET `/:id` | POST | PUT/PATCH `/:id` | DELETE `/:id` | – |
| matches | GET `/api/matches` | GET `/:id` | POST | PUT/PATCH `/:id` | DELETE `/:id` | GET `/:id/reports` |
| teams | GET `/api/teams` | GET `/:id` | POST | PUT/PATCH `/:id` | DELETE `/:id` | GET `/:id/players` |
| scouts | GET `/api/scouts` | GET `/:id` | POST | PUT/PATCH `/:id` | DELETE `/:id` | GET `/:id/reports` |

---

## Chatbot – `/api/chat`

Natural-language questions about players. The AI only converts the question into a structured query; the numbers come from the database.

### `POST /api/chat`
Request:
```json
{ "message": "How many players live within 1 hour from Ikast?", "conversation_id": "optional – send back the id from the previous reply for follow-ups" }
```
`message` is required, max 500 characters. Follow-ups such as "only the left-footed ones" work when the same `conversation_id` is sent (conversations expire after 30 min).

Response `200`:
```json
{
  "conversation_id": "3f0c…",
  "answer": "86 players match.",
  "intent": "count",                 // count | list | group_count | comment_analysis
  "count": 86,
  "players": [],                     // filled for list / comment_analysis (max 100), each with player_id, report_id, name, position, team_name, location, age_group, overall_score, …
  "groups": [{ "key": "Left back", "count": 12 }],   // only for group_count
  "notes": ["Father's height is recorded for only 8 of 27 players matching your other criteria; players without it are not counted."],
  "assumptions": ["Player locations are municipalities, measured from their centre; driving time is calculated by road routing."],
  "interpreted": ["lives within 60 min drive of Ikast (7 matching locations, routed times)"],   // show this so admins can verify the numbers
  "spec": { "…": "the structured query that was executed" },
  "sent_to_llm": false,              // true only when scout comment text was sent to the AI (comment_analysis)
  "cached": { "plan": false, "result": false },
  "timings": { "llm_ms": 640, "db_ms": 4, "total_ms": 655 }
}
```
Errors: `400` missing/too long message · `422` question could not be turned into a valid query · `502` AI provider failed/timed out · `503` AI provider not configured (no `OPENAI_API_KEY`).

### `GET /api/chat/stream?message=…&conversation_id=…`
Same as above as Server-Sent Events, so the UI can show progress and stream comment analysis:
`event: status` `{text}` → `event: token` `{text}` (only for comment analysis) → `event: result` (same body as POST) or `event: error` `{status, error}`.
