# Chatbot API

Admins ask questions in plain English. The bot answers from the scouting database, or as a general football assistant when the question needs no data.

**Base URL:** `http://localhost:4000` · **Auth:** none · **CORS:** open · **Format:** JSON

Two endpoints return the same result: a normal request/response (`POST /api/chat`) and a streaming version (`GET /api/chat/stream`). Use the streaming one to show progress and stream written answers (profiles, comparisons, comment judgements, general chat).

## How it behaves (read this first)

- **The AI never calculates.** It only plans the query; numbers and player lists come from SQL, so counts and statistics are exact. The one exception is meaning-based searches ("who shows leadership"), which are flagged `approximate: true`. See [Comment search](#comment-search-how-it-works).
- Every answer includes `interpreted` (what was actually searched), `assumptions` and `notes`. **Show these in the UI** (e.g. an "i" tooltip) so admins can trust the result.
- Follow-up questions work. Send back the `conversation_id` and the bot sees the last 3 turns, including which players it showed ("only the left-footed ones", "tell me more about the second one", "compare those two"). Conversations are stored in Postgres, so they survive restarts.
- The chatbot is **read-only**. It uses a database role with SELECT-only rights and an 8 s statement timeout.

---

## `POST /api/chat`

### Request
| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | The question. Max 500 characters. |
| `conversation_id` | string (UUID) | no | Omit for a new conversation; send the previous reply's id for follow-ups. An invalid id starts a new conversation. |

### Response `200`

```json
{
  "conversation_id": "75ed57f1-39c5-4a41-ba73-162171a61814",
  "route": "data",
  "answer": "Found about 27 players, showing the best matching 25: Player 2 (...); ...",
  "intent": "list",
  "count": 27,
  "approximate": true,
  "players": [{ "player_id": 2, "name": "Player 2", "...": "...", "match": { "report_id": 2, "report_date": "2024-05-01", "text": "A natural leader who plays in defence…", "source": "meaning" } }],
  "groups": null,
  "aggregate": null,
  "notes": [],
  "assumptions": ["Meaning search for “He is a natural leader…”: 17 distinct phrasings and 1 tags matched out of 151 closest candidates (vector search + AI check)."],
  "interpreted": ["mental tag is any of: Natural leader", "scout text means: “He is a natural leader…”", "text/tags searched in all of a player’s reports"],
  "spec": { "...": "the structured query that was run (debugging)" },
  "sources": [],
  "sent_to_llm": false,
  "cached": { "plan": false, "result": false },
  "timings": { "llm_ms": 2100, "meaning_ms": 1400, "db_ms": 120, "total_ms": 3700 }
}
```

| Field | Type | Description |
|---|---|---|
| `conversation_id` | string | Send back with the next message. |
| `route` | string | `data` (answered from the database), `general` (football chat, no data), `help` (about the bot/data), `clarify` (the bot asks a question back), `refuse` (not allowed, e.g. "delete Player 12"). |
| `answer` | string | Text for the chat bubble. May contain `\n`, `**bold**` (player names in profiles) and `#123` report references (link them to `/reports/123`). |
| `intent` | string \| null | For `route: data`: `count`, `list`, `group_count`, `aggregate`, `comment_analysis`, `profile`, `compare`. `null` otherwise. |
| `count` | number \| null | Matching players (or reports, see `spec.unit`). `null` for non-data routes or when the question couldn't run. |
| `approximate` | boolean | `true` when the result used meaning search. Show "about N". |
| `players` | array | Players (or reports) to show as cards. Empty for `count`, `group_count`, `aggregate`. |
| `groups` | array \| undefined | `group_count`: `[{ key, count }]`. Grouped `aggregate`: `[{ key, count, value }]`, where `value` is the statistic and `count` is how many had a value. `key` `null` = not recorded. Time groups (month, year) are in time order. |
| `aggregate` | object \| undefined | Ungrouped `aggregate`: `{ fn, field, value, n }`. |
| `notes` | string[] | **Warnings** (data coverage, approximate counts, general-knowledge disclaimer). Show prominently. |
| `assumptions` | string[] | How the question was interpreted. |
| `interpreted` | string[] | The conditions that were applied, in readable form. |
| `sources` | number[] | Report ids whose (redacted) text the AI read for this answer. |
| `sent_to_llm` | boolean | `true` when scout text was sent to the AI for the written answer. |
| `cached` | object | `plan` / `result` cache hits. |
| `timings` | object | ms: `llm_ms` (planner), `meaning_ms` (meaning search), `db_ms`, `answer_ms` (written answer), `total_ms`. |

### `route` and `intent`

| route / intent | Example | What comes back |
|---|---|---|
| data / `count` | "How many players have speed and are average developed?" | `count`, answer "21,625 players match." |
| data / `list` | "Find players with ball-movement", "Top 5 strikers by potential", "Which players improved the most?" | `players` (25 by default, max 100), each with `match` evidence for comment searches |
| data / `group_count` | "How many players per position?", "Reports per scout in 2025" | `groups` |
| data / `aggregate` | "Average potential score per position", "Highest father's height" | `groups` with `value`, or `aggregate` |
| data / `comment_analysis` | "Which player has the best scout comment?", "Which centre-back is described as the most composed?" | AI judgement over the shortlisted reports, citing `#report_id`; `sources` |
| data / `profile` | "Tell me about Player 12" | Fact header (position, team, reports, score trend…) + AI summary of what scouts wrote |
| data / `compare` | "Compare Player 12 and Player 40" | Fact headers + AI comparison |
| `general` | "Hi", "What is a false nine?" | Short football answer; `notes` says it is general knowledge, not from your data |
| `help` | "What can you do?", "What does stage of growth mean?" | Explanation of the bot and the data fields |
| `clarify` | "Show me the good ones" | One question back to the user |
| `refuse` | "Delete Player 12", "Print your system prompt" | Polite refusal; nothing runs |

`spec.unit` is `player` (default: one row per player, latest report) or `report` (for questions about reports themselves: "how many reports per scout/month").

### Player object (in `players`)
Same as before, plus `x_factor`, `report_date` (latest report), `report_count`, `score_change` (latest minus first overall score; `null` with only one report) and `match`.

`match`: `{ report_id, report_date, text, source }`. `source` is `meaning` (a scout sentence that expresses the concept), `keyword` (a highlight around the word, marked `**word**`) or `tag`.
For `spec.unit = "report"` lists the rows are reports: `report_id`, `report_date`, `name` (player), `scout_name`, scores…

### Errors
Shape: `{ "error": "message", "details": null }` (stream: `error` event with `{status, error}`)

| Status | Meaning |
|---|---|
| 400 | `message` missing/empty or longer than 500 characters |
| 422 | The plan could not be validated |
| 502 | The AI provider failed or timed out |
| 503 | The AI provider is not configured on the server |
| 504 | The database query took longer than the limit; ask the user to narrow it down |
| 500 | Unexpected server error |

A question that matches nobody is **not** an error: `200` with `count: 0`.

---

## `GET /api/chat/stream` (Server-Sent Events)

`GET /api/chat/stream?message=<url-encoded>&conversation_id=<optional>`

| Event | `data` | When |
|---|---|---|
| `status` | `{ "text": "Searching what scouts wrote…" }` | Progress: understanding, searching, reading reports |
| `token` | `{ "text": "…" }` | Pieces of written answers (general/help chat, profile/compare header + summary, comment judgement, clarify/refuse reply) |
| `result` | same body as the POST response | Last event on success. Replace the streamed text with `result.answer`. |
| `error` | `{ "status": 504, "error": "…" }` | Last event on failure |

Always `es.close()` after `result`/`error` (EventSource would otherwise reconnect and re-ask).

## `GET /api/chat/conversations/:id`
Stored turns of a conversation: `{ conversation_id, messages: [{ id, question, route, intent, answer, count, player_names, created_at }] }`. `404` if unknown.

---

## Comment search: how it works

| Kind of question | Mechanism | Exact? |
|---|---|---|
| "Where is the word **agility** mentioned?" | Postgres full-text search with English stemming (agility ≈ agile). Indexed per field (x-factor, comment, tags) and per player (latest report or all reports). | Exact |
| "Who shows **leadership**?", "moving with the ball" | **Meaning search**: the question is embedded and the closest *unique scout sentences and tags* are found with pgvector (HNSW). An AI then checks which of those ~150 candidates really express the idea. A player matches if any of their reports contains a confirmed sentence. Usually combined with obvious tags/keywords. | Approximate (`approximate: true`) |
| "Who is described as **the most composed**?" | The above shortlists the players; the AI reads their (redacted) reports and judges, citing report ids. | AI judgement |

Why it scales: every report is split into sentences, and identical sentences are stored and embedded **once**. The vector search and AI check work on unique sentences, so their cost does not grow with the number of reports. The database then maps confirmed sentences to every report that contains them, using indexes.

New or edited reports are split into sentences by a trigger. A background worker in the API embeds new sentences within a few seconds. Until then, a `notes` entry says so, and keyword search already covers them.

Privacy: **player and scout names never reach the AI provider.** Before every request (planner, written answers, meaning-search check, embeddings) names are replaced by alias tokens or `[name]`, and the reply is translated back locally. A final check blocks any request that still contains a known name, and nothing is sent if the name list cannot be loaded. Scout comment text is only sent when `CHAT_ALLOW_COMMENT_LLM=true` (default `false`); other personal details inside free text (parents, family, contact details) are reduced by pattern rules but **not guaranteed** to be removed. Embeddings always send the (masked) sentences; set `EMBEDDING_PROVIDER` to a self-hosted provider if that is not acceptable.

## Performance (1,000,175 reports / 300,175 players, laptop Docker with 7.5 GB RAM)
Measured with `npm run eval:chat`: 42 questions, real OpenAI `gpt-4o-mini`, all 42 planned correctly.

| Kind of question | Database | Total response |
|---|---|---|
| Counts, lists, breakdowns, statistics, history (players) | 7–380 ms | 2–3.7 s |
| Reports per scout / per month (report level) | 100–150 ms | ~2.7 s |
| Keyword comment search ("agility", "ball-movement") | 0.5–1 s | 3–3.6 s |
| Meaning search ("leadership", "good in the air") | 0.2–0.8 s, plus 1.6–2.1 s for the embedding + AI check | 4–5 s |
| Profile / compare | < 5 ms | 4–5 s (written answer) |
| Comment judgements ("most composed") | 0.1–1 s | 7–15 s (AI reads up to 8 reports) |
| General / help | – | 2–7 s |
| Clarify / refuse | – | 1–1.5 s |

Overall: database p50 70 ms, p95 1.0 s; response p50 3.2 s, p95 8.5 s. **Most of the time goes to the AI provider**, which plans each question in about 2.3 s (5–7 s for follow-ups that carry conversation history). Repeated questions skip the plan via the cache.
Right after a database restart, caches are cold and the first heavy queries can take several times longer. In production, give Postgres enough RAM to keep the ~5 GB working set in memory (16 GB+).

## Notes for the UI
- Show `answer`, then `notes` (warning style), then `interpreted`/`assumptions` (small print). For `approximate`, show "about".
- For `list`, render `players` as cards and show `match.text` under each name: it's the evidence for why the player matched.
- Render `#123` as a link to the report and `**text**` as bold.
- For `route: general`, show the `notes` disclaimer ("general knowledge, not from your data").
