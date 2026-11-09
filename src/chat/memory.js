// Conversation memory in Postgres (chat_conversations / chat_messages): survives restarts and works with
// several API instances. The planner sees the last few turns, including which players were shown, so
// follow-ups like "only the left-footed ones" or "compare the first two" work.
const pool = require('../db/pool');

const TURNS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidId = (id) => typeof id === 'string' && UUID.test(id);

/** -> { turns: [...oldest first], lastSpec } */
async function loadContext(conversationId) {
  if (!isValidId(conversationId)) return { turns: [], lastSpec: null };
  const { rows } = await pool.query(
    `SELECT question, route, intent, spec, result_count AS count, player_names FROM chat_messages
     WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2`, [conversationId, TURNS]);
  const turns = rows.reverse();
  const lastData = [...turns].reverse().find((t) => t.route === 'data' && t.spec);
  return { turns: turns.map(({ spec, ...t }) => t), lastSpec: lastData ? lastData.spec : null };
}

async function saveTurn(conversationId, t) {
  await pool.query(
    `INSERT INTO chat_conversations(id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET updated_at = now()`, [conversationId]);
  await pool.query(
    `INSERT INTO chat_messages(conversation_id, question, route, intent, spec, answer, result_count, player_ids, player_names)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [conversationId, t.question, t.route, t.intent || null, t.spec ? JSON.stringify(t.spec) : null, t.answer || null,
      t.count ?? null, t.playerIds || null, t.playerNames || null]);
}

async function getConversation(conversationId) {
  if (!isValidId(conversationId)) return null;
  const { rows } = await pool.query(
    `SELECT id, question, route, intent, answer, result_count AS count, player_names, created_at FROM chat_messages
     WHERE conversation_id = $1 ORDER BY id`, [conversationId]);
  return rows.length ? { conversation_id: conversationId, messages: rows } : null;
}

module.exports = { loadContext, saveTurn, getConversation, isValidId };
