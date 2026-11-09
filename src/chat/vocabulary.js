// Real values present in the data (tags, positions, ...). Injected into the LLM prompt so it maps
// "speed" -> "Pace/speed" etc., and used to snap/validate tags. Cached; cleared when data changes.
const chatPool = require('../db/chatPool');
const { TAG_CATEGORIES } = require('./spec');

let cache = null;
let loadedAt = 0;
let loading = null;
const TTL = 10 * 60 * 1000;

async function load() {
  const q = async (sql) => (await chatPool.query(sql)).rows;
  const list = async (col, from = 'player_latest') =>
    (await q(`SELECT ${col} AS v FROM ${from} WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 300`)).map((r) => r.v);
  const [tagRows, positions, secondaryPositions, stageOfGrowth, strongFoot, recommendations, ageGroups, locations, scouts] = await Promise.all([
    q('SELECT category, tag, COUNT(*)::int AS n FROM report_tags GROUP BY 1, 2 ORDER BY 1, 3 DESC'),
    list('position'), list('secondary_position'), list('stage_of_growth'), list('strong_foot'), list('recommendation', 'reports'), // all reports: a value used only in older reports is still a real value
    list('age_group'), list('location'), list('name', 'scouts'),
  ]);
  const tags = Object.fromEntries(TAG_CATEGORIES.map((c) => [c, []]));
  for (const r of tagRows) tags[r.category].push({ tag: r.tag, n: r.n });
  return { tags, positions, secondaryPositions, stageOfGrowth, strongFoot, recommendations, ageGroups, locations, scouts };
}

async function getVocabulary() {
  if (!cache || Date.now() - loadedAt > TTL) {
    loading = loading || load().then((v) => { cache = v; loadedAt = Date.now(); return v; }).finally(() => { loading = null; });
    if (!cache) return loading; // first load: wait (errors go to the caller)
    // afterwards: serve the old copy while refreshing; a failed refresh just keeps the old copy
    loading.catch((e) => console.error('vocabulary refresh failed:', e.message));
  }
  return cache;
}

/** Marks the vocabulary stale; the next request refreshes it in the background (the old copy is served meanwhile). */
const invalidateVocabulary = () => { loadedAt = 0; };

module.exports = { getVocabulary, invalidateVocabulary };
