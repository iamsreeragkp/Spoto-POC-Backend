// Safety net for follow-ups such as "how many of those were born in 2013?".
// The planner is told to merge the previous question's conditions into the new plan (prompt rule 14), but it
// occasionally drops them. When the wording clearly refers to the previous result ("of them", "those", "these") and the
// new plan has lost conditions the previous one had, they are put back. Conditions the new plan states itself win.
const { normalizeSpec } = require('./spec');
const REFERS_BACK = /\b(?:of|among|from|out of|within|in)\s+(?:them|those|these)\b|\b(?:those|these)\s+(?:ones|players|reports)\b|\bof the (?:above|previous|same)\b/i;

function carryFollowUp(message, lastSpec, result) {
  if (!lastSpec || !result || result.route !== 'data' || !result.spec) return result;
  if (!REFERS_BACK.test(message)) return result;
  // "which one of these 5 ...": the planner listed exactly as many players as the question counts (here the players of two earlier
  // searches together), so that explicit set is the answer: nothing from the previous question is added back or dropped
  const nums = [...String(message).matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]));
  if ((result.spec.players || []).length >= 2 && nums.includes(result.spec.players.length)) return result;
  if (['profile', 'compare'].includes(lastSpec.intent)) return result; // those are about named players, not a result set
  const next = result.spec;
  const hadContent = (lastSpec.tags || []).length || (lastSpec.text || []).length || lastSpec.meaning;
  if (!(lastSpec.filters || []).length && !hadContent && !lastSpec.near) return result;

  const merged = { ...next };
  const kept = [];
  const have = new Set((next.filters || []).map((f) => f.field));
  const carried = (lastSpec.filters || []).filter((f) => !have.has(f.field));
  if (carried.length) { merged.filters = [...carried, ...(next.filters || [])]; kept.push('filters'); }
  const newHasContent = (next.tags || []).length || (next.text || []).length || next.meaning;
  if (!newHasContent && hadContent) {
    merged.tags = lastSpec.tags || [];
    merged.text = lastSpec.text || [];
    merged.meaning = lastSpec.meaning || null;
    merged.content_logic = lastSpec.content_logic;
    merged.content_scope = lastSpec.content_scope;
    kept.push('search terms');
  }
  if (!next.near && lastSpec.near) { merged.near = lastSpec.near; kept.push('distance'); }
  // "them/those" means the whole previous result, never just the names that were displayed
  if (!['profile', 'compare'].includes(next.intent) && (next.players || []).length) { merged.players = []; kept.push('result set'); }
  if (!kept.length) return result;
  merged.assumptions = [...(next.assumptions || []), 'Kept the conditions from your previous question.'].slice(0, 8);
  return { ...result, spec: merged };
}

// A keyword search in the comment text is about what scouts have written, i.e. any report. The planner sometimes picks
// "latest report only" (and a follow-up from a report question inherits it), which gives a different count for the
// same question. Unless the question asks for the latest/current report, such searches look at all reports.
const LATEST_WORDS = /\b(?:latest|current|currently|now|most recent|newest|last report|at the moment)\b/i;

function defaultTextScope(message, result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || s.unit !== 'player' || s.content_scope !== 'latest') return result;
  const inComments = (s.text || []).some((t) => (t.fields || []).some((f) => f === 'comment' || f === 'any'));
  if (!inComments || LATEST_WORDS.test(message)) return result; // x-factor-only searches and explicit "latest" keep latest
  return { ...result, spec: { ...s, content_scope: 'all',
    assumptions: [...(s.assumptions || []), 'Searched all of each player\u2019s reports (add \u201cin the latest report\u201d to limit it).'].slice(0, 8) } };
}

// "find players named X" -> "And Carl": the planner sometimes keeps the old name and adds the new one (name contains both, which
// matches nobody). Name filters that were already in the previous question's plan are dropped when the new question brings a new
// name. Several names that all come from the new question ("Andre Kronborg" = first name + surname) belong together and are kept.
function collapseNameFilters(result, lastSpec) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || !lastSpec) return result;
  const names = (s.filters || []).filter((f) => f.field === 'player_name');
  const old = new Set((lastSpec.filters || []).filter((f) => f.field === 'player_name').map((f) => String(f.value).toLowerCase()));
  if (names.length < 2 || !old.size) return result;
  const fresh = names.filter((f) => !old.has(String(f.value).toLowerCase()));
  if (!fresh.length || fresh.length === names.length) return result;
  const filters = (s.filters || []).filter((f) => f.field !== 'player_name').concat(fresh);
  return { ...result, spec: { ...s, filters, assumptions: [...(s.assumptions || []), `Searched for the new name “${fresh.map((f) => f.value).join(' ')}” only.`].slice(0, 8) } };
}

