// Golden tests: every chatbot route/intent, with the LLM mocked by fixed plans (tests/fixtures/specs.json) and the
// embedding provider mocked offline. Answers must equal hand-written SQL. Runs against the isolated test database
// prepared by scripts/test-db.js (npm test does this automatically) – your real data is never touched.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db/pool');
const chatPool = require('../src/db/chatPool');
const { ask } = require('../src/chat/service');
const { resolveMeaning } = require('../src/chat/retrieval');
const { embedPending, pendingCount } = require('../src/chat/embedder');
const { getConversation } = require('../src/chat/memory');

const one = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);

test.after(async () => { await pool.end(); await chatPool.end(); });

// ---------------- the five sample questions ----------------
test('Q1 speed + average developed', async () => {
  const r = await ask('How many players have speed and are average developed?');
  const expected = await one(`SELECT COUNT(*) n FROM player_latest pl JOIN reports r ON r.id = pl.report_id
    WHERE r.physical ILIKE '%Pace/speed%' AND pl.stage_of_growth = 'Average developed'`);
  assert.equal(r.route, 'data');
  assert.equal(r.intent, 'count');
  assert.equal(r.count, expected);
  assert.ok(r.count > 0);
});

test('Q2 dribbling as x-factor (full-text, latest report)', async () => {
  const r = await ask('How many players have dribbling as x-factor?');
  assert.equal(r.count, await one(`SELECT COUNT(*) n FROM player_latest WHERE x_factor ILIKE '%dribbl%'`));
});

test('Q3 centre-backs with father taller than 185 (midpoint) + coverage note', async () => {
  const r = await ask("How many players in Player Position Center Back (Right or Left) have Father's height above 185?");
  assert.equal(r.count, await one(`SELECT COUNT(*) n FROM player_latest WHERE position ILIKE '%centre-back%' AND father_height_mid > 185`));
  const cb = await one(`SELECT COUNT(*) n FROM player_latest WHERE position ILIKE '%centre-back%'`);
  const known = await one(`SELECT COUNT(father_height_mid) n FROM player_latest WHERE position ILIKE '%centre-back%'`);
  if (known < cb) assert.match(r.notes.join(' '), new RegExp(`recorded for only ${known} of ${cb}`));
});

test('Q4 within 1 hour of Ikast (cached driving times)', async () => {
  const r = await ask('How many players live within 1 hour from Ikast?');
  const expected = await one(`SELECT COUNT(*) n FROM player_latest pl WHERE pl.location IN
    (SELECT to_place FROM drive_time WHERE lower(from_place) = 'ikast' AND minutes <= 60)`);
  assert.equal(r.count, expected);
  assert.ok(r.count > 0);
});

test('Q5 ball movement: tags OR keywords OR meaning, with evidence per player', async () => {
  const q = 'Find players with ball-movement or moving with the ball';
  const r = await ask(q);
  assert.equal(r.intent, 'list');
  assert.equal(r.approximate, true);
  const m = await resolveMeaning(r.spec.meaning, q);
  assert.ok(m.chunks.length + m.tags.length > 0, 'meaning search found matches');
  const tm = r.spec.text[0].tag_matches.flatMap((x) => x.any_of.map((g) => [x.category, g]));
  assert.ok(tm.some(([, g]) => g === 'Carries the ball forward'), 'keyword "carries the ball" also matches the tag');
  const expected = await one(`SELECT COUNT(*) n FROM player_latest pl WHERE
       pl.player_id IN (SELECT player_id FROM report_tags WHERE category = 'technical' AND tag IN ('Carries the ball forward', 'Carries the ball past the first press'))
    OR pl.player_id IN (SELECT player_id FROM reports WHERE (tsv_x || tsv_c) @@ to_tsquery('english', '(ball <-> movement:*) | (carries <-> the <-> ball:*)'))
    OR pl.player_id IN (SELECT rt.player_id FROM report_tags rt JOIN unnest($4::text[], $5::text[]) t(c, g) ON rt.category = t.c AND rt.tag = t.g)
    OR pl.player_id IN (SELECT player_id FROM report_chunks WHERE chunk_id = ANY($1::bigint[]))
    OR pl.player_id IN (SELECT rt.player_id FROM report_tags rt JOIN unnest($2::text[], $3::text[]) t(c, g) ON rt.category = t.c AND rt.tag = t.g)`,
  [m.chunks.map((c) => c.id), m.tags.map((t) => t.category), m.tags.map((t) => t.tag), tm.map((x) => x[0]), tm.map((x) => x[1])]);
  assert.equal(r.count, expected);
  assert.ok(r.players.length > 0);
  assert.ok(r.players.every((p) => p.match && p.match.text), 'every listed player has a matching snippet');
});

