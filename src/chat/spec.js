// The "plan" is the only thing the LLM produces: a route (data / general / help / clarify / refuse) and, for data
// questions, a query spec. Everything is validated against whitelists here and turned into parameterised SQL by
// builder.js – the LLM never writes SQL.

const ROUTES = ['data', 'general', 'help', 'clarify', 'refuse'];
const INTENTS = ['count', 'list', 'group_count', 'aggregate', 'comment_analysis', 'profile', 'compare'];
const UNITS = ['player', 'report'];
const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'not_null'];
const TAG_CATEGORIES = ['physical', 'mental', 'technical', 'tactical', 'deadball'];
const TEXT_FIELDS = ['x_factor', 'comment', 'tags', 'technical', 'physical', 'mental', 'tactical', 'deadball', 'any'];
const MEANING_FIELDS = ['x_factor', 'comment', 'tags', 'any'];
const AGG_FNS = ['avg', 'min', 'max', 'sum'];

// field -> { col: column in player_latest / report_facts, kind, sparse: often empty, playerOnly: not on report rows, desc }
const FIELDS = {
  player_name:   { col: 'player_name', kind: 'text', desc: 'player name (pseudonymised, e.g. "Player 12")' },
  position:      { col: 'position', kind: 'text', desc: 'main position' },
  secondary_position: { col: 'secondary_position', kind: 'text', sparse: true, desc: 'secondary position' },
  strong_foot:   { col: 'strong_foot', kind: 'text', sparse: true, desc: 'preferred foot' },
  gender:        { col: 'gender', kind: 'text', desc: 'gender' },
  stage_of_growth: { col: 'stage_of_growth', kind: 'text', sparse: true, desc: 'physical development stage (early/average/late developed)' },
  location:      { col: 'location', kind: 'text', desc: 'Danish town/municipality the player lives in' },
  team_name:     { col: 'team_name', kind: 'text', desc: 'club / team' },
  scout_name:    { col: 'scout_name', kind: 'text', desc: 'scout who wrote the report' },
  recommendation: { col: 'recommendation', kind: 'text', desc: "scout's recommendation (e.g. Golden Boy!!!)" },
  age_group:     { col: 'age_group', kind: 'num', desc: 'birth-year cohort, e.g. 2012' },
  year_of_birth: { col: 'year_of_birth', kind: 'num', desc: 'year of birth' },
  jersey_number: { col: 'jersey_number', kind: 'num', sparse: true, desc: 'shirt number' },
  father_height: { col: 'father_height_mid', kind: 'num', sparse: true, desc: "father's height in cm (range midpoint)" },
  mother_height: { col: 'mother_height_mid', kind: 'num', sparse: true, desc: "mother's height in cm (range midpoint)" },
  height_now:    { col: 'height_now_mid', kind: 'num', sparse: true, desc: "player's current height in cm (range midpoint)" },
  overall_score: { col: 'overall_score', kind: 'num', desc: 'overall score (1-6 in practice)' },
  overall_potential_score: { col: 'overall_potential_score', kind: 'num', sparse: true, desc: 'potential score' },
  score_physical:  { col: 'score_physical', kind: 'num', sparse: true, desc: 'physical score' },
  score_mental:    { col: 'score_mental', kind: 'num', sparse: true, desc: 'mental score' },
  score_technical: { col: 'score_technical', kind: 'num', sparse: true, desc: 'technical score' },
  score_tactical:  { col: 'score_tactical', kind: 'num', sparse: true, desc: 'tactical score' },
  score_deadball:  { col: 'score_deadball', kind: 'num', sparse: true, desc: 'set-piece score' },
  score_x_factor:  { col: 'score_x_factor', kind: 'num', sparse: true, desc: 'x-factor score' },
  report_date:   { col: 'report_date', kind: 'date', desc: 'date of the report (YYYY-MM-DD)' },
  report_year:   { col: 'report_year', kind: 'num', desc: 'year of the report' },
  report_month:  { col: 'report_month', kind: 'text', desc: 'month of the report (YYYY-MM)' },
  report_count:  { col: 'report_count', kind: 'num', playerOnly: true, desc: 'how many reports the player has' },
  first_report_date: { col: 'first_report_date', kind: 'date', playerOnly: true, desc: "date of the player's first report" },
  score_change:  { col: 'score_change', kind: 'num', sparse: true, playerOnly: true, desc: 'latest minus first overall score (players with 2+ reports)' },
};
const FILTER_FIELDS = Object.keys(FIELDS);
const NUM_FIELDS = FILTER_FIELDS.filter((f) => FIELDS[f].kind === 'num');
const GROUP_FIELDS = ['position', 'secondary_position', 'strong_foot', 'stage_of_growth', 'age_group', 'year_of_birth', 'team_name',
  'location', 'scout_name', 'recommendation', 'overall_score', 'overall_potential_score', 'gender', 'report_year', 'report_month', 'report_count'];