// A recommendation ("Golden-boy!!!") is something a scout gave in one particular report. "Show me the golden boy players" means players
// who received it, not only those whose newest report still has it, so the filter looks at any report unless the question asks for the
// latest/current one.
function defaultRecommendationScope(message, result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || s.unit !== 'player' || !(s.filters || []).some((f) => f.field === 'recommendation' && f.op === 'eq')) return result;
  if (LATEST_WORDS.test(message)) return { ...result, spec: { ...s, recommendation_scope: 'latest' } };
  return { ...result, spec: { ...s, recommendation_scope: 'all',
    assumptions: [...(s.assumptions || []), 'Matched a recommendation given in any of a player\u2019s reports (say \u201ccurrent\u201d or \u201clatest\u201d to use only the latest report).'].slice(0, 8) } };
}

// The planner may list a typed full name as separate words (players ["Andre", "Kronborg"]); words that stand next to each other
// in the question are one name, so the lookup matches "Andre Kronborg" and not every "Andre".
function mergeAdjacentNames(message, result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || !Array.isArray(s.players) || s.players.length < 2) return result;
  const text = String(message).toLowerCase().replace(/\s+/g, ' ');
  const out = [];
  for (const p of s.players) {
    const prev = out[out.length - 1];
    if (prev && text.includes(`${prev} ${p}`.toLowerCase())) out[out.length - 1] = `${prev} ${p}`;
    else out.push(p);
  }
  return out.length === s.players.length ? result : { ...result, spec: { ...s, players: out } };
}

// "<player> - find all the reports for this player and compare them": the planner sometimes returns a plain report list. When the
// question asks to compare and only names one player (no other conditions), it is a comparison of that player's reports over time.
function toCompareReports(message, result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || !/\bcompar(?:e|ing|ison)\b/i.test(message) || !['list', 'profile'].includes(s.intent)) return result;
  const nameFilters = (s.filters || []).filter((f) => f.field === 'player_name');
  const others = (s.filters || []).length - nameFilters.length + (s.tags || []).length + (s.text || []).length + (s.meaning ? 1 : 0) + (s.near ? 1 : 0);
  const named = [...(s.players || []), ...(nameFilters.length ? [nameFilters.map((f) => f.value).join(' ')] : [])];
  if (others || named.length !== 1) return result;
  return { ...result, spec: { ...s, intent: 'compare', unit: 'player', filters: [], players: named,
    assumptions: [...(s.assumptions || []), 'Compared this player\u2019s reports with each other.'].slice(0, 8) } };
}

// "top 3 best players ... and explain why": a list with a ranking plus a request to explain is a judgement over what the scouts wrote
// (comment_analysis reads the shortlisted reports and justifies the ranking). Without a request to explain it stays a plain ranked list.
const EXPLAIN_WORDS = /\b(?:explain|why|reasons?|justify|what makes)\b/i;
function explainToAnalysis(message, result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || s.intent !== 'list' || s.unit !== 'player' || !EXPLAIN_WORDS.test(message)) return result;
  if (!s.sort && !(s.limit && s.limit <= 10)) return result;
  return { ...result, spec: { ...s, intent: 'comment_analysis', limit: Math.min(s.limit || 8, 8),
    assumptions: [...(s.assumptions || []), 'You asked for an explanation, so the shortlisted reports were read and the ranking explained.'].slice(0, 8) } };
}

// "players with "JL top18 in Denmark"" is not a name search: a real player name always reaches the planner as a name token (see
// privacy.js), so a player_name filter in a question without any name token (and without "name/named/called") is a keyword search.
// Name filters carried over from the previous question are left alone.
function nameFiltersNeedAName(message, result, lastSpec, maskFn, vocab) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || !maskFn) return result;
  const old = new Set(((lastSpec && lastSpec.filters) || []).filter((f) => f.field === 'player_name').map((f) => String(f.value).toLowerCase()));
  const fresh = (s.filters || []).filter((f) => f.field === 'player_name' && !old.has(String(f.value).toLowerCase()));
  if (!fresh.length) return result;
  if (/\b(?:name|named|called)\b/i.test(message) || /\u27E6[PN]\d+\u27E7/.test(maskFn(message))) return result;
  const phrase = fresh.map((f) => f.value).join(' ');
  const note = `\u201C${phrase}\u201D is not a player name, so it was searched for in the scouts\u2019 text.`;
  const moved = { ...s, filters: (s.filters || []).filter((f) => !fresh.includes(f)), text: [...(s.text || []), { fields: ['any'], any_of: [phrase], tag_matches: [] }] };
  // a keyword such as "left-footed" is a recorded value ("Left"), not text: run the normal keyword rules (tags, recorded values) on it
  const spec = vocab ? normalizeSpec(moved, vocab).spec : moved;
  return { ...result, spec: { ...spec, assumptions: [...(spec.assumptions || []), note].slice(0, 8) } };
}

