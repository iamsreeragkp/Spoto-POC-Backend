// Builds Postgres full-text queries from the planner's search terms.
// Each text field has its own (unweighted) tsvector + GIN index – see chat_v2_schema.sql:
//   tsv_x = x-factor, tsv_c = overall comment, tsv_t = the five tag columns
// on reports / report_facts (one report), and in player_text per player, both for the latest report (tsv_*) and
// for all of the player's reports together (tsv_all_*).
// Terms are reduced to plain words before going into the query text, so no tsquery syntax can be injected.

const FIELD_COL = { x_factor: 'x', comment: 'c', tags: 't', physical: 't', mental: 't', technical: 't', tactical: 't', deadball: 't' };

const words = (term) => (String(term).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= 2);

/**
 * terms: ["dribbl", "carries the ball"] -> "dribbl:* | (carries <-> the <-> ball:*)"  (for to_tsquery('english', $1))
 * Single words are prefix-matched (stems like "dribbl" match dribbling/dribbler); phrases must appear in order.
 * Returns null when no usable words remain.
 */
// "top18" and "top 18" are different words to the index; people type both, so each term also matches the other spelling
const splitDigits = (w) => w.replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2').split(' ');
function spellings(ws) {
  const out = [ws];
  const split = ws.flatMap(splitDigits); // top18 -> top 18
  if (split.length !== ws.length) out.push(split);
  const merged = []; // top 18 -> top18
  for (let i = 0; i < ws.length; i++) {
    if (i + 1 < ws.length && /^\p{L}+$/u.test(ws[i]) && /^\p{N}+$/u.test(ws[i + 1])) { merged.push(ws[i] + ws[i + 1]); i++; } else merged.push(ws[i]);
  }
  if (merged.length !== ws.length) out.push(merged);
  return out;
}

function tsQueryText(terms) {
  const parts = [];
  for (const term of terms) {
    const ws = words(term);
    if (!ws.length) continue;
    for (const v of spellings(ws)) {
      if (v.length === 1) parts.push(`${v[0]}:*`);
      else parts.push(`(${v.map((x, i) => (i === v.length - 1 ? `${x}:*` : x)).join(' <-> ')})`);
    }
  }
  return parts.length ? [...new Set(parts)].join(' | ') : null;
}

/** Vector columns to search for a set of fields. */
function fieldCols(fields) {
  if (!fields || !fields.length || fields.includes('any')) return ['x', 'c', 't'];
  return [...new Set(fields.map((f) => FIELD_COL[f]).filter(Boolean))];
}

/**
 * SQL condition for one text entry. alias = table alias, prefix = 'tsv_' (one report) or 'tsv_all_' (all reports).
 */
function textConditionSql(t, add, alias, prefix = 'tsv_') {
  const q = tsQueryText(t.any_of);
  if (!q) return 'FALSE';
  const p = add(q);
  return `(${fieldCols(t.fields).map((c) => `${alias}.${prefix}${c} @@ to_tsquery('english', ${p})`).join(' OR ')})`;
}

module.exports = { tsQueryText, textConditionSql, fieldCols, words };
