// Names to redact before scout text leaves the server: scouts, teams, plus names learned from the data –
// words that appear in the scout sentences ONLY capitalised (never lowercase), e.g. first names like "Alex".
// Cached for an hour; computed in SQL over the unique sentences (text_chunks).
const chatPool = require('../db/chatPool');
const { likelyNames } = require('./redact');

const TTL = 60 * 60 * 1000;
let cache = { at: 0, names: null };
let loading = null;

async function load() {
  const [known, caps] = await Promise.all([
    chatPool.query('SELECT name FROM scouts UNION SELECT name FROM teams'),
    chatPool.query(`SELECT min(w) AS w FROM (
        SELECT regexp_split_to_table(content, '[^[:alpha:]]+') AS w FROM text_chunks WHERE kind = 'text') x
      WHERE length(w) >= 2 GROUP BY lower(w) HAVING bool_and(w ~ '^[[:upper:]][[:lower:]]')`),
  ]);
  return [...known.rows.map((r) => r.name), ...likelyNames(caps.rows.map((r) => r.w))];
}

/** -> string[] (stable array identity while cached, so redact.js can reuse its compiled regex) */
async function redactionNames() {
  if (cache.names && Date.now() - cache.at < TTL) return cache.names;
  loading = loading || load().then((names) => { cache = { at: Date.now(), names }; return names; }).finally(() => { loading = null; });
  return loading;
}
const clearNames = () => { cache = { at: 0, names: null }; };

module.exports = { redactionNames, clearNames };