// ---------------- comment search ----------------
test('keyword search: "agility" in any report, stemmed (agile/agility), with highlighted snippets', async () => {
  const r = await ask('For which players is the word agility mentioned by the scout?');
  const tm = r.spec.text[0].tag_matches.flatMap((x) => x.any_of.map((g) => [x.category, g]));
  assert.ok(tm.some(([, g]) => /^Agility/.test(g)), 'agility tags found in the vocabulary');
  const expected = await one(`SELECT COUNT(*) n FROM player_latest pl WHERE
       pl.player_id IN (SELECT player_id FROM reports WHERE (tsv_x || tsv_c) @@ to_tsquery('english', 'agility:*'))
    OR pl.player_id IN (SELECT rt.player_id FROM report_tags rt JOIN unnest($1::text[], $2::text[]) t(c, g) ON rt.category = t.c AND rt.tag = t.g)`,
  [tm.map((x) => x[0]), tm.map((x) => x[1])]);
  assert.equal(r.count, expected);
  assert.ok(r.count > 0);
  assert.equal(r.approximate, false);
  assert.ok(r.players.every((p) => /\*\*agil/i.test(p.match.text) || /tag: Agility/.test(p.match.text)), 'snippet shows the word or the tag');
});

test('meaning count is flagged approximate and only uses AI-verified sentences', async () => {
  const r = await ask('How many players show leadership?');
  assert.equal(r.approximate, true);
  assert.match(r.answer, /^About /);
  assert.match(r.notes.join(' '), /approximate/);
  assert.match(r.assumptions.join(' '), /vector search \+ AI check/);
});

// ---------------- structure, statistics, history ----------------
test('group_count by position sums to total players', async () => {
  const r = await ask('How many players per position?');
  assert.equal(r.groups.reduce((a, g) => a + g.count, 0), r.count);
  assert.equal(r.count, await one('SELECT COUNT(*) n FROM players'));
});

test('report unit: reports per scout sum to all reports', async () => {
  const r = await ask('How many reports did each scout write?');
  assert.equal(r.count, await one('SELECT COUNT(*) n FROM reports'));
  assert.equal(r.groups.reduce((a, g) => a + g.count, 0), r.count);
  assert.match(r.answer, /reports in total/);
});

test('report unit: reports per month is in time order', async () => {
  const r = await ask('Reports per month');
  const keys = r.groups.map((g) => g.key).filter(Boolean);
  assert.deepEqual(keys, [...keys].sort());
});

test('aggregate: average potential per position equals SQL', async () => {
  const r = await ask('Average potential score per position');
  const { rows } = await pool.query(`SELECT position AS key, AVG(overall_potential_score)::float8 AS v FROM player_latest
    GROUP BY 1 HAVING COUNT(overall_potential_score) > 0`);
  const want = new Map(rows.map((x) => [x.key, x.v]));
  assert.equal(r.groups.length, want.size);
  for (const g of r.groups) assert.ok(Math.abs(g.value - want.get(g.key)) < 1e-9, g.key);
});

