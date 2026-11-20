const crypto = require('crypto');
const chatPool = require('../db/chatPool');
const { getLlm } = require('./llm');
const { normalizePlan, SpecError, FIELDS } = require('./spec');
const { carryFollowUp, defaultTextScope, collapseNameFilters, defaultRecommendationScope, mergeAdjacentNames, toCompareReports, explainToAnalysis, nameFiltersNeedAName, pickOption, ageBandFromWords, mergePositionAlternatives, dropTextRepeatingTags, rankAmongPlayers, addToPreviousSet, focusSetFromContext, scoutsOfPreviousPlayers, ensureFootFilter, showAllThenRank, reportTypeFromWords } = require('./followup');
const { foldText, foldSql, containsPattern, editDistance } = require('./fold');
const { getMasker, aliasPlayer } = require('./privacy');
const { getVocabulary, invalidateVocabulary } = require('./vocabulary');
const { buildQueries } = require('./builder');
const { locationsWithin } = require('./geo');
const { redactComment } = require('./redact');
const { redactionNames } = require('./names');
const { resolveMeaning, snippets, pendingEmbeddings, clearRetrievalCache } = require('./retrieval');
const memory = require('./memory');
const { GENERAL_SYSTEM, helpSystem, JUDGE_SYSTEM, PROFILE_SYSTEM, COMPARE_SYSTEM, COMPARE_REPORTS_SYSTEM } = require('./llm/prompt');

const SPEC_TTL = (Number(process.env.CHAT_SPEC_CACHE_TTL_SECONDS) || 3600) * 1000;
const RESULT_TTL = (Number(process.env.CHAT_RESULT_CACHE_TTL_SECONDS) || 60) * 1000;
const MAX_MESSAGE = 500;
const commentsAllowed = () => String(process.env.CHAT_ALLOW_COMMENT_LLM ?? 'false').toLowerCase() === 'true';

class ChatError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- small TTL caches (in-memory, per instance) ----
class TtlCache {
  constructor(ttl, max = 500) { this.ttl = ttl; this.max = max; this.m = new Map(); }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k, v) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(k, { v, exp: Date.now() + this.ttl });
  }
  clear() { this.m.clear(); }
}
const planCache = new TtlCache(SPEC_TTL);
const resultCache = new TtlCache(RESULT_TTL);

const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
const normQ = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const fmt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;

/** Call after any data change (see server.js) so answers never go stale. */
function clearCaches() {
  require('./privacy').clearPrivacyCache(); // a new/renamed player or scout must be masked from the next request on
  resultCache.clear();
  clearRetrievalCache();
  invalidateVocabulary();
}

// ---- human-readable description of what was executed (shown to the admin) ----
const OP_TEXT = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', is_null: 'is empty', not_null: 'is recorded' };
function describe(spec, near, meaningRes) {
  const out = [];
  if (spec.unit === 'report') out.push('counting individual reports');
  out.push(...spec.filters.map((f) => (['is_null', 'not_null'].includes(f.op) ? `${f.field} ${OP_TEXT[f.op]}` : f.op === 'contains_any' ? `${f.field} contains ${[].concat(f.value).join(' or ')}` : f.op === 'u_age' ? `age group U${f.value}` : `${f.field} ${OP_TEXT[f.op]} ${f.value}${f.field === 'recommendation' && f.op === 'eq' && spec.unit === 'player' ? (spec.recommendation_scope === 'latest' ? ' (in the latest report)' : ' (in any report)') : ''}`)));
  if (spec.players.length) out.push(`players: ${spec.players.join(', ')}`);
  spec.tags.forEach((t) => out.push(`${t.category} tag is any of: ${t.any_of.join(' / ')}`));
  spec.text.forEach((t) => {
    const where = [t.fields.length ? `${t.fields.join('/')} text` : null,
      (t.tag_matches || []).length ? `tags ${t.tag_matches.flatMap((m) => m.any_of).join(' / ')}` : null].filter(Boolean);
    out.push(`${where.join(' or ') || '(nothing searchable)'} contains the word(s): ${t.any_of.join(', ')}`);
  });
  if (spec.meaning) {
    out.push(`scout text means: “${spec.meaning.query}”${meaningRes ? ` (${meaningRes.chunks.length} matching phrasings, ${meaningRes.tags.length} tags; ${meaningRes.method})` : ''}`);
  }
  const nContent = spec.tags.length + spec.text.length + (spec.meaning ? 1 : 0);
  if (nContent > 1) out.push(`(tag/text/meaning conditions combined with ${spec.content_logic === 'any' ? 'OR' : 'AND'})`);
  if (nContent && spec.unit === 'player') out.push(spec.content_scope === 'all' ? 'text/tags searched in all of a player’s reports' : 'text/tags searched in the latest report');
  if (near) out.push(`lives within ${spec.near.max_minutes} min drive of ${near.place} (${near.locations.length} matching locations, ${near.source === 'estimate' ? 'estimated' : 'routed'} times)`);
  if (spec.aggregate) out.push(`${spec.aggregate.fn} of ${spec.aggregate.field}`);
  if (spec.group_by) out.push(`grouped by ${spec.group_by}`);
  if (spec.sort) out.push(`sorted by ${spec.sort.field} ${spec.sort.direction}`);
  return out;
}

const FIELD_LABEL = { father_height: "Father's height", mother_height: "Mother's height", height_now: 'Current height',
  stage_of_growth: 'Stage of growth', strong_foot: 'Strong foot', overall_potential_score: 'Potential score', overall_score: 'Overall score',
  secondary_position: 'Secondary position', jersey_number: 'Jersey number', score_change: 'Score change', report_count: 'Number of reports' };
const label = (f) => FIELD_LABEL[f] || f.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** When nothing matched and a numeric filter lies outside the recorded range, say so ("tallest recorded: 175.5 cm"). */
async function rangeNotes(spec, unit) {
  const OPTEXT = { gt: 'above', gte: 'at least', lt: 'below', lte: 'at most' };
  const out = [];
  const nums = spec.filters.filter((f) => FIELDS[f.field] && FIELDS[f.field].kind === 'num' && OPTEXT[f.op]).slice(0, 2);
  for (const f of nums) {
    const col = FIELDS[f.field].col; // from the field whitelist, never from user text
    const { rows } = await chatPool.query(`SELECT min(${col}) AS lo, max(${col}) AS hi FROM ${spec.unit === 'report' ? 'report_facts' : 'player_latest'} WHERE ${col} IS NOT NULL`);
    const lo = Number(rows[0].lo), hi = Number(rows[0].hi), v = Number(f.value);
    if (rows[0].lo == null) continue;
    const outside = (f.op === 'gt' && v >= hi) || (f.op === 'gte' && v > hi) || (f.op === 'lt' && v <= lo) || (f.op === 'lte' && v < lo);
    if (outside) out.push(`No ${unit} has ${label(f.field).toLowerCase()} ${OPTEXT[f.op]} ${fmt(v)}: recorded values range from ${fmt(lo)} to ${fmt(hi)}.`);
  }
  return out;
}