// "which one of these 5 has the higher ranking?": a question about who is best/higher among several named players is a ranking of
// exactly those players (overall score, potential breaks ties), with an explanation only if one is asked for.
const RANK_WORDS = /\b(?:which|who)\b[^?]*\b(?:higher|highest|better|best|top|ranks?|ranked|ranking|stronger|strongest|more promising|most promising)\b/i;
function rankAmongPlayers(message, result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || (s.players || []).length < 2 || !['compare', 'comment_analysis', 'list'].includes(s.intent) || !RANK_WORDS.test(message)) return result;
  const sortable = s.sort && ['overall_score', 'overall_potential_score'].includes(s.sort.field);
  return { ...result, spec: { ...s, intent: EXPLAIN_WORDS.test(message) ? 'comment_analysis' : 'list', unit: 'player',
    filters: (s.filters || []).filter((f) => f.field !== 'player_name'), sort: sortable ? s.sort : { field: 'overall_score', direction: 'desc' },
    limit: Math.min(s.players.length, 8),
    assumptions: [...(s.assumptions || []), 'Ranked the named players by overall score (potential breaks ties).'].slice(0, 8) } };
}

// "Why not Mikael?" / "what about Mikael?" / "include Mikael" after a list or ranking: that player is added to the players of the
// previous answer and everyone is ranked together. Returns { players, intent } or null.
const ADD_WORDS = /\b(?:why not|what about|how about|include|add|also include|and also)\b/i;
function addToPreviousSet(message, context, mentioned) {
  if (!ADD_WORDS.test(message) || !Array.isArray(mentioned) || mentioned.length !== 1) return null;
  const last = [...((context && context.turns) || [])].reverse().find((t) => t.route === 'data' && t.player_names && t.player_names.length);
  if (!last) return null;
  const prev = last.player_names.slice(0, 4);
  if (last.player_names.some((n) => String(n).toLowerCase() === String(mentioned[0]).toLowerCase())) return null; // already in it
  return { players: [...prev, mentioned[0]], intent: last.intent === 'comment_analysis' ? 'comment_analysis' : 'list' };
}

// "Which one of these 5 ...": when the question counts N players and N is exactly the number of distinct players shown in the recent
// turns together (two searches: 1 + 4), those players are the set, whatever the planner listed (it sometimes leaves one out).
const THESE_N = /\b(?:these|those|all|the)\s+(\d+)\b/i;
function focusSetFromContext(message, context, result) {
  const s = result && result.route === 'data' && result.spec;
  const m = THESE_N.exec(String(message));
  if (!s || !m || ['count', 'group_count', 'aggregate', 'profile'].includes(s.intent)) return result;
  const n = Number(m[1]);
  const seen = [];
  for (const t of (context && context.turns) || []) {
    if (t.route !== 'data') continue;
    for (const name of t.player_names || []) if (!seen.some((x) => x.toLowerCase() === String(name).toLowerCase())) seen.push(name);
  }
  if (n < 2 || n > 8 || seen.length !== n) return result;
  const same = (s.players || []).length === n && seen.every((x) => s.players.some((y) => y.toLowerCase() === x.toLowerCase()));
  if (same) return result;
  return { ...result, spec: { ...s, players: seen, filters: (s.filters || []).filter((f) => f.field !== 'player_name'),
    assumptions: [...(s.assumptions || []), `Used the ${n} players shown in your recent questions.`].slice(0, 8) } };
}

// "Who were the scouts who found these players?" / "which scouts wrote about them?": a question about the SCOUTS of the players of the
// previous answer. Returns { players, recommendation } (recommendation = the value the previous question filtered on, e.g. a golden
// boy, so the answer can also say who gave it) or null.
const SCOUT_WORDS = /\bscouts?\b|\bwho\b[^?]*\b(?:found|discovered|spotted|recommended|reported|wrote|assessed|scouted|watched|identified|rated)\b/i;
function scoutsOfPreviousPlayers(message, context) {
  if (!SCOUT_WORDS.test(message) || !/\b(?:these|those|them|they|their)\b/i.test(message) || /\b(?:how many|average|per)\b/i.test(message)) return null;
  const turns = (context && context.turns) || [];
  const last = [...turns].reverse().find((t) => t.route === 'data' && t.player_names && t.player_names.length);
  if (!last || last.player_names.length > 8) return null;
  const rec = ((context && context.lastSpec && context.lastSpec.filters) || []).find((f) => f.field === 'recommendation' && f.op === 'eq');
  return { players: last.player_names.slice(0, 8), recommendation: rec ? String(rec.value) : null };
}