const TIME_GROUPS = new Set(['report_year', 'report_month', 'age_group', 'year_of_birth', 'overall_score', 'overall_potential_score', 'report_count']);
const SORT_FIELDS = [...NUM_FIELDS, 'report_date', 'first_report_date', 'player_name'];

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MAX_PLAYERS = 5;

const nullable = (schema) => ({ anyOf: [{ type: 'null' }, schema] });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

// Data spec JSON schema (OpenAI structured outputs, strict mode: every property required, nullable where optional)
const SPEC_SCHEMA = obj({
  intent: { type: 'string', enum: INTENTS },
  unit: { type: 'string', enum: UNITS },
  filters: { type: 'array', items: obj({ field: { type: 'string', enum: FILTER_FIELDS }, op: { type: 'string', enum: OPS }, value: { type: 'string' } }) },
  tags: { type: 'array', items: obj({ category: { type: 'string', enum: TAG_CATEGORIES }, any_of: { type: 'array', items: { type: 'string' } } }) },
  text: { type: 'array', items: obj({ fields: { type: 'array', items: { type: 'string', enum: TEXT_FIELDS } }, any_of: { type: 'array', items: { type: 'string' } } }) },
  meaning: nullable(obj({ query: { type: 'string' }, fields: { type: 'array', items: { type: 'string', enum: MEANING_FIELDS } } })),
  content_logic: { type: 'string', enum: ['all', 'any'] },
  content_scope: { type: 'string', enum: ['latest', 'all'] },
  near: nullable(obj({ place: { type: 'string' }, max_minutes: { type: 'number' } })),
  players: { type: 'array', items: { type: 'string' } },
  group_by: nullable({ type: 'string', enum: GROUP_FIELDS }),
  aggregate: nullable(obj({ fn: { type: 'string', enum: AGG_FNS }, field: { type: 'string', enum: NUM_FIELDS } })),
  sort: nullable(obj({ field: { type: 'string', enum: SORT_FIELDS }, direction: { type: 'string', enum: ['asc', 'desc'] } })),
  limit: nullable({ type: 'integer' }),
  assumptions: { type: 'array', items: { type: 'string' } },
});

const PLAN_SCHEMA = obj({
  route: { type: 'string', enum: ROUTES },
  reply: nullable({ type: 'string' }),
  spec: nullable(SPEC_SCHEMA),
});

class SpecError extends Error {}

const cleanTerm = (t) => String(t).replace(/[%_\\]/g, ' ').trim();
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// crude stem for matching search words against tag names ("agility" ~ "agile", "heading" ~ "head")
const stem = (w) => {
  const m = w.match(/^(.*?)(ities|ity|ings|ing|ers|er|ies|es|ed|ly|e|s)$/);
  return m && m[1].length >= 4 ? m[1] : w;
};
/** true when every word (2+ letters) of term matches (same stem / prefix) some word in tag */
function tagHasWords(tag, term) {
  const tw = norm(tag).split(' ').map(stem);
  const qw = norm(term).split(' ').filter((w) => w.length >= 2).map(stem);
  return qw.length > 0 && qw.every((q) => tw.some((w) => w.startsWith(q) || (q.length >= 4 && q.startsWith(w) && w.length >= 4)));
}