function coverageNotes(coverage, unit) {
  return coverage.filter((c) => c.known < c.total).map((c) =>
    `${label(c.field)} is recorded for only ${fmt(c.known)} of ${fmt(c.total)} ${unit}s matching your other criteria; ${unit}s without it are not counted.`);
}

const playerLine = (p) => {
  const bits = [p.position, p.team_name, p.location].filter(Boolean).join(', ');
  const score = p.overall_score != null ? ` – score ${p.overall_score}${p.overall_potential_score != null ? `/potential ${p.overall_potential_score}` : ''}` : '';
  const mins = p.drive_minutes != null ? ` (${Math.round(p.drive_minutes)} min)` : '';
  return `${p.name}${bits ? ` (${bits})` : ''}${score}${mins}`;
};
const kindOf = (r) => (r.report_type === 'feedback' ? `feedback${r.scout_name ? ` by coach ${r.scout_name}` : ''}` : `assessment${r.scout_name ? ` by ${r.scout_name}` : ''}`);
const reportLine = (r) => `#${r.report_id} ${r.report_date || 'undated'} – ${r.name} (${kindOf(r)})${r.overall_score != null ? `, score ${r.overall_score}` : ''}`;
const round = (v) => (v == null ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(2)).toString());

// ---- planning ----
async function plan(message, context, vocab, timings) {
  const key = normQ(message) + (context.turns.length ? `|${hash(context)}` : '');
  const cached = planCache.get(key);
  if (cached) return { ...cached, planCached: true };

  // A message that is only a name ("Andre Kronborg") reaches the AI as opaque tokens it cannot interpret: plan it here.
  const bare = getLlm().name === 'openai' ? (await getMasker()).bareName(message) : null;
  if (bare) {
    const wantsReports = context.turns.slice(-2).some((t) => /\breports?\b/i.test(t.question || ''));
    const result = normalizePlan({ route: 'data', reply: null, spec: { intent: 'list', unit: wantsReports ? 'report' : 'player', filters: bare.map((w) => ({ field: 'player_name', op: 'contains', value: w })),
      tags: [], text: [], meaning: null, content_logic: 'all', content_scope: 'latest', near: null, players: [], group_by: null, aggregate: null, sort: null, limit: null,
      assumptions: [wantsReports ? 'Treated your message as a player name and listed that player’s reports.' : 'Treated your message as a player name.'] } }, vocab);
    return { ...result, planCached: false };
  }

  const t0 = Date.now();
  let raw;
  try {
    raw = await getLlm().plan({ question: message, context, vocab });
  } catch (e) {
    if (e.code === 'LLM_NOT_CONFIGURED') throw new ChatError(503, 'The AI provider is not configured (missing OPENAI_API_KEY).');
    console.error('LLM plan failed:', e.message);
    throw new ChatError(502, 'The AI provider could not interpret the question right now. Please try again.');
  }
  timings.llm_ms = Date.now() - t0;
  const masker = getLlm().name === 'openai' ? await getMasker() : null;
  const maskFn = masker ? (t) => masker.mask(t, { allowParts: true }) : null; // names are only masked when text goes to the AI provider
  let result = defaultRecommendationScope(message, explainToAnalysis(message, rankAmongPlayers(message, toCompareReports(message, collapseNameFilters(defaultTextScope(message, carryFollowUp(message, context.lastSpec, focusSetFromContext(message, context, nameFiltersNeedAName(message, mergeAdjacentNames(message, ageBandFromWords(message, dropTextRepeatingTags(mergePositionAlternatives(normalizePlan(raw, vocab))))), context.lastSpec, maskFn, vocab)))), context.lastSpec)))));
  result = reportTypeFromWords(message, showAllThenRank(message, ensureFootFilter(message, result, vocab)));
  // "Why not <player>?": add that player to the previous list and rank everyone together
  const mentioned = masker ? (masker.mask(message, { allowParts: true }).match(/\u27E6P\d+\u27E7/g) || []).map((t) => masker.unmask(t)) : [];
  const add = addToPreviousSet(message, context, mentioned);
  if (add) {
    result = normalizePlan({ route: 'data', reply: null, spec: { intent: add.intent, unit: 'player', filters: [], tags: [], text: [], meaning: null, content_logic: 'all', content_scope: 'latest', near: null,
      players: add.players, group_by: null, aggregate: null, sort: { field: 'overall_score', direction: 'desc' }, limit: add.players.length,
      assumptions: [`Added ${mentioned[0]} to the players of the previous answer and ranked all ${add.players.length} together.`] } }, vocab);
  }
  // "Who were the scouts who found these players?": count the reports of the previous answer's players by scout
  const sc = scoutsOfPreviousPlayers(message, context);
  if (sc) {
    result = normalizePlan({ route: 'data', reply: null, spec: { intent: 'group_count', unit: 'report', filters: [], tags: [], text: [], meaning: null, content_logic: 'all', content_scope: 'latest', near: null,
      players: sc.players, group_by: 'scout_name', aggregate: null, sort: null, limit: null,
      assumptions: ['Counted the reports on the players of your previous answer by scout.'] } }, vocab);
    if (sc.recommendation && result.spec) result.spec.recommendation_note = sc.recommendation;
  }
  // a name shared by several people ("Carl") reaches the planner masked as [name]: ask which one is meant
  if (result.route === 'data' && result.spec && (result.spec.players || []).some((p) => /\[name\]/.test(p))) {
    const names = (await getMasker()).ambiguous(message);
    result = { route: 'clarify', reply: names.length ? `Which player do you mean? Several match: ${names.join(', ')}.` : 'Which player do you mean? Please use the full name.', spec: null };
  }
  planCache.set(key, result);
  return { ...result, planCached: false };
}

async function llmText(args, fallback) {
  try {
    return { text: await getLlm().complete(args), ok: true };
  } catch (e) {
    console.error('LLM completion failed:', e.message);
    return { text: fallback, ok: false };
  }
}