// "only the left-footed ones": the planner occasionally drops the condition and repeats the previous list. If the question names a
// foot and the plan has no foot filter and no keyword/tag/meaning search at all, the foot filter is added.
const FOOT_PHRASE = /\b(left|right)[\s-]*(?:footed|foot|feet)\b|\b(two|both)[\s-]*(?:footed|feet)\b/i;
function ensureFootFilter(message, result, vocab) {
  const s = result && result.route === 'data' && result.spec;
  const m = FOOT_PHRASE.exec(String(message));
  if (!s || !m || !vocab || !Array.isArray(vocab.strongFoot) || ['profile', 'compare'].includes(s.intent)) return result;
  if ((s.filters || []).some((f) => f.field === 'strong_foot') || (s.tags || []).length || (s.text || []).length || s.meaning) return result;
  const want = (m[1] || m[2]).toLowerCase();
  const value = vocab.strongFoot.find((v) => { const n = String(v).toLowerCase(); return want === 'left' || want === 'right' ? n === want : /two|both/.test(n); });
  if (!value) return result;
  return { ...result, spec: { ...s, filters: [...(s.filters || []), { field: 'strong_foot', op: 'eq', value: String(value) }],
    assumptions: [...(s.assumptions || []), `Added the foot condition (${value}) from your question.`].slice(0, 8) } };
}

// "Show me all the strikers assessed, and then rank the best 3": two requests in one message. The planner turns the second one into a
// limit and the first one is lost; instead everyone is listed (ranked) and the best N are called out in the answer (spec.top_n).
const SHOW_ALL_THEN_RANK = /\b(?:show|list|find|display|give)\b[^?]*\ball\b[^?]*?(?:,|\band\b|\bthen\b)[^?]*\b(?:rank|ranking|top|best)\b[^?]*?\b(\d+)\b/i;
function showAllThenRank(message, result) {
  const s = result && result.route === 'data' && result.spec;
  const m = SHOW_ALL_THEN_RANK.exec(String(message));
  if (!s || !m || s.unit !== 'player' || !['list', 'comment_analysis'].includes(s.intent)) return result;
  const n = Number(m[1]);
  if (!(n >= 1 && n <= 10) || (s.limit && s.limit !== n)) return result;
  return { ...result, spec: { ...s, intent: 'list', limit: 25, top_n: n,
    sort: s.sort && ['overall_score', 'overall_potential_score'].includes(s.sort.field) ? s.sort : { field: 'overall_score', direction: 'desc' },
    assumptions: [...(s.assumptions || []), `Listed all matching players ranked by score, and picked out the best ${n}.`].slice(0, 8) } };
}

// "How many feedback reports ...", "which coach ...", "show the assessments of ...": the kind of report the question names is applied
// when the plan forgot it. Players: has at least one report of that kind; reports: report_type. Both kinds named = no restriction.
const FEEDBACK_WORDS = /\bfeedbacks?\b|\bcoach(?:es|ed)?\b/i;
const ASSESSMENT_WORDS = /\bassess(?:ments?|ed)\b/i; // "assessment(s)", "strikers assessed"
function reportTypeFromWords(message, result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || ['profile', 'compare'].includes(s.intent)) return result;
  const fb = FEEDBACK_WORDS.test(message), as = ASSESSMENT_WORDS.test(message);
  if (fb === as) return result;
  const type = fb ? 'feedback' : 'assessment';
  const filters = s.filters || [];
  if (filters.some((f) => ['report_type', 'feedback_count', 'assessment_count'].includes(f.field))) return result;
  const add = s.unit === 'report' ? { field: 'report_type', op: 'eq', value: type } : { field: `${type}_count`, op: 'gt', value: 0 };
  return { ...result, spec: { ...s, filters: [...filters, add],
    assumptions: [...(s.assumptions || []), `Only ${type} reports, as your question says.`].slice(0, 8) } };
}

