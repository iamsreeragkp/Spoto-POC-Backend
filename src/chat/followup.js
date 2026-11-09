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

module.exports = { carryFollowUp, defaultTextScope, REFERS_BACK };
