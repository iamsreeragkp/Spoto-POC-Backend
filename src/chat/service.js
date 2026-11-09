const crypto = require('crypto');
const chatPool = require('../db/chatPool');
const { getLlm } = require('./llm');
const { normalizePlan, SpecError, FIELDS } = require('./spec');
const { carryFollowUp } = require('./followup');
const { getMasker, aliasPlayer } = require('./privacy');
const { getVocabulary, invalidateVocabulary } = require('./vocabulary');
const { buildQueries } = require('./builder');
const { locationsWithin } = require('./geo');
const { redactComment } = require('./redact');
const { redactionNames } = require('./names');
const { resolveMeaning, snippets, pendingEmbeddings, clearRetrievalCache } = require('./retrieval');
const memory = require('./memory');
const { GENERAL_SYSTEM, helpSystem, JUDGE_SYSTEM, PROFILE_SYSTEM, COMPARE_SYSTEM } = require('./llm/prompt');

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
  out.push(...spec.filters.map((f) => (['is_null', 'not_null'].includes(f.op) ? `${f.field} ${OP_TEXT[f.op]}` : `${f.field} ${OP_TEXT[f.op]} ${f.value}`)));
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
const reportLine = (r) => `#${r.report_id} ${r.report_date || 'undated'} – ${r.name}${r.scout_name ? `, by ${r.scout_name}` : ''}${r.overall_score != null ? `, score ${r.overall_score}` : ''}`;
const round = (v) => (v == null ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(2)).toString());