/**
 * Validates + normalises an LLM-produced data spec. Returns { spec, warnings }.
 * Tags are snapped to the real tag vocabulary; unknown tags become free-text terms on the same column.
 * Accepts phase-1 specs (missing phase-2 fields get defaults).
 */
function normalizeSpec(raw, vocab) {
  if (!raw || typeof raw !== 'object') throw new SpecError('Spec is not an object');
  const warnings = [];
  const unit = UNITS.includes(raw.unit) ? raw.unit : 'player';
  const spec = {
    intent: INTENTS.includes(raw.intent) ? raw.intent : 'list',
    unit,
    filters: [], tags: [], text: [], meaning: null,
    content_logic: raw.content_logic === 'any' ? 'any' : 'all',
    content_scope: raw.content_scope === 'all' && unit === 'player' ? 'all' : 'latest',
    near: null, players: [], group_by: null, aggregate: null, sort: null,
    limit: DEFAULT_LIMIT,
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.filter((a) => typeof a === 'string').slice(0, 8) : [],
  };
  const usable = (field) => {
    const def = FIELDS[field];
    if (!def) return false;
    if (def.playerOnly && unit === 'report') { warnings.push(`Ignored "${field}" (only available per player, not per report)`); return false; }
    return true;
  };

  const extraText = [];
  // Fields with a fixed list of recorded values: an exact match on a value that is not on the list can never match,
  // so it is searched as free text instead (e.g. "JL Top 18 in Denmark" is written in comments, not a recommendation).
  const LISTED = { recommendation: vocab.recommendations, stage_of_growth: vocab.stageOfGrowth, strong_foot: vocab.strongFoot };
  // skill words (whole tag or a word of a tag, e.g. "speed" from "Pace/speed")
  const tagWords = new Set(Object.values(vocab.tags || {}).flat().flatMap((t) => [norm(t.tag), ...norm(t.tag).split(' ').filter((w) => w.length >= 4)]));
  const isPositionWord = (v) => (vocab.positions || []).some((p) => norm(p).includes(norm(v)));
  for (const f of raw.filters || []) {
    if (!FIELDS[f && f.field]) { warnings.push(`Ignored unknown filter field "${f && f.field}"`); continue; }
    if (!usable(f.field)) continue;
    const def = FIELDS[f.field];
    if (!OPS.includes(f.op)) { warnings.push(`Ignored unknown operator "${f.op}"`); continue; }
    let value = f.value == null ? '' : String(f.value).trim();
    if (def.kind === 'num' && !['is_null', 'not_null'].includes(f.op)) {
      value = Number(value.replace(',', '.'));
      if (!Number.isFinite(value)) { warnings.push(`Ignored non-numeric value for ${f.field}`); continue; }
    }
    if (def.kind === 'date' && !['is_null', 'not_null'].includes(f.op) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      warnings.push(`Ignored invalid date for ${f.field}`); continue;
    }
    if (def.kind === 'text' && typeof value === 'string') value = value.replace(/\bcenter\b/gi, 'centre');
    if (def.kind !== 'num' && !['is_null', 'not_null'].includes(f.op) && value === '') continue;
    if ((f.field === 'position' || f.field === 'secondary_position') && tagWords.has(norm(value)) && !isPositionWord(value)) {
      warnings.push(`“${value}” is a skill tag, not a playing position, so it was not used as a position filter`);
      continue;
    }
    const listed = LISTED[f.field];
    if (f.op === 'eq' && Array.isArray(listed) && listed.length && value !== '') {
      const wordIn = (v) => (` ${norm(value)} `).includes(` ${norm(v)} `);
      const same = listed.filter((v) => norm(v) === norm(value));
      const contained = same.length ? [] : listed.filter((v) => norm(v) !== '' && wordIn(v)); // "left footed" contains "left"
      const exact = same.length ? same[0] : (contained.length === 1 ? contained[0] : undefined); // same value ignoring case/punctuation -> stored wording
      if (exact !== undefined) value = String(exact);
      else {
        extraText.push({ fields: ['any'], any_of: [value] });
        warnings.push(`“${value}” is not one of the recorded ${f.field.replace(/_/g, ' ')} values; searched the scouts' text for it instead`);
        continue;
      }
    }
    spec.filters.push({ field: f.field, op: f.op, value });
  }

  for (const t of raw.tags || []) {
    if (!TAG_CATEGORIES.includes(t && t.category)) continue;
    const known = vocab.tags[t.category] || [];
    const matched = new Set();
    const leftover = [];
    for (const term of t.any_of || []) {
      const n = norm(term);
      if (!n) continue;
      const exact = known.filter((k) => norm(k.tag) === n);
      const partial = exact.length ? exact : known.filter((k) => norm(k.tag).includes(n) || n.includes(norm(k.tag)));
      if (partial.length) partial.forEach((k) => matched.add(k.tag));
      else leftover.push(cleanTerm(term));
    }
    if (matched.size) spec.tags.push({ category: t.category, any_of: [...matched] });
    if (leftover.length) {
      warnings.push(`No exact "${t.category}" tag for: ${leftover.join(', ')}; searched all report text instead`);
      extraText.push({ fields: ['any'], any_of: leftover });
    }
  }

  // Keyword search. Free text (x-factor, comment) uses full-text search; the tag columns only ever hold vocabulary
  // values, so searching them by words = the vocabulary tags containing those words, matched exactly via report_tags
  // (much faster than text search over tag lists). Both parts stay one OR-condition: { fields, any_of, tag_matches }.
  const rawText = [];
  for (const t of raw.text || []) {
    const keep = [];
    for (const term of t.any_of || []) {
      const clean = norm(term);
      const hit = clean.length >= 6 ? Object.entries(LISTED).find(([field, list]) => usable(field) && Array.isArray(list) && list.some((v) => norm(v) === clean)) : null;
      if (hit) {
        const value = String(hit[1].find((v) => norm(v) === clean));
        if (!spec.filters.some((f) => f.field === hit[0] && f.op === 'eq' && f.value === value)) spec.filters.push({ field: hit[0], op: 'eq', value });
        warnings.push(`“${term}” is the recorded ${hit[0].replace(/_/g, ' ')} “${value}”, so it was used as that filter`);
      } else keep.push(term);
    }
    rawText.push({ ...t, any_of: keep });
  }
  for (const t of [...rawText, ...extraText]) {
    let fields = [...new Set((t.fields || []).filter((f) => TEXT_FIELDS.includes(f)))];
    if (!fields.length) fields = ['any'];
    const terms = (t.any_of || []).map(cleanTerm).filter((x) => x.length >= 2).slice(0, 12);
    if (!terms.length) continue;
    const allTags = fields.includes('any') || fields.includes('tags');
    const cats = allTags ? TAG_CATEGORIES : fields.filter((f) => TAG_CATEGORIES.includes(f));
    const tagMatches = cats.map((cat) => ({
      category: cat,
      any_of: (vocab.tags[cat] || []).filter((k) => terms.some((term) => tagHasWords(k.tag, term))).map((k) => k.tag),
    })).filter((h) => h.any_of.length);
    const textFields = fields.includes('any') ? ['x_factor', 'comment'] : fields.filter((f) => f === 'x_factor' || f === 'comment');
    if (!textFields.length && !tagMatches.length) warnings.push(`No ${cats.join('/')} tag contains: ${terms.join(', ')}`);
    spec.text.push({ fields: textFields, any_of: terms, tag_matches: tagMatches });
  }

  if (raw.meaning && typeof raw.meaning.query === 'string' && raw.meaning.query.trim()) {
    const fields = (raw.meaning.fields || []).filter((f) => MEANING_FIELDS.includes(f));
    spec.meaning = { query: raw.meaning.query.trim().slice(0, 300), fields: fields.length ? [...new Set(fields)] : ['any'] };
  }

  if (raw.near && raw.near.place) {
    const mins = Number(raw.near.max_minutes);
    if (Number.isFinite(mins) && mins > 0 && mins <= 600) spec.near = { place: String(raw.near.place).trim().slice(0, 80), max_minutes: mins };
  }
  spec.players = [...new Set((raw.players || []).filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().slice(0, 80)))].slice(0, MAX_PLAYERS);

  if (GROUP_FIELDS.includes(raw.group_by) && usable(raw.group_by)) spec.group_by = raw.group_by;
  if (raw.aggregate && AGG_FNS.includes(raw.aggregate.fn) && NUM_FIELDS.includes(raw.aggregate.field) && usable(raw.aggregate.field)) {
    spec.aggregate = { fn: raw.aggregate.fn, field: raw.aggregate.field };
  }
  if (spec.intent === 'aggregate' && !spec.aggregate) { spec.intent = spec.group_by ? 'group_count' : 'count'; warnings.push('No valid statistic requested; counted instead'); }
  if (spec.intent === 'group_count' && !spec.group_by) spec.intent = 'count';
  if (['profile', 'compare'].includes(spec.intent)) spec.unit = 'player';
  if (raw.sort && SORT_FIELDS.includes(raw.sort.field) && usable(raw.sort.field)) {
    spec.sort = { field: raw.sort.field, direction: raw.sort.direction === 'asc' ? 'asc' : 'desc' };
  }
  const lim = Number(raw.limit);
  if (Number.isInteger(lim) && lim > 0) spec.limit = Math.min(lim, MAX_LIMIT);

  return { spec, warnings };
}