// ---- data helpers ----
async function execute(q) {
  const [count, groups, list, agg, coverage] = await Promise.all([
    chatPool.query(q.countSql, q.params).then((r) => r.rows[0].count),
    q.groupSql ? chatPool.query(q.groupSql, q.params).then((r) => r.rows) : null,
    q.listSql ? chatPool.query(q.listSql, q.listParams).then((r) => r.rows) : null,
    q.aggSql ? chatPool.query(q.aggSql, q.params).then((r) => r.rows[0]) : null,
    Promise.all(q.coverage.map((c) => chatPool.query(c.sql, c.params).then((r) => ({ field: c.field, ...r.rows[0] })))),
  ]);
  return { count, groups, rows: list, agg, coverage };
}

/** names -> { ids, missing: [name], ambiguous: [{name, options}] } */
/** "Player Jonas Lindqvist", “Jonas Lindqvist” or 'anna testsen.' -> "Jonas Lindqvist". A leading "Player" is dropped unless a number follows ("Player 12"). */
const cleanPlayerName = (name) => String(name).replace(/[\u201C\u201D\u201E"'`]/g, ' ').replace(/^\s*player\s+(?!\d)/i, '').replace(/[.,;:!?]+\s*$/, '').replace(/\s+/g, ' ').trim();
const likePattern = (s) => `%${s.replace(/[%_\\]/g, ' ').trim()}%`;

/** A name typed into the wrong field ("Kronborg" as a town or club) is a player name when no town/club has that value. */
async function fixMisfiledNames(spec) {
  const FIELD_SQL = { location: ['players', 'location'], team_name: ['teams', 'name'], scout_name: ['scouts', 'name'] };
  for (const f of spec.filters || []) {
    const src = FIELD_SQL[f.field];
    if (!src || !['eq', 'contains'].includes(f.op) || foldText(f.value).length < 3) continue;
    const own = await chatPool.query(`SELECT 1 FROM ${src[0]} WHERE ${foldSql(src[1])} LIKE $1 LIMIT 1`, [containsPattern(f.value)]);
    if (own.rowCount) continue;
    const asName = await chatPool.query(`SELECT 1 FROM players WHERE ${foldSql('name')} LIKE $1 LIMIT 1`, [containsPattern(f.value)]);
    if (asName.rowCount) { f.field = 'player_name'; f.op = 'contains'; spec.assumptions = [...(spec.assumptions || []), `“${f.value}” is a player name, not a ${f.field === 'location' ? 'town' : 'club'}.`].slice(0, 8); }
  }
}

const NAME_SOURCES = `SELECT name AS v, 'player' AS kind, ${foldSql('name')} AS fv FROM players
    UNION ALL SELECT name, 'scout', ${foldSql('name')} FROM scouts
    UNION ALL SELECT name, 'club', ${foldSql('name')} FROM teams
    UNION ALL SELECT DISTINCT location, 'town', ${foldSql('location')} FROM players WHERE location IS NOT NULL`;
const KIND_ORDER = { player: 0, scout: 1, town: 2, club: 3 };

/** Names/towns/clubs spelled like the typed word: one or two wrong or swapped letters, or similar by trigram. [{ v, kind }] */
async function nearMatches(term, { playersOnly = false } = {}) {
  const ft = foldText(term);
  if (ft.length < 3) return [];
  const src = playersOnly ? `SELECT name AS v, 'player' AS kind, ${foldSql('name')} AS fv FROM players` : NAME_SOURCES;
  const { rows } = await chatPool.query(`SELECT v, kind, fv, word_similarity($1, fv) AS sim FROM (${src}) x`, [ft]);
  const maxD = ft.length >= 6 ? 2 : 1;
  const hits = [];
  for (const r of rows) {
    const d = Math.min(...r.fv.split(/[\s-]+/).filter(Boolean).map((w) => editDistance(ft, w)));
    if (d <= maxD || Number(r.sim) >= 0.5) hits.push({ v: r.v, kind: r.kind, score: d <= maxD ? d : 3 - Number(r.sim) });
  }
  return hits.sort((a, b) => a.score - b.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.v.localeCompare(b.v)).slice(0, 5);
}

// words of all names, scouts, clubs and towns (accent-folded) -> the entries that contain them; refreshed every 5 minutes
let wordIndex = { at: 0, map: null };
async function nameWordIndex() {
  if (wordIndex.map && Date.now() - wordIndex.at < 5 * 60 * 1000) return wordIndex.map;
  const { rows } = await chatPool.query(`SELECT v, kind, fv FROM (${NAME_SOURCES}) x`);
  const map = new Map();
  for (const r of rows) for (const w of r.fv.split(/[\s-]+/).filter((x) => x.length >= 3)) {
    if (!map.has(w)) map.set(w, []);
    map.get(w).push({ v: r.v, kind: r.kind });
  }
  wordIndex = { at: Date.now(), map };
  return map;
}

/**
 * "Show me all the reports for Krnoborg": a capitalised word that is no name, town, club or scout but is one slip (a wrong or swapped letter)
 * away from one is a typo. Returns the "Did you mean ...?" question, or null. Words that are valid, or that start a name ("Kron"), pass.
 */
// ordinary football / data words that must never be taken for a misspelled name ("Center Back" is not "Bach")
const COMMON_WORDS = new Set(('center centre back left right winger striker midfielder midfield goalkeeper keeper defender defence defense forward attacker attacking ' +
  'position positions player players father mother height potential overall score scores golden needs scout scouts recommends recommendation recommendations ' +
  'watched again developed development stage growth report reports speed natural leader danish denmark highest lowest average ranking compare strong weak ' +
  'physical mental technical tactical deadball team teams latest current mentioned assessed under over than best top worst foot footed centre-back').split(' '));
const vocabWords = new WeakMap();
function knownVocabWords(vocab) {
  if (!vocab) return COMMON_WORDS;
  if (vocabWords.has(vocab)) return vocabWords.get(vocab);
  const all = [...(vocab.positions || []), ...(vocab.secondaryPositions || []), ...(vocab.stageOfGrowth || []), ...(vocab.strongFoot || []), ...(vocab.recommendations || []),
    ...Object.values(vocab.tags || {}).flat().map((t) => t.tag)];
  const set = new Set(COMMON_WORDS);
  for (const phrase of all) for (const w of foldText(phrase).split(/[^a-z0-9]+/).filter(Boolean)) set.add(w);
  vocabWords.set(vocab, set);
  return set;
}

async function typoInMessage(message, vocab) {
  const tokens = String(message).match(/[\p{L}][\p{L}'-]*/gu) || [];
  if (!tokens.length) return null;
  const map = await nameWordIndex();
  const known = knownVocabWords(vocab);
  const keys = [...map.keys()];
  const parts = [];
  for (let i = 0; i < tokens.length && parts.length < 2; i++) {
    const w = tokens[i];
    if (w.length < 5 || w[0] !== w[0].toUpperCase() || w === w.toUpperCase()) continue; // capitalised word of 5+ letters, not an acronym
    if (i === 0 && tokens.length > 1) continue; // sentence start: "Show", "Compare" ...
    const fw = foldText(w);
    if (known.has(fw) || map.has(fw) || keys.some((k) => k.startsWith(fw))) continue; // a data/football word, a real name, or the start of one
    const maxD = fw.length >= 8 ? 2 : 1;
    const hits = [];
    for (const k of keys) if (Math.abs(k.length - fw.length) <= maxD && editDistance(fw, k) <= maxD) hits.push(...map.get(k));
    const seen = new Set();
    const uniq = hits.filter((h) => (seen.has(h.v) ? false : seen.add(h.v) && true)).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.v.localeCompare(b.v)).slice(0, 5);
    if (uniq.length) parts.push(`I couldn't find “${w}”. Did you mean ${uniq.map((h) => `${h.v}${h.kind === 'player' ? '' : ` (${h.kind})`}`).join(', ')}?`);
  }
  return parts.length ? parts.join(' ') : null;
}

/** Zero results and a typed name/town/club that matches nothing: offer the closest spellings ("Did you mean ...?"). */
async function typoSuggestions(spec) {
  const NAME_FIELDS = ['player_name', 'scout_name', 'team_name', 'location'];
  const terms = [...new Set((spec.filters || []).filter((f) => NAME_FIELDS.includes(f.field) && ['eq', 'contains'].includes(f.op)).map((f) => String(f.value)))].filter((t) => foldText(t).length >= 3);
  // a two-word name with one typo ('Andre Kronbrog'): look at every word on its own
  const words = [...new Set(terms.flatMap((t) => t.split(/[\s-]+/)).filter((w) => foldText(w).length >= 3))];
  const parts = [];
  for (const term of words.slice(0, 3)) {
    const valid = await chatPool.query(`SELECT 1 FROM (${NAME_SOURCES}) x WHERE fv LIKE $1 LIMIT 1`, [containsPattern(term)]);
    if (valid.rowCount) continue; // the value exists: the empty result has another cause
    const near = await nearMatches(term);
    if (near.length) parts.push(`I couldn't find “${term}”. Did you mean ${near.map((r) => `${r.v}${r.kind === 'player' ? '' : ` (${r.kind})`}`).join(', ')}?`);
  }
  return parts.length ? parts.join(' ') : null;
}

async function resolvePlayers(names) {
  const ids = [], missing = [], ambiguous = [], suggestions = {};
  for (const typed of names) {
    const name = cleanPlayerName(typed) || String(typed).trim();
    const exact = await chatPool.query(`SELECT player_id, player_name FROM player_latest WHERE ${foldSql('player_name')} = $1 LIMIT 2`, [foldText(name)]);
    if (exact.rows.length === 1) { ids.push(exact.rows[0].player_id); continue; }
    let found = (await chatPool.query(
      `SELECT player_id, player_name FROM player_latest WHERE ${foldSql('player_name')} LIKE $1 ORDER BY length(player_name), player_name LIMIT 6`, [containsPattern(name)])).rows;
    // words in any order ("Ravn Jonas") or with a typo in one word: every word of 3+ letters must appear in the name
    const words = name.split(/[\s\-]+/).filter((w) => w.length >= 3);
    if (!found.length && words.length > 1) {
      found = (await chatPool.query(
        `SELECT player_id, player_name FROM player_latest WHERE ${words.map((_, i) => `${foldSql('player_name')} LIKE $${i + 1}`).join(' AND ')} ORDER BY length(player_name), player_name LIMIT 6`,
        words.map(containsPattern))).rows;
    }
    if (found.length === 1) ids.push(found[0].player_id);
    else if (!found.length) {
      missing.push(typed);
      if (words.length) { // "did you mean": players sharing any word with what was typed
        const sim = await chatPool.query(
          `SELECT player_name FROM player_latest WHERE ${words.map((_, i) => `${foldSql('player_name')} LIKE $${i + 1}`).join(' OR ')} ORDER BY length(player_name), player_name LIMIT 3`, words.map(containsPattern));
        if (sim.rows.length) suggestions[typed] = sim.rows.map((r) => r.player_name);
      }
      if (!suggestions[typed]) { // typo: the closest spellings
        const near = await nearMatches(name, { playersOnly: true });
        if (near.length) suggestions[typed] = near.map((r) => r.v);
      }
    } else ambiguous.push({ name: typed, options: found.map((r) => r.player_name) });
  }
  return { ids: [...new Set(ids)], missing, ambiguous, suggestions };
}

const REPORTS_SQL = `SELECT * FROM (
  SELECT r.id, r.player_id, p.name AS player_name, r.report_date, s.name AS scout_name, r.overall_score, r.overall_potential_score,
    r.recommendation, r.stage_of_growth, r.x_factor, r.physical, r.mental, r.technical, r.tactical, r.deadball, r.overall_comment,
    r.report_type, r.period_start, r.period_end, r.score_physical, r.score_technical, r.score_tactical, r.score_mental, r.score_behavioral,
    r.physical_comment, r.technical_comment, r.tactical_comment, r.mental_comment, r.behavioral_comment,
    row_number() OVER (PARTITION BY r.player_id ORDER BY r.report_date DESC NULLS LAST, r.id DESC) AS rn
  FROM reports r JOIN players p ON p.id = r.player_id LEFT JOIN scouts s ON s.id = r.scout_id
  WHERE r.player_id = ANY($1::int[])) x WHERE rn <= $2 ORDER BY player_id, rn`;

const knownNames = redactionNames; // scouts, teams + names learned from the data (names.js)

/** A report as text for the LLM, with names redacted (player names are already pseudonymised). */
function reportForLlm(r, names) {
  const tags = ['physical', 'mental', 'technical', 'tactical', 'deadball'].filter((c) => r[c]).map((c) => `${c}: ${r[c]}`).join('; ');
  // the report's own player is aliased (not "[name]") so the AI knows who is meant and quotes read naturally once translated back
  const own = (t) => redactComment(aliasPlayer(t, r.player_name, r.player_id), names);
  const scores = r.overall_score != null ? `, overall score ${r.overall_score}, ${r.overall_potential_score != null ? `potential ${r.overall_potential_score}` : 'potential not recorded'}` : '';
  const fb = r.report_type === 'feedback';
  const kind = fb ? `feedback report by a coach${r.period_start || r.period_end ? ` for ${r.period_start || '?'} – ${r.period_end || '?'}` : ''}` : 'assessment report';
  const cats = [['Physical', r.physical_comment, r.score_physical], ['Technical', r.technical_comment, r.score_technical], ['Tactical', r.tactical_comment, r.score_tactical],
    [fb ? 'Psychological' : 'Mental', r.mental_comment, r.score_mental], ['Behavioral', r.behavioral_comment, r.score_behavioral]]
    .filter(([, c, sc]) => c || sc != null).map(([label, c, sc]) => `${label}${sc != null ? ` (score ${sc})` : ''}: ${c ? own(c).slice(0, 700) : '–'}`);
  return [`#${r.id} (${r.player_name}, ${kind}, ${r.report_date || 'undated'}${scores}${r.recommendation ? `, “${r.recommendation}”` : ''})`,
    r.x_factor ? `X-factor: ${own(r.x_factor)}` : null,
    tags ? `Tags: ${tags}` : null,
    r.overall_comment ? `Comment: ${own(r.overall_comment).slice(0, 1800)}` : null,
    ...cats].filter(Boolean).join('\n');
}

/** "Compare the reports of this player": a table of the player's reports (oldest first) plus, if allowed, an AI comparison. */
async function compareOwnReports(playerId, rows, out, { message, opts, status, timings, assumptions }) {
  const [{ rows: pls }, { rows: reps }] = await Promise.all([
    chatPool.query('SELECT * FROM player_latest WHERE player_id = $1', [playerId]),
    chatPool.query(REPORTS_SQL, [[playerId], 12]),
  ]);
  const p = pls[0];
  if (!p) return { ...out, players: [], count: 0, answer: 'No players match.' };
  const players = [{ ...p, name: p.player_name }];
  const asc = [...reps].sort((a, b) => String(a.report_date || '').localeCompare(String(b.report_date || '')) || a.id - b.id);
  const line = (r) => `• #${r.id} ${r.report_date || 'undated'} – ${r.report_type === 'feedback' ? 'feedback, ' : ''}overall ${r.overall_score ?? '–'}, potential ${r.overall_potential_score ?? '–'}${r.recommendation ? `, “${r.recommendation}”` : ''}${r.scout_name ? `, by ${r.scout_name}` : ''}`;
  if (asc.length < 2) {
    // a very similar name is often the same person under another spelling: point at it
    const words = String(p.player_name).split(/[\s-]+/).filter((w) => w.length >= 3);
    const need = Math.max(2, Math.ceil(words.length / 2));
    const sim = words.length < 2 ? { rows: [] } : await chatPool.query(
      `SELECT player_id, player_name, report_count, team_name, age_group FROM player_latest WHERE player_id <> $1
         AND (${words.map((_, i) => `(${foldSql('player_name')} LIKE $${i + 2})::int`).join(' + ')}) >= ${need}
       ORDER BY report_count DESC, player_name LIMIT 3`, [playerId, ...words.map(containsPattern)]);
    const hint = sim.rows.length
      ? `\n\nA very similar name exists: ${sim.rows.map((s) => `${s.player_name} (${plural(s.report_count, 'report')}${s.team_name ? `, ${s.team_name}` : ''}${s.age_group ? `, age group ${s.age_group}` : ''})`).join('; ')}. `
        + 'It may be the same player under another spelling – ask me to compare that one.'
      : '';
    return { ...out, players, count: 1, answer: `**${p.player_name}** has only ${asc.length ? `one report (${line(asc[0]).slice(2)})` : 'no reports'}, so there is nothing to compare over time.${hint}` };
  }
  const header = `${profileHeader(p, reps)}\n\nReports, oldest first:\n${asc.map(line).join('\n')}`;
  if (opts.onToken) opts.onToken(`${header}\n\n`);
  if (!asc.some((r) => r.overall_comment || r.x_factor) || !commentsAllowed()) return { ...out, players, count: 1, answer: header };
  status('Comparing the reports…');
  const names = await knownNames();
  const t0 = Date.now();
  const r = await llmText({
    system: COMPARE_REPORTS_SYSTEM,
    content: `Administrator's question: ${message}\n\nFacts table (authoritative for scores and recommendations):\n${asc.map(line).join('\n')}\n\nReports (oldest first):\n${asc.map((x) => reportForLlm(x, names)).join('\n\n')}`,
    onToken: opts.onToken, maxTokens: 500,
  }, null);
  timings.answer_ms = Date.now() - t0;
  assumptions.push(`Compared this player’s ${asc.length} reports (names redacted) with the AI.`);
  return { ...out, players, count: 1, sources: asc.map((x) => x.id), sentToLlm: r.ok, answer: r.text ? `${header}\n\n${r.text}` : header };
}

function profileHeader(p, reps) {
  const facts = [p.position, p.team_name, p.location ? `lives in ${p.location}` : null, p.age_group ? `age group ${p.age_group}` : p.age_group_label ? `age group ${p.age_group_label}` : null,
    p.strong_foot ? `${p.strong_foot.toLowerCase()} foot` : null].filter(Boolean).join(', ');
  const scouts = [...new Set(reps.map((r) => r.scout_name).filter(Boolean))];
  const authorWord = reps.length && reps.every((r) => r.report_type === 'feedback') ? (scouts.length > 1 ? 'coaches' : 'coach')
    : reps.some((r) => r.report_type === 'feedback') ? 'scouts/coaches' : 'scouts';
  const span = p.report_count > 1 ? ` (${p.first_report_date || '?'} → ${p.report_date || '?'})` : p.report_date ? ` (${p.report_date})` : '';
  const change = p.score_change != null ? ` (${p.score_change > 0 ? '+' : ''}${p.score_change} since first report)` : '';
  const latest = p.overall_score != null
    ? `Latest: overall ${p.overall_score}${p.overall_potential_score != null ? `, potential ${p.overall_potential_score}` : ''}${change}${p.recommendation ? `, “${p.recommendation}”` : ''}.`
    : 'No scores recorded yet.';
  const kinds = p.feedback_count ? ` (${p.assessment_count || 0} assessment, ${p.feedback_count} feedback)` : '';
  return `**${p.player_name}** – ${facts || 'no details recorded'}. ${plural(p.report_count, 'report')}${kinds}${span}${scouts.length ? `, ${authorWord}: ${scouts.join(', ')}` : ''}. ${latest}${p.x_factor ? ` X-factor: ${p.x_factor}.` : ''}`;
}

/**
 * Answers one chat message.
 * @param {object} opts { conversationId, onStatus(text), onToken(text) }
 */
async function ask(message, opts = {}) {
  const started = Date.now();
  if (typeof message !== 'string' || !message.trim()) throw new ChatError(400, 'message is required');
  message = message.trim();
  if (message.length > MAX_MESSAGE) throw new ChatError(400, `message must be at most ${MAX_MESSAGE} characters`);

  const conversationId = memory.isValidId(opts.conversationId) ? opts.conversationId : crypto.randomUUID();
  const status = (t) => opts.onStatus && opts.onStatus(t);
  const timings = {};

  status('Understanding your question…');
  const [context, vocab] = await Promise.all([
    memory.loadContext(conversationId).catch((e) => { console.error('memory load failed:', e.message); return { turns: [], lastSpec: null }; }),
    getVocabulary(),
  ]);
  let planned;
  const typo = await typoInMessage(message, vocab).catch((e) => { console.error('typo check failed:', e.message); return null; });
  const chosen = context.pending && pickOption(message, context.pending._pending.options);
  if (chosen) { // "Which player do you mean by X?" answered: rerun that question with the chosen player
    const { _pending: pend, ...spec } = context.pending;
    planned = { route: 'data', spec: { ...spec, players: spec.players.map((p) => (p === pend.name ? chosen : p)) }, warnings: pend.warnings, planCached: false };
  } else if (typo) {
    planned = { route: 'clarify', reply: typo, spec: null, planCached: false };
  } else {
    try {
      planned = await plan(message, context, vocab, timings);
    } catch (e) {
      if (e instanceof SpecError) throw new ChatError(422, e.message);
      throw e;
    }
  }

  let result;
  if (planned.route === 'data') {
    result = await answerData(message, planned, opts, timings);
  } else if (planned.route === 'general' || planned.route === 'help') {
    status(planned.route === 'help' ? 'Explaining…' : 'Thinking…');
    const history = context.turns.length ? `Earlier in this conversation the user asked: ${context.turns.map((t) => `"${t.question}"`).join(', ')}\n\n` : '';
    const t0 = Date.now();
    const r = await llmText({
      system: planned.route === 'help' ? helpSystem(vocab) : GENERAL_SYSTEM,
      content: `${history}${message}`, onToken: opts.onToken, maxTokens: 450, temperature: 0.4,
    }, planned.route === 'help'
      ? 'I can answer questions about the scouting data: counts, lists, statistics, comment searches, player profiles and comparisons. Try “How many players per position?”.'
      : 'Sorry, I could not answer that right now. Please try again.');
    timings.answer_ms = Date.now() - t0;
    result = { answer: r.text, route: planned.route, intent: null, count: null, general: planned.route === 'general' };
    if (planned.route === 'general') result.notes = ['General football knowledge – not taken from your scouting data.'];
  } else {
    result = { answer: planned.reply, route: planned.route, intent: null, count: null };
    if (opts.onToken) opts.onToken(planned.reply);
  }

  timings.total_ms = Date.now() - started;
  const players = result.players || [];
  // awaited (a few ms) so an immediate follow-up always sees this turn
  await memory.saveTurn(conversationId, {
    question: message, route: result.route, intent: result.intent, spec: result.spec || null, answer: result.answer,
    count: result.count, playerIds: players.map((p) => p.player_id).slice(0, 25), playerNames: players.map((p) => p.name).slice(0, 25),
  }).catch((e) => console.error('memory save failed:', e.message));

  console.log(`[chat] ${new Date().toISOString()} route=${result.route} intent=${result.intent || '-'} count=${result.count ?? '-'} `
    + `plan=${planned.planCached ? 'cached' : `${timings.llm_ms}ms`} meaning=${timings.meaning_ms ?? '-'}ms db=${timings.db_ms ?? '-'}ms `
    + `answer_llm=${timings.answer_ms ?? '-'}ms total=${timings.total_ms}ms q="${message.slice(0, 80)}"`);

  return {
    conversation_id: conversationId,
    route: result.route,
    answer: result.answer,
    intent: result.intent,
    count: result.count,
    approximate: !!result.approximate,
    players,
    groups: result.groups,
    aggregate: result.aggregate,
    notes: result.notes || [],
    assumptions: result.assumptions || [],
    interpreted: result.interpreted || [],
    spec: result.spec || null,
    sources: result.sources || [],
    sent_to_llm: !!result.sentToLlm,
    cached: { plan: !!planned.planCached, result: !!result.resultCached },
    timings,
  };
}

async function answerData(message, planned, opts, timings) {
  const spec = structuredClone(planned.spec);
  const assumptions = [...spec.assumptions, ...planned.warnings];
  const notes = [];
  const status = (t) => opts.onStatus && opts.onStatus(t);
  const base = { route: 'data', intent: spec.intent, spec: planned.spec, assumptions, notes };
  const unitWord = spec.unit === 'report' ? 'report' : 'player';

  // ---- geo ----
  let near = null;
  if (spec.near) {
    near = await locationsWithin(spec.near.place, spec.near.max_minutes);
    if (!near) return { ...base, answer: `I couldn't find "${spec.near.place}" on the map, so I can't work out driving distances. Try a nearby town name.`, count: null };
    assumptions.push(`Player locations are municipalities, measured from their centre; driving time is ${near.source === 'estimate' ? 'estimated from straight-line distance' : 'calculated by road routing'}.`);
  }

  await fixMisfiledNames(spec);

  // ---- named players ----
  if (spec.players.length) {
    const r = await resolvePlayers(spec.players);
    // a comparison with one name dropped would silently become "one player over time": ask instead
    if (r.ambiguous.length && (!r.ids.length || spec.intent === 'compare')) {
      const a = r.ambiguous[0];
      return { ...base, spec: { ...planned.spec, _pending: { name: a.name, options: a.options, warnings: planned.warnings || [] } }, route: 'clarify', answer: `Which player do you mean by “${a.name}”: ${a.options.join(', ')}?`, count: null };
    }
    const didYouMean = (m) => (r.suggestions && r.suggestions[m] ? ` Did you mean ${r.suggestions[m].join(', ')}?` : '');
    if (!r.ids.length) return { ...base, answer: `I couldn't find a player called ${r.missing.map((m) => `“${m}”`).join(' or ')}.${r.missing.map(didYouMean).join('')}`, count: 0 };
    if (r.missing.length) notes.push(`Not found: ${r.missing.join(', ')}.${r.missing.map(didYouMean).join('')}`);
    if (r.ambiguous.length) notes.push(`Ambiguous, left out: ${r.ambiguous.map((a) => `${a.name} (${a.options.slice(0, 3).join(', ')}…)`).join('; ')}.`);
    spec.resolvedPlayerIds = r.ids;
  }

  // ---- meaning search ----
  let meaningRes = null;
  if (spec.meaning) {
    status('Searching what scouts wrote…');
    const t0 = Date.now();
    try {
      meaningRes = await resolveMeaning(spec.meaning, message);
      const pending = await pendingEmbeddings();
      if (pending) notes.push(`${fmt(pending)} recently added sentences are not indexed for meaning search yet (keyword search still covers them).`);
    } catch (e) {
      console.error('meaning search failed:', e.message);
      const others = spec.tags.length + spec.text.length;
      if (others && spec.content_logic === 'any') {
        assumptions.push('Meaning search is unavailable right now; used the keyword/tag conditions only.');
        spec.meaning = null;
      } else {
        return { ...base, answer: 'Meaning search over scout comments is unavailable right now (the AI provider could not be reached). Try asking for a specific word instead, e.g. “where is the word leader mentioned?”.', count: null };
      }
    }
    timings.meaning_ms = Date.now() - t0;
    if (meaningRes) {
      assumptions.push(`Meaning search for “${meaningRes.query}”: ${meaningRes.chunks.length} distinct phrasings and ${meaningRes.tags.length} tags matched out of ${meaningRes.candidates} closest candidates (${meaningRes.method}).`);
    }
  }
  const approximate = !!meaningRes;
  if (approximate && ['count', 'group_count', 'aggregate'].includes(spec.intent)) {
    notes.push('Counts based on meaning are approximate: a report counts if one of its sentences was confirmed to express the idea, from the closest candidates only.');
  }

  // ---- profile / compare targets without names: take the best matches of the other conditions ----
  if (['profile', 'compare'].includes(spec.intent) && !spec.resolvedPlayerIds) {
    spec.limit = spec.intent === 'profile' ? 1 : Math.min(Math.max(spec.limit || 3, 2), 5);
  }

  status('Searching the data…');
  const t1 = Date.now();
  const q = buildQueries(spec, near, meaningRes);
  const rkey = hash({ spec, near: near && near.place, m: meaningRes && [meaningRes.chunks.map((c) => c.id), meaningRes.tags] });
  let exec = resultCache.get(rkey);
  const resultCached = !!exec;
  if (!exec) {
    try {
      exec = await execute(q);
    } catch (e) {
      if (e.code === '57014') throw new ChatError(504, 'That question took too long to answer. Try narrowing it down (e.g. a position, age group or team).');
      throw e;
    }
    resultCache.set(rkey, exec);
  }
  timings.db_ms = Date.now() - t1;
  if (Number(exec.count) === 0 && ['list', 'count', 'group_count', 'aggregate', 'comment_analysis'].includes(spec.intent)) {
    const sug = await typoSuggestions(spec);
    if (sug) return { ...base, route: 'clarify', answer: sug, count: 0 };
  }

  const minutesByLoc = near ? new Map(near.locations.map((l) => [l.location, l.minutes])) : null;
  let rows = (exec.rows || []).map((p) => (minutesByLoc ? { ...p, drive_minutes: minutesByLoc.get(p.location) ?? null } : p));
  notes.push(...coverageNotes(exec.coverage, unitWord));
  if (spec.recommendation_note && spec.resolvedPlayerIds && spec.resolvedPlayerIds.length) { // who gave the recommendation the previous question was about
    const { rows: gave } = await chatPool.query(
      `SELECT p.name AS player, r.report_date, s.name AS scout FROM reports r JOIN players p ON p.id = r.player_id LEFT JOIN scouts s ON s.id = r.scout_id
       WHERE r.player_id = ANY($1::int[]) AND lower(r.recommendation) = lower($2) ORDER BY p.name, r.report_date`, [spec.resolvedPlayerIds, spec.recommendation_note]);
    if (gave.length) notes.push(`“${spec.recommendation_note}” was written by: ${gave.map((g) => `${g.scout || 'an unknown scout'} for ${g.player} (${g.report_date})`).join('; ')}.`);
  }
  const recFilter = spec.unit === 'player' && spec.recommendation_scope === 'all' ? spec.filters.find((f) => f.field === 'recommendation' && f.op === 'eq') : null;
  if (recFilter) {
    const other = (exec.rows || []).filter((p) => String(p.recommendation || '').toLowerCase() !== String(recFilter.value).toLowerCase()).length;
    if (other) notes.push(`${other} of the ${plural((exec.rows || []).length, 'player')} shown received “${recFilter.value}” in an earlier report; the card shows their latest recommendation.`);
  }
  if (Number(exec.count) === 0) notes.push(...(await rangeNotes(spec, unitWord)));

  // evidence snippets for content searches
  const hasContent = spec.tags.length || spec.text.length || meaningRes;
  if (rows.length && hasContent && (spec.text.length || meaningRes)) {
    const keyCol = spec.unit === 'report' ? 'report_id' : 'player_id';
    const latestOnly = spec.unit === 'player' && spec.content_scope !== 'all';
    const sn = await snippets({
      keys: rows.map((r) => r[keyCol]), keyCol, reportIds: latestOnly || spec.unit === 'report' ? rows.map((r) => r.report_id) : null,
      meaningRes, text: spec.text, tags: spec.tags,
    });
    rows = rows.map((r) => (sn.has(r[keyCol]) ? { ...r, match: sn.get(r[keyCol]) } : r));
  }

  const out = { ...base, count: exec.count, approximate, resultCached, interpreted: describe(spec, near, meaningRes) };
  const about = approximate ? 'about ' : '';

  switch (spec.intent) {
    case 'count':
      return { ...out, answer: `${approximate ? 'About ' : ''}${plural(exec.count, unitWord)} match${exec.count === 1 ? 'es' : ''}.` };

    case 'group_count': {
      const shown = exec.groups.slice(0, 20).map((g) => `${g.key ?? '(not recorded)'}: ${fmt(g.count)}`);
      const more = exec.groups.length > 20 ? `; … ${exec.groups.length - 20} more groups` : '';
      return {
        ...out, groups: exec.groups,
        answer: exec.count ? `${about}${plural(exec.count, unitWord)} in total. By ${spec.group_by === 'scout_name' && spec.filters.some((f) => f.field === 'report_type' && f.value === 'feedback') ? 'coach' : label(spec.group_by).toLowerCase()} – ${shown.join('; ')}${more}.` : `No ${unitWord}s match.`,
      };
    }

    case 'aggregate': {
      const fnLabel = { avg: 'Average', min: 'Lowest', max: 'Highest', sum: 'Total' }[spec.aggregate.fn];
      const what = `${fnLabel} ${label(spec.aggregate.field).toLowerCase()}`;
      if (exec.groups) {
        const groups = exec.groups.map((g) => ({ key: g.key, count: g.n, value: g.value }));
        const shown = groups.slice(0, 20).map((g) => `${g.key ?? '(not recorded)'}: ${round(g.value)} (${fmt(g.count)})`);
        return {
          ...out, groups, aggregate: { ...spec.aggregate, by: spec.group_by },
          answer: groups.length ? `${what} by ${label(spec.group_by).toLowerCase()} – ${shown.join('; ')}${groups.length > 20 ? '; …' : ''}. (Numbers in brackets: ${unitWord}s with a recorded value.)` : `No ${unitWord}s with a recorded ${label(spec.aggregate.field).toLowerCase()} match.`,
        };
      }
      const a = exec.agg;
      return {
        ...out, aggregate: { ...spec.aggregate, value: a.value, n: a.n },
        answer: a.n ? `${what}: ${round(a.value)} (from ${plural(a.n, unitWord)} with a recorded value${a.n < exec.count ? ` out of ${fmt(exec.count)} matching` : ''}).` : `No ${unitWord}s with a recorded ${label(spec.aggregate.field).toLowerCase()} match.`,
      };
    }

    case 'list': {
      if (!exec.count) return { ...out, players: [], answer: `No ${unitWord}s match.` };
      const lines = spec.unit === 'report' ? rows.map(reportLine) : rows.map(playerLine);
      if (spec.top_n && spec.unit === 'player') {
        const key = spec.sort && spec.sort.field === 'overall_potential_score' ? 'potential' : 'overall score';
        return { ...out, players: rows, answer: `Found ${about}${plural(exec.count, unitWord)}${exec.count > rows.length ? `, showing the top ${rows.length}` : ''}, ranked by ${key}. The best ${Math.min(spec.top_n, rows.length)}: ${lines.slice(0, spec.top_n).join('; ')}.` };
      }
      return {
        ...out, players: rows,
        answer: `Found ${about}${plural(exec.count, unitWord)}${exec.count > rows.length ? `, showing the ${hasContent && meaningRes && !spec.sort ? 'best matching' : 'top'} ${rows.length}` : ''}: ${lines.join('; ')}.`,
      };
    }

    case 'comment_analysis': {
      if (!exec.count) return { ...out, players: [], answer: `No ${unitWord}s match.` };
      const shortlist = rows.slice(0, 8);
      if (!commentsAllowed()) {
        assumptions.push('"Best" was judged from overall score, potential and recommendation only (sending comments to the AI is disabled).');
        return { ...out, players: rows, answer: `Based on scores and scout recommendations, the strongest matches are: ${shortlist.map(playerLine).join('; ')}.` };
      }
      status('Reading the shortlisted reports…');
      const ids = shortlist.map((r) => (r.match ? r.match.report_id : r.report_id)).filter(Boolean);
      const names = await knownNames();
      const { rows: reps } = await chatPool.query(
        `SELECT r.id, r.player_id, p.name AS player_name, r.report_date, r.overall_score, r.overall_potential_score, r.recommendation, r.x_factor, r.physical, r.mental,
           r.technical, r.tactical, r.deadball, r.overall_comment
         FROM reports r JOIN players p ON p.id = r.player_id WHERE r.id = ANY($1::int[])`, [ids]);
      const t0 = Date.now();
      const r = await llmText({ system: JUDGE_SYSTEM, content: `Question: ${message}\n\nReports:\n${reps.map((x) => reportForLlm(x, names)).join('\n\n')}`, onToken: opts.onToken, maxTokens: 500 }, null);
      timings.answer_ms = Date.now() - t0;
      assumptions.push(`Shortlisted ${reps.length} reports (${meaningRes ? 'best meaning matches' : spec.sort ? `top by ${spec.sort.field}` : 'top by score/recommendation'}) and sent only their redacted text to the AI.`);
      return {
        ...out, players: rows, sources: reps.map((x) => x.id), sentToLlm: r.ok,
        answer: r.text || `The AI could not be reached; based on scores and recommendations the strongest matches are: ${shortlist.map(playerLine).join('; ')}.`,
      };
    }

    case 'profile':
    case 'compare': {
      const targets = spec.resolvedPlayerIds ? spec.resolvedPlayerIds.slice(0, 5) : rows.map((r) => r.player_id);
      if (!targets.length) return { ...out, players: [], count: 0, answer: 'No players match.' };
      if (spec.intent === 'compare' && targets.length < 2) {
        // one player named: compare that player's reports over time (or explain why that is not possible)
        return compareOwnReports(targets[0], rows, out, { message, opts, status, timings, assumptions });
      }
      const perPlayer = spec.intent === 'profile' ? 10 : 3;
      const [{ rows: pls }, { rows: reps }] = await Promise.all([
        chatPool.query(`SELECT * FROM player_latest WHERE player_id = ANY($1::int[])`, [targets]),
        chatPool.query(REPORTS_SQL, [targets, perPlayer]),
      ]);
      const order = new Map(targets.map((id, i) => [id, i]));
      pls.sort((a, b) => order.get(a.player_id) - order.get(b.player_id));
      const header = pls.map((p) => profileHeader(p, reps.filter((r) => r.player_id === p.player_id))).join('\n\n');
      const players = pls.map((p) => ({ ...p, name: p.player_name }));
      if (opts.onToken) opts.onToken(`${header}\n\n`);
      if (!reps.some((r) => r.overall_comment || r.x_factor) || !commentsAllowed()) {
        return { ...out, players, count: pls.length, answer: header };
      }
      status('Reading the reports…');
      const names = await knownNames();
      const t0 = Date.now();
      const r = await llmText({
        system: spec.intent === 'profile' ? PROFILE_SYSTEM : COMPARE_SYSTEM,
        content: `Administrator's question: ${message}\n\nReports:\n${reps.map((x) => reportForLlm(x, names)).join('\n\n')}`,
        onToken: opts.onToken, maxTokens: 550,
      }, null);
      timings.answer_ms = Date.now() - t0;
      assumptions.push(`Sent the ${reps.length} most recent reports (redacted) to the AI for the written summary.`);
      return {
        ...out, players, count: pls.length, sources: reps.map((x) => x.id), sentToLlm: r.ok,
        answer: r.text ? `${header}\n\n${spec.intent === 'profile' ? 'What the reports say:\n' : ''}${r.text}` : header,
      };
    }
    default:
      return { ...out, answer: `${plural(exec.count, unitWord)} match.` };
  }
}

module.exports = { ask, clearCaches, ChatError, FIELDS };