// ---- planning ----
async function plan(message, context, vocab, timings) {
  const key = normQ(message) + (context.turns.length ? `|${hash(context)}` : '');
  const cached = planCache.get(key);
  if (cached) return { ...cached, planCached: true };

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
  let result = carryFollowUp(message, context.lastSpec, normalizePlan(raw, vocab));
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
async function resolvePlayers(names) {
  const ids = [], missing = [], ambiguous = [];
  for (const name of names) {
    const exact = await chatPool.query('SELECT player_id, player_name FROM player_latest WHERE lower(player_name) = lower($1) LIMIT 2', [name]);
    if (exact.rows.length === 1) { ids.push(exact.rows[0].player_id); continue; }
    const fuzzy = await chatPool.query(
      `SELECT player_id, player_name FROM player_latest WHERE player_name ILIKE $1 ORDER BY length(player_name), player_name LIMIT 6`,
      [`%${name.replace(/[%_\\]/g, ' ').trim()}%`]);
    if (fuzzy.rows.length === 1) ids.push(fuzzy.rows[0].player_id);
    else if (!fuzzy.rows.length) missing.push(name);
    else ambiguous.push({ name, options: fuzzy.rows.map((r) => r.player_name) });
  }
  return { ids: [...new Set(ids)], missing, ambiguous };
}

const REPORTS_SQL = `SELECT * FROM (
  SELECT r.id, r.player_id, p.name AS player_name, r.report_date, s.name AS scout_name, r.overall_score, r.overall_potential_score,
    r.recommendation, r.stage_of_growth, r.x_factor, r.physical, r.mental, r.technical, r.tactical, r.deadball, r.overall_comment,
    row_number() OVER (PARTITION BY r.player_id ORDER BY r.report_date DESC NULLS LAST, r.id DESC) AS rn
  FROM reports r JOIN players p ON p.id = r.player_id LEFT JOIN scouts s ON s.id = r.scout_id
  WHERE r.player_id = ANY($1::int[])) x WHERE rn <= $2 ORDER BY player_id, rn`;

const knownNames = redactionNames; // scouts, teams + names learned from the data (names.js)

/** A report as text for the LLM, with names redacted (player names are already pseudonymised). */
function reportForLlm(r, names) {
  const tags = ['physical', 'mental', 'technical', 'tactical', 'deadball'].filter((c) => r[c]).map((c) => `${c}: ${r[c]}`).join('; ');
  // the report's own player is aliased (not "[name]") so the AI knows who is meant and quotes read naturally once translated back
  const own = (t) => redactComment(aliasPlayer(t, r.player_name, r.player_id), names);
  return [`#${r.id} (${r.player_name}, ${r.report_date || 'undated'}${r.recommendation ? `, “${r.recommendation}”` : ''})`,
    r.x_factor ? `X-factor: ${own(r.x_factor)}` : null,
    tags ? `Tags: ${tags}` : null,
    r.overall_comment ? `Comment: ${own(r.overall_comment).slice(0, 1800)}` : null].filter(Boolean).join('\n');
}

function profileHeader(p, reps) {
  const facts = [p.position, p.team_name, p.location ? `lives in ${p.location}` : null, p.age_group ? `age group ${p.age_group}` : null,
    p.strong_foot ? `${p.strong_foot.toLowerCase()} foot` : null].filter(Boolean).join(', ');
  const scouts = [...new Set(reps.map((r) => r.scout_name).filter(Boolean))];
  const span = p.report_count > 1 ? ` (${p.first_report_date || '?'} → ${p.report_date || '?'})` : p.report_date ? ` (${p.report_date})` : '';
  const change = p.score_change != null ? ` (${p.score_change > 0 ? '+' : ''}${p.score_change} since first report)` : '';
  const latest = p.overall_score != null
    ? `Latest: overall ${p.overall_score}${p.overall_potential_score != null ? `, potential ${p.overall_potential_score}` : ''}${change}${p.recommendation ? `, “${p.recommendation}”` : ''}.`
    : 'No scores recorded yet.';
  return `**${p.player_name}** – ${facts || 'no details recorded'}. ${plural(p.report_count, 'report')}${span}${scouts.length ? `, scouts: ${scouts.join(', ')}` : ''}. ${latest}${p.x_factor ? ` X-factor: ${p.x_factor}.` : ''}`;
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
  try {
    planned = await plan(message, context, vocab, timings);
  } catch (e) {
    if (e instanceof SpecError) throw new ChatError(422, e.message);
    throw e;
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

  // ---- named players ----
  if (spec.players.length) {
    const r = await resolvePlayers(spec.players);
    if (r.ambiguous.length && !r.ids.length) {
      const a = r.ambiguous[0];
      return { ...base, route: 'clarify', answer: `Which player do you mean by “${a.name}”: ${a.options.join(', ')}?`, count: null };
    }
    if (!r.ids.length) return { ...base, answer: `I couldn't find a player called ${r.missing.map((m) => `“${m}”`).join(' or ')}.`, count: 0 };
    if (r.missing.length) notes.push(`Not found: ${r.missing.join(', ')}.`);
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

  const minutesByLoc = near ? new Map(near.locations.map((l) => [l.location, l.minutes])) : null;
  let rows = (exec.rows || []).map((p) => (minutesByLoc ? { ...p, drive_minutes: minutesByLoc.get(p.location) ?? null } : p));
  notes.push(...coverageNotes(exec.coverage, unitWord));
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
        answer: exec.count ? `${about}${plural(exec.count, unitWord)} in total. By ${label(spec.group_by).toLowerCase()} – ${shown.join('; ')}${more}.` : `No ${unitWord}s match.`,
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
        `SELECT r.id, r.player_id, p.name AS player_name, r.report_date, r.recommendation, r.x_factor, r.physical, r.mental,
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
        return { ...out, players: rows, answer: 'I need at least two players to compare – which players should I compare?', route: 'clarify' };
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
        answer: r.text ? `${header}\n\n${spec.intent === 'profile' ? 'What the scouts say:\n' : ''}${r.text}` : header,
      };
    }
    default:
      return { ...out, answer: `${plural(exec.count, unitWord)} match.` };
  }
}

module.exports = { ask, clearCaches, ChatError, FIELDS };