test('aggregate: highest father height (ungrouped)', async () => {
  const r = await ask("What is the highest father's height?");
  const max = Number((await pool.query('SELECT MAX(father_height_mid)::float8 AS m FROM player_latest')).rows[0].m);
  assert.equal(r.aggregate.value, max);
  assert.match(r.answer, /^Highest father's height: /);
});

test('player-only field on the report unit is ignored with a warning', async () => {
  const r = await ask('How many reports have a report count filter?');
  assert.match(r.assumptions.join(' '), /only available per player/);
});

test('history: a new, better report updates player_latest and "improved the most"', async () => {
  const { rows: [p] } = await pool.query(`SELECT player_id, overall_score FROM player_latest WHERE player_name = 'Player 1'`);
  const { rows: [ins] } = await pool.query(
    `INSERT INTO reports(player_id, report_date, overall_score, overall_comment) VALUES ($1, '2030-01-01', $2, 'Big improvement this season.') RETURNING id`,
    [p.player_id, Math.min((p.overall_score ?? 3) + 2, 10)]);
  try {
    const { rows: [after] } = await pool.query('SELECT report_count, score_change, report_id FROM player_latest WHERE player_id = $1', [p.player_id]);
    assert.equal(after.report_id, ins.id);
    assert.equal(after.report_count, 2);
    assert.ok(after.score_change > 0);
    const { rows: [txt] } = await pool.query(
      `SELECT tsv_c @@ to_tsquery('english', 'improv:*') AS latest, tsv_all_c @@ to_tsquery('english', 'improv:*') AS any FROM player_text WHERE player_id = $1`, [p.player_id]);
    assert.deepEqual(txt, { latest: true, any: true }, 'player_text search vectors follow the new report');
    const r = await ask('Which players have improved the most?');
    assert.ok(r.players.some((x) => x.player_id === p.player_id));
  } finally {
    await pool.query('DELETE FROM reports WHERE id = $1', [ins.id]);
  }
  const { rows: [back] } = await pool.query('SELECT report_count FROM player_latest WHERE player_id = $1', [p.player_id]);
  assert.equal(back.report_count, 1, 'delete trigger restores the row');
});

// ---------------- player profile / compare / judgement ----------------
test('profile: header facts + AI summary citing only that player\'s reports', async () => {
  const r = await ask('Tell me about Player 12');
  assert.equal(r.intent, 'profile');
  assert.equal(r.players.length, 1);
  assert.equal(r.players[0].name, 'Player 12');
  assert.match(r.answer, /\*\*Player 12\*\*/);
  const ids = (await pool.query(`SELECT r.id FROM reports r JOIN players p ON p.id = r.player_id WHERE p.name = 'Player 12'`)).rows.map((x) => x.id);
  assert.deepEqual([...r.sources].sort(), [...ids].sort());
  assert.equal(r.sent_to_llm, true);
});

test('profile: unknown player', async () => {
  const r = await ask('Tell me about Player 99999');
  assert.equal(r.count, 0);
  assert.match(r.answer, /couldn't find a player called “Player 99999”/);
});

test('compare: two players side by side', async () => {
  const r = await ask('Compare Player 12 and Player 40');
  assert.deepEqual(r.players.map((p) => p.name), ['Player 12', 'Player 40']);
  assert.match(r.answer, /\*\*Player 12\*\*[\s\S]*\*\*Player 40\*\*/);
  assert.ok(r.sources.length >= 2);
});

test('comment analysis by score shortlist', async () => {
  const r = await ask('Which player has the best scout comment?');
  assert.equal(r.intent, 'comment_analysis');
  assert.equal(r.sent_to_llm, true);
  assert.match(r.answer, /#\d+/);
});

test('comment analysis by meaning sends the matching reports', async () => {
  const r = await ask('Who is described as the best leader?');
  assert.equal(r.sent_to_llm, true);
  assert.ok(r.sources.length > 0 && r.sources.length <= 8);
  for (const id of r.sources) assert.match(r.answer, new RegExp(`#${id}\\b`));
});

// ---------------- conversation ----------------
test('conversation memory is stored and follow-ups keep the conversation id', async () => {
  const a = await ask('Show the centre-backs');
  const b = await ask('only the left-footed ones', { conversationId: a.conversation_id });
  assert.equal(b.conversation_id, a.conversation_id);
  assert.ok(b.count <= a.count);
  assert.equal(b.count, await one(`SELECT COUNT(*) n FROM player_latest WHERE position ILIKE '%centre-back%' AND lower(strong_foot) = 'left'`));
  const conv = await getConversation(a.conversation_id);
  assert.equal(conv.messages.length, 2);
  assert.equal(conv.messages[0].player_names[0], a.players[0].name);
});

test('an invalid conversation id starts a new conversation', async () => {
  const r = await ask('Hi there!', { conversationId: "x'; DROP TABLE chat_messages; --" });
  assert.match(r.conversation_id, /^[0-9a-f-]{36}$/);
});

// ---------------- non-data routes ----------------
test('general chat: answered without touching the data, labelled as general knowledge', async () => {
  const r = await ask('What is a false nine?');
  assert.equal(r.route, 'general');
  assert.equal(r.spec, null);
  assert.equal(r.count, null);
  assert.match(r.notes.join(' '), /not taken from your scouting data/);
});

test('help route', async () => {
  const r = await ask('What can you do?');
  assert.equal(r.route, 'help');
  assert.ok(r.answer.length > 0);
});

test('clarify and refuse routes return the planner reply', async () => {
  const c = await ask('Show me the good ones');
  assert.equal(c.route, 'clarify');
  assert.match(c.answer, /Good in what way/);
  const d = await ask('Delete Player 12');
  assert.equal(d.route, 'refuse');
  assert.ok(await one(`SELECT COUNT(*) n FROM players WHERE name = 'Player 12'`) === 1);
});

// ---------------- safety ----------------
test('injection + unknown field are neutralised', async () => {
  const r = await ask('injection attempt');
  assert.equal(r.count, 0);
  assert.ok(r.assumptions.some((a) => /unknown filter field/i.test(a)));
  assert.ok(await one('SELECT COUNT(*) n FROM players') > 0, 'players table must still exist');
});

test('chatbot connection is read-only and time-limited', async () => {
  await assert.rejects(() => chatPool.query('DELETE FROM players'), /read-only|permission denied/);
  await assert.rejects(() => chatPool.query('SELECT pg_sleep(4)'), /statement timeout/);
});

test('second identical question is served from cache', async () => {
  await ask('How many players have dribbling as x-factor?');
  const r = await ask('how many players have dribbling as x-factor?  ');
  assert.equal(r.cached.plan, true);
  assert.equal(r.cached.result, true);
});

test('input validation', async () => {
  await assert.rejects(() => ask(''), /message is required/);
  await assert.rejects(() => ask('x'.repeat(501)), /at most 500/);
});

// ---------------- embedding pipeline ----------------
test('new report text is chunked by trigger, embedded by the worker and found by meaning search', async () => {
  const { rows: [p] } = await pool.query(`SELECT id FROM players WHERE name = 'Player 2'`);
  const { rows: [ins] } = await pool.query(
    `INSERT INTO reports(player_id, report_date, overall_comment) VALUES ($1, '2001-01-01', $2) RETURNING id`,
    [p.id, `Remarkable zebracrossing vision when passing, test run ${Date.now()}.`]);
  try {
    assert.ok(await pendingCount() >= 1);
    await embedPending();
    assert.equal(await pendingCount(), 0);
    const m = await resolveMeaning({ query: 'zebracrossing vision', fields: ['comment'] }, 'zebracrossing');
    const { rows } = await pool.query('SELECT report_id FROM report_chunks WHERE chunk_id = ANY($1::bigint[])', [m.chunks.map((c) => c.id)]);
    assert.ok(rows.some((x) => x.report_id === ins.id));
  } finally {
    await pool.query('DELETE FROM reports WHERE id = $1', [ins.id]);
  }
});
