// Meaning-based retrieval over scout text.
//  1. embed the planner's meaning query (a sentence a scout might write)
//  2. vector search (HNSW) over UNIQUE sentences and tag values -> top candidates
//  3. an LLM checks which candidates really express the concept (precision); vector similarity alone is not
//     reliable enough (unrelated sentences often score as high as relevant ones)
//  4. the verified sentence/tag ids are used as a SQL condition: a report matches if it contains one of them
// Because candidates are unique sentences, the cost of steps 1-3 does not grow with the number of reports.
const chatPool = require('../db/chatPool');
const { embed, toSql } = require('./embeddings');
const { getLlm } = require('./llm');
const { redactComment } = require('./redact');
const { redactionNames } = require('./names');
const { tsQueryText, fieldCols } = require('./fts');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const cfg = () => ({
  textCandidates: num(process.env.CHAT_MEANING_CANDIDATES, 150),
  tagCandidates: 20,
  floor: num(process.env.CHAT_MEANING_FLOOR, 0.4),
  tagFloor: num(process.env.CHAT_MEANING_TAG_FLOOR, 0.45),
  verify: String(process.env.CHAT_MEANING_VERIFY ?? 'true').toLowerCase() !== 'false'
    && String(process.env.CHAT_ALLOW_COMMENT_LLM ?? 'false').toLowerCase() === 'true',
});

const cache = new Map(); // key -> { exp, v }
const TTL = 10 * 60 * 1000;
function cached(key, fn) {
  const e = cache.get(key);
  if (e && e.exp > Date.now()) return e.v;
  const v = fn().catch((err) => { cache.delete(key); throw err; });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, { exp: Date.now() + TTL, v });
  return v;
}
const clearRetrievalCache = () => cache.clear();

const knownNames = redactionNames; // scouts, teams + names learned from the data (names.js)

/**
 * Resolves spec.meaning to concrete matches.
 * Returns { chunks: [{id, sim}], tags: [{category, tag, sim}], candidates, verified, method, ms }
 */
function resolveMeaning(meaning, question) {
  const key = JSON.stringify([meaning.query, meaning.fields, question, cfg()]);
  return cached(key, () => doResolve(meaning, question));
}

async function doResolve(meaning, question) {
  const c = cfg();
  const ms = {};
  let t = Date.now();
  const [qv] = await embed([meaning.query]);
  ms.embed = Date.now() - t;
  const vec = toSql(qv);
  const wantText = meaning.fields.some((f) => ['any', 'x_factor', 'comment'].includes(f));
  const wantTags = meaning.fields.some((f) => ['any', 'tags'].includes(f));

  t = Date.now();
  const [textRows, tagRows] = await Promise.all([
    wantText ? chatPool.query(
      `SELECT id, content, 1 - (embedding <=> $1::halfvec) AS sim FROM text_chunks
       WHERE kind = 'text' AND embedding IS NOT NULL ORDER BY embedding <=> $1::halfvec LIMIT $2`, [vec, c.textCandidates]).then((r) => r.rows) : [],
    wantTags ? chatPool.query(
      `SELECT id, category, content, 1 - (embedding <=> $1::halfvec) AS sim FROM text_chunks
       WHERE kind = 'tag' AND embedding IS NOT NULL ORDER BY embedding <=> $1::halfvec LIMIT $2`, [vec, c.tagCandidates]).then((r) => r.rows) : [],
  ]);
  ms.search = Date.now() - t;
  const texts = textRows.filter((r) => r.sim >= c.floor).sort((a, b) => b.sim - a.sim);
  const tags = tagRows.filter((r) => r.sim >= c.tagFloor).sort((a, b) => b.sim - a.sim);
  const candidates = texts.length + tags.length;

  let keepText, keepTags, verified = false, method;
  if (c.verify && candidates) {
    t = Date.now();
    try {
      const names = await knownNames();
      const passages = [
        ...texts.map((r) => ({ kind: 'text', row: r, text: redactComment(r.content, names) })),
        ...tags.map((r) => ({ kind: 'tag', row: r, text: `${r.category} attribute tag: ${r.content}` })),
      ];
      const ok = new Set();
      const BATCH = 60;
      const batches = [];
      for (let i = 0; i < passages.length; i += BATCH) batches.push(passages.slice(i, i + BATCH));
      const results = await Promise.all(batches.map((b) => getLlm().verifyPassages({
        question, concept: meaning.query, passages: b.map((p, i) => ({ n: i + 1, text: p.text })),
      })));
      results.forEach((nums, bi) => nums.forEach((n) => { const p = batches[bi][n - 1]; if (p) ok.add(p); }));
      keepText = texts.filter((r) => [...ok].some((p) => p.row === r));
      keepTags = tags.filter((r) => [...ok].some((p) => p.row === r));
      verified = true;
      method = 'vector search + AI check';
    } catch (e) {
      console.error('meaning verification failed:', e.message);
    }
    ms.verify = Date.now() - t;
  }
  if (!verified) {
    // Similarity-only fallback: keep the clear winners only (close to the best score).
    const topText = texts[0] ? texts[0].sim : 1;
    const topTag = tags[0] ? tags[0].sim : 1;
    keepText = texts.filter((r) => r.sim >= Math.max(c.floor + 0.12, topText - 0.08));
    keepTags = tags.filter((r) => r.sim >= Math.max(c.tagFloor + 0.1, topTag - 0.06));
    method = 'vector similarity only';
  }
  return {
    query: meaning.query,
    fields: meaning.fields,
    chunks: keepText.map((r) => ({ id: Number(r.id), sim: r.sim, content: r.content })),
    tags: keepTags.map((r) => ({ category: r.category, tag: r.content, sim: r.sim })),
    candidates,
    verified,
    method,
    ms,
  };
}

