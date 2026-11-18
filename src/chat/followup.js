// Safety net for follow-ups such as "how many of those were born in 2013?".
// The planner is told to merge the previous question's conditions into the new plan (prompt rule 14), but it
// occasionally drops them. When the wording clearly refers to the previous result ("of them", "those", "these") and the
// new plan has lost conditions the previous one had, they are put back. Conditions the new plan states itself win.
const REFERS_BACK = /\b(?:of|among|from|out of|within|in)\s+(?:them|those|these)\b|\b(?:those|these)\s+(?:ones|players|reports)\b|\bof the (?:above|previous|same)\b/i;

function carryFollowUp(message, lastSpec, result) {
  if (!lastSpec || !result || result.route !== 'data' || !result.spec) return result;
  if (!REFERS_BACK.test(message)) return result;
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
function nameFiltersNeedAName(message, result, lastSpec, maskFn) {
  const s = result && result.route === 'data' && result.spec;
  if (!s || !maskFn) return result;
  const old = new Set(((lastSpec && lastSpec.filters) || []).filter((f) => f.field === 'player_name').map((f) => String(f.value).toLowerCase()));
  const fresh = (s.filters || []).filter((f) => f.field === 'player_name' && !old.has(String(f.value).toLowerCase()));
  if (!fresh.length) return result;
  if (/\b(?:name|named|called)\b/i.test(message) || /\u27E6[PN]\d+\u27E7/.test(maskFn(message))) return result;
  const phrase = fresh.map((f) => f.value).join(' ');
  return { ...result, spec: { ...s,
    filters: (s.filters || []).filter((f) => !fresh.includes(f)),
    text: [...(s.text || []), { fields: ['any'], any_of: [phrase], tag_matches: [] }],
    assumptions: [...(s.assumptions || []), `\u201C${phrase}\u201D is not a player name, so it was searched for in the scouts\u2019 text.`].slice(0, 8) } };
}

module.exports = { nameFiltersNeedAName, explainToAnalysis, toCompareReports, carryFollowUp, defaultTextScope, collapseNameFilters, defaultRecommendationScope, mergeAdjacentNames, REFERS_BACK };