// "U14": newer players carry labels like "U13/14" or "U14/15", older ones only a birth year.
// U14 = a label that mentions 14, or born in (this year - 13) (the under-N season convention).
function ageBandFromWords(message, result, year = new Date().getFullYear()) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || /\bU\s?\d{1,2}\s*\/\s*\d/i.test(message)) return result; // an exact label ("U13/14") is matched as written
  const m = /\bU\s?-?(\d{1,2})\b/i.exec(message); // "under 16 years old" is an age limit, not the U16 band
  if (!m) return result;
  const n = Number(m[1]);
  if (n < 6 || n > 23) return result;
  const born = year - n + 1;
  const filters = (s.filters || []).filter((f) => f.field !== 'age_group_label' && !(f.field === 'age_group' && ['eq', 'gte', 'lte', 'gt', 'lt'].includes(f.op)));
  filters.push({ field: 'age_group_label', op: 'u_age', value: n });
  const note = `U${n} = players whose age group label mentions ${n} (e.g. U${n - 1}/${n}, U${n}/${n + 1}) or, for players with only a birth year, born in ${born}.`;
  return { ...result, spec: { ...s, filters, assumptions: [...(s.assumptions || []), note] } };
}

// A player has one position, so two position conditions ("No. 9" and "Forward" for strikers) mean EITHER of them.
function mergePositionAlternatives(result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s) return result;
  let filters = [...(s.filters || [])];
  let changed = false;
  for (const field of ['position', 'secondary_position']) {
    const same = filters.filter((f) => f.field === field && ['contains', 'eq'].includes(f.op));
    if (same.length < 2) continue;
    filters = filters.filter((f) => !same.includes(f)).concat({ field, op: 'contains_any', value: [...new Set(same.map((f) => String(f.value)))] });
    changed = true;
  }
  // both kinds of report named as two conditions ("assessment" AND "feedback") = no restriction on the kind
  const kinds = new Set(filters.filter((f) => f.field === 'report_type' && f.op === 'eq').map((f) => String(f.value)));
  if (kinds.size > 1) { filters = filters.filter((f) => f.field !== 'report_type'); changed = true; }
  return changed ? { ...result, spec: { ...s, filters } } : result;
}

// "players with speed": the tag "Speed" already says it; a keyword search for the same word in the comments, required as well,
// only removes players (and widens the search to every report). Keywords equal to a tag of the plan are dropped.
const normWords = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function dropTextRepeatingTags(result) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || !(s.tags || []).length || !(s.text || []).length || s.content_logic === 'any') return result;
  const tagWords = new Set((s.tags || []).flatMap((t) => t.any_of || []).map(normWords));
  let changed = false;
  const text = (s.text || []).map((t) => {
    const keep = (t.any_of || []).filter((term) => !tagWords.has(normWords(term)));
    if (keep.length !== (t.any_of || []).length) changed = true;
    return { ...t, any_of: keep };
  }).filter((t) => t.any_of.length);
  return changed ? { ...result, spec: { ...s, text } } : result;
}

// The answer to "Which player do you mean by X: A, B?" -> the chosen option (full name, a distinctive part, or "the first one"), else null.
const ORDINALS = [/\b(?:first|1st|one)\b|^\s*1\s*$/i, /\b(?:second|2nd|two)\b|^\s*2\s*$/i, /\b(?:third|3rd|three)\b|^\s*3\s*$/i];
function pickOption(message, options) {
  if (!message || !options || !options.length) return null;
  const { foldText } = require('./fold');
  const m = foldText(message).replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const folded = options.map((o) => foldText(o));
  const exact = folded.findIndex((o) => m === o || m.includes(o));
  if (exact >= 0) return options[exact];
  const words = m.split(/[\s-]+/).filter((w) => w.length >= 3 && !/^(the|one|player|mean|meant|with|him|her)$/.test(w));
  if (words.length) {
    const hits = folded.map((o, i) => (words.every((w) => o.split(/[\s-]+/).includes(w)) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return options[hits[0]];
    if (hits.length > 1) return null;
  }
  if (/\blast\b/i.test(message)) return options[options.length - 1];
  const ord = ORDINALS.findIndex((re) => re.test(message));
  return ord >= 0 && ord < options.length ? options[ord] : null;
}

module.exports = { ageBandFromWords, pickOption, dropTextRepeatingTags, mergePositionAlternatives, reportTypeFromWords, showAllThenRank, ensureFootFilter, scoutsOfPreviousPlayers, focusSetFromContext, rankAmongPlayers, addToPreviousSet, nameFiltersNeedAName, explainToAnalysis, toCompareReports, carryFollowUp, defaultTextScope, collapseNameFilters, defaultRecommendationScope, mergeAdjacentNames, REFERS_BACK };