/** Validates the router output. Returns { route, reply, spec, warnings }. */
function normalizePlan(raw, vocab) {
  if (!raw || typeof raw !== 'object') throw new SpecError('Plan is not an object');
  // phase-1 style plan (a bare spec) = data route
  if (!raw.route && raw.intent) raw = { route: 'data', reply: null, spec: raw };
  let route = ROUTES.includes(raw.route) ? raw.route : (raw.spec ? 'data' : 'clarify');
  const reply = typeof raw.reply === 'string' && raw.reply.trim() ? raw.reply.trim().slice(0, 1000) : null;
  if (route === 'data') {
    if (!raw.spec) return { route: 'clarify', reply: reply || 'Could you rephrase the question? I was not sure what to look up.', spec: null, warnings: [] };
    const { spec, warnings } = normalizeSpec(raw.spec, vocab);
    return { route, reply: null, spec, warnings };
  }
  if ((route === 'clarify' || route === 'refuse') && !reply) {
    route = route === 'refuse' ? 'refuse' : 'clarify';
    return { route, reply: route === 'refuse' ? 'Sorry, I can only answer questions about the scouting data and football.' : 'Could you tell me a bit more about what you are looking for?', spec: null, warnings: [] };
  }
  return { route, reply, spec: null, warnings: [] };
}

module.exports = {
  PLAN_SCHEMA, SPEC_SCHEMA, FIELDS, FILTER_FIELDS, NUM_FIELDS, GROUP_FIELDS, TIME_GROUPS, SORT_FIELDS, TAG_CATEGORIES,
  TEXT_FIELDS, MEANING_FIELDS, INTENTS, ROUTES, normalizeSpec, normalizePlan, SpecError, MAX_LIMIT, DEFAULT_LIMIT,
};