/**
 * Evidence for the listed rows: the best matching sentence / keyword hit / tag per player (or report).
 * keyCol: 'player_id' (player unit) | 'report_id' (report unit). reportIds: restrict to these reports (latest scope).
 * Returns Map(key -> { report_id, report_date, text, source })
 */
async function snippets({ keys, keyCol, reportIds, meaningRes, text, tags }) {
  const out = new Map();
  if (!keys.length) return out;
  const put = (rows, source, fmt) => rows.forEach((r) => { if (!out.has(r.k)) out.set(r.k, { report_id: r.report_id, report_date: r.report_date, text: fmt(r), source }); });
  const restrict = (alias, params) => (reportIds ? ` AND ${alias}.report_id = ANY($${params.push(reportIds)}::int[])` : '');
  const kc = keyCol === 'report_id' ? 'report_id' : 'player_id';

  if (meaningRes && meaningRes.chunks.length) {
    const p = [keys, meaningRes.chunks.map((c) => c.id), meaningRes.chunks.map((c) => c.sim)];
    const textFields = meaningRes.fields.filter((f) => f === 'x_factor' || f === 'comment');
    const fieldCond = meaningRes.fields.includes('any') || !textFields.length ? ''
      : ` AND rc.field = ANY($${p.push(textFields)}::text[])`;
    const { rows } = await chatPool.query(
      `SELECT DISTINCT ON (rc.${kc}) rc.${kc} AS k, rc.report_id, r.report_date, tc.content
       FROM report_chunks rc JOIN unnest($2::bigint[], $3::float8[]) m(id, sim) ON m.id = rc.chunk_id
       JOIN text_chunks tc ON tc.id = rc.chunk_id JOIN reports r ON r.id = rc.report_id
       WHERE rc.${kc} = ANY($1::int[])${fieldCond}${restrict('rc', p)}
       ORDER BY rc.${kc}, m.sim DESC, r.report_date DESC NULLS LAST`, p);
    put(rows, 'meaning', (r) => r.content);
  }
  for (const t of text || []) {
    const q = tsQueryText(t.any_of);
    if (!q || !t.fields.length) continue;
    const p = [keys.filter((k) => !out.has(k)), q];
    if (!p[0].length) break;
    const rk = kc === 'report_id' ? 'id' : 'player_id';
    const cols = fieldCols(t.fields);
    const src = { x: 'r.x_factor', c: 'r.overall_comment', t: "concat_ws(', ', r.physical, r.mental, r.technical, r.tactical, r.deadball)" };
    const { rows } = await chatPool.query(
      `SELECT DISTINCT ON (r.${rk}) r.${rk} AS k, r.id AS report_id, r.report_date,
         ts_headline('english', concat_ws(' — ', ${cols.map((c) => src[c]).join(', ')}),
           to_tsquery('english', $2), 'MaxFragments=1, MaxWords=24, MinWords=8, StartSel=**, StopSel=**') AS snippet
       FROM reports r WHERE r.${rk} = ANY($1::int[]) AND (${cols.map((c) => `r.tsv_${c} @@ to_tsquery('english', $2)`).join(' OR ')})
         ${reportIds ? ` AND r.id = ANY($${p.push(reportIds)}::int[])` : ''}
       ORDER BY 1, ts_rank(${cols.map((c) => `r.tsv_${c}`).join(' || ')}, to_tsquery('english', $2)) DESC, r.report_date DESC NULLS LAST`, p);
    put(rows, 'keyword', (r) => r.snippet);
  }
  const tagPairs = [
    ...(meaningRes ? meaningRes.tags.map((t) => [t.category, t.tag]) : []),
    ...(tags || []).flatMap((t) => t.any_of.map((x) => [t.category, x])),
    ...(text || []).flatMap((t) => (t.tag_matches || []).flatMap((m) => m.any_of.map((x) => [m.category, x]))),
  ];
  const rest = keys.filter((k) => !out.has(k));
  if (tagPairs.length && rest.length) {
    const p = [rest, tagPairs.map((x) => x[0]), tagPairs.map((x) => x[1])];
    const { rows } = await chatPool.query(
      `SELECT DISTINCT ON (rt.${kc}) rt.${kc} AS k, rt.report_id, r.report_date, rt.category, rt.tag
       FROM report_tags rt JOIN unnest($2::text[], $3::text[]) m(cat, tag) ON rt.category = m.cat AND rt.tag = m.tag
       JOIN reports r ON r.id = rt.report_id
       WHERE rt.${kc} = ANY($1::int[])${restrict('rt', p)}
       ORDER BY rt.${kc}, r.report_date DESC NULLS LAST`, p);
    put(rows, 'tag', (r) => `${r.category} tag: ${r.tag}`);
  }
  return out;
}

/** Number of sentences/tags still waiting for an embedding (shown as a note when > 0). */
async function pendingEmbeddings() {
  return Number((await chatPool.query('SELECT COUNT(*) AS n FROM text_chunks WHERE embedding IS NULL')).rows[0].n);
}

module.exports = { resolveMeaning, snippets, pendingEmbeddings, clearRetrievalCache };
