// Turns a validated spec into parameterised SQL.
//  unit "player": over player_latest (one row per player, latest report – a maintained table)
//  unit "report": over report_facts (one row per report)
// Content conditions (tags / keyword text / meaning) are matched on the latest report (content_scope "latest")
// or on any of the player's reports (content_scope "all").
const { FIELDS, SORT_FIELDS, TIME_GROUPS, DEFAULT_LIMIT } = require('./spec');
const { textConditionSql } = require('./fts');

const OP_SQL = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
const GROUP_LIMIT = 200;

const PLAYER_COLS = `pl.player_id, pl.report_id, pl.player_name AS name, pl.position, pl.secondary_position, pl.team_name,
  pl.location, pl.age_group, pl.jersey_number, pl.strong_foot, pl.stage_of_growth, pl.overall_score,
  pl.overall_potential_score, pl.recommendation, pl.scout_name, pl.father_height_mid, pl.mother_height_mid,
  pl.x_factor, pl.report_date, pl.report_count, pl.score_change`;
const REPORT_COLS = `pl.report_id, pl.player_id, pl.player_name AS name, pl.position, pl.team_name, pl.location, pl.age_group,
  pl.report_date, pl.scout_name, pl.stage_of_growth, pl.overall_score, pl.overall_potential_score, pl.recommendation, pl.x_factor`;

/** Which column links a content match to the row: the row's report (latest / report unit) or the player (all reports). */
function keyOf(spec) {
  if (spec.unit === 'report') return { rowKey: 'pl.report_id', matchKey: 'report_id' };
  return spec.content_scope === 'all'
    ? { rowKey: 'pl.player_id', matchKey: 'player_id' }
    : { rowKey: 'pl.report_id', matchKey: 'report_id' };
}

/**
 * Builds { cte, join, where, params, add, relevance } for a spec.
 * meaningRes: output of retrieval.resolveMeaning (or null). near: geo result (or null).
 * exclude: a condition key to leave out (used for coverage queries).
 */
function buildWhere(spec, near, meaningRes, { exclude } = {}) {
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const k = keyOf(spec);
  const parts = [];

  spec.filters.forEach((f, i) => {
    if (exclude === `filter:${i}`) return;
    const def = FIELDS[f.field];
    const col = `pl.${def.col}`;
    if (f.op === 'is_null') return parts.push(`${col} IS NULL`);
    if (f.op === 'not_null') return parts.push(`${col} IS NOT NULL`);
    if (def.kind === 'text') {
      if (f.op === 'contains') return parts.push(`${col} ILIKE ${add(`%${f.value}%`)}`);
      if (f.op === 'neq') return parts.push(`(${col} IS NULL OR lower(${col}) <> lower(${add(f.value)}))`);
      if (OP_SQL[f.op]) return parts.push(`${col} ${OP_SQL[f.op]} ${add(f.value)}`); // e.g. report_month >= '2025-01'
      return parts.push(`lower(${col}) = lower(${add(f.value)})`);
    }
    const p = add(f.value);
    if (OP_SQL[f.op]) return parts.push(`${col} ${OP_SQL[f.op]} ${p}`);
    if (f.op === 'contains') return parts.push(`${col}::text ILIKE ${add(`%${f.value}%`)}`);
    return parts.push(f.op === 'neq' ? `(${col} IS NULL OR ${col} <> ${p})` : `${col} = ${p}`);
  });

  if (near && exclude !== 'near') {
    parts.push(near.locations.length ? `pl.location = ANY(${add(near.locations.map((l) => l.location))}::text[])` : 'FALSE');
  }

  if (spec.players && spec.players.length && spec.resolvedPlayerIds) {
    parts.push(`pl.player_id = ANY(${add(spec.resolvedPlayerIds)}::int[])`);
  }

  // ---- content conditions ----
  const content = [];
  spec.tags.forEach((t, i) => {
    if (exclude === `tag:${i}`) return;
    content.push(`${k.rowKey} IN (SELECT rt.${k.matchKey} FROM report_tags rt WHERE rt.category = ${add(t.category)} AND rt.tag = ANY(${add(t.any_of)}::text[]))`);
  });
  // keyword search = free-text part (per-player vectors in player_text – latest or all reports – or the report's own
  // vectors) OR the vocabulary tags containing the words (exact, via report_tags)
  spec.text.forEach((t, i) => {
    if (exclude === `text:${i}`) return;
    const or = [];
    if (t.fields.length) {
      if (spec.unit === 'report') or.push(textConditionSql(t, add, 'pl', 'tsv_'));
      else {
        const prefix = spec.content_scope === 'all' ? 'tsv_all_' : 'tsv_';
        or.push(`pl.player_id IN (SELECT pt.player_id FROM player_text pt WHERE ${textConditionSql(t, add, 'pt', prefix)})`);
      }
    }
    for (const tm of t.tag_matches || []) {
      or.push(`${k.rowKey} IN (SELECT rt.${k.matchKey} FROM report_tags rt WHERE rt.category = ${add(tm.category)} AND rt.tag = ANY(${add(tm.any_of)}::text[]))`);
    }
    content.push(or.length ? `(${or.join(' OR ')})` : 'FALSE');
  });

  let cte = '', join = '', relevance = null;
  if (spec.meaning && exclude !== 'meaning') {
    const m = meaningRes;
    if (!m || (!m.chunks.length && !m.tags.length)) {
      content.push('FALSE');
    } else {
      const unions = [];
      if (m.chunks.length) {
        const textFields = m.fields.filter((f) => f === 'x_factor' || f === 'comment');
        const fieldCond = m.fields.includes('any') || !textFields.length ? '' : ` WHERE rc.field = ANY(${add(textFields)}::text[])`;
        unions.push(`SELECT rc.${k.matchKey} AS k, m.sim FROM report_chunks rc
          JOIN unnest(${add(m.chunks.map((c) => c.id))}::bigint[], ${add(m.chunks.map((c) => c.sim))}::float8[]) AS m(id, sim) ON m.id = rc.chunk_id${fieldCond}`);
      }
      if (m.tags.length) {
        unions.push(`SELECT rt.${k.matchKey} AS k, m.sim FROM report_tags rt
          JOIN unnest(${add(m.tags.map((t) => t.category))}::text[], ${add(m.tags.map((t) => t.tag))}::text[], ${add(m.tags.map((t) => t.sim))}::float8[])
            AS m(cat, tag, sim) ON rt.category = m.cat AND rt.tag = m.tag`);
      }
      if (unions.length) {
        cte = `WITH mrel AS (SELECT k, max(sim) AS sim FROM (${unions.join(' UNION ALL ')}) u GROUP BY k) `;
        join = ` LEFT JOIN mrel ON mrel.k = ${k.rowKey}`;
        content.push('mrel.k IS NOT NULL');
        relevance = 'mrel.sim';
      } else content.push('FALSE');
    }
  }
  if (content.length) parts.push(`(${content.join(spec.content_logic === 'any' ? ' OR ' : ' AND ')})`);

  return { cte, join, where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params, add, relevance };
}

const relation = (spec) => (spec.unit === 'report' ? 'report_facts' : 'player_latest');

function orderBy(spec, relevance) {
  const sort = spec.sort && SORT_FIELDS.includes(spec.sort.field) ? spec.sort : null;
  if (sort) return `pl.${FIELDS[sort.field].col} ${sort.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, pl.player_name ASC`;
  const def = spec.unit === 'report'
    ? 'pl.report_date DESC NULLS LAST, pl.report_id DESC'
    : "(pl.recommendation ILIKE 'Golden%') DESC, pl.overall_score DESC NULLS LAST, pl.overall_potential_score DESC NULLS LAST, pl.player_name ASC";
  return relevance ? `${relevance} DESC NULLS LAST, ${def}` : def;
}

/**
 * Returns the SQL to run for a spec:
 *  countSql (always), listSql (list-like intents), groupSql (group_count / grouped aggregate),
 *  aggSql (ungrouped aggregate), coverage (sparse-field data coverage checks).
 */
function buildQueries(spec, near, meaningRes) {
  const w = buildWhere(spec, near, meaningRes);
  const from = `${w.cte}SELECT %COLS% FROM ${relation(spec)} pl${w.join} ${w.where}`;
  const out = { countSql: from.replace('%COLS%', 'COUNT(*)::int AS count'), params: [...w.params], unit: spec.unit };

  const groupKey = spec.group_by ? `pl.${FIELDS[spec.group_by].col}` : null;
  const timeOrder = spec.group_by && TIME_GROUPS.has(spec.group_by);
  if (spec.intent === 'group_count' && groupKey) {
    out.groupSql = `${from.replace('%COLS%', `${groupKey} AS key, COUNT(*)::int AS count`)}
      GROUP BY 1 ORDER BY ${timeOrder ? '1 ASC NULLS LAST' : '2 DESC, 1 ASC NULLS LAST'} LIMIT ${GROUP_LIMIT}`;
  }
  if (spec.intent === 'aggregate' && spec.aggregate) {
    const col = `pl.${FIELDS[spec.aggregate.field].col}`;
    const fn = { avg: 'AVG', min: 'MIN', max: 'MAX', sum: 'SUM' }[spec.aggregate.fn];
    if (groupKey) {
      out.groupSql = `${from.replace('%COLS%', `${groupKey} AS key, ${fn}(${col})::float8 AS value, COUNT(${col})::int AS n, COUNT(*)::int AS count`)}
        GROUP BY 1 HAVING COUNT(${col}) > 0
        ORDER BY ${timeOrder ? '1 ASC NULLS LAST' : `2 ${spec.sort && spec.sort.direction === 'asc' ? 'ASC' : 'DESC'}, 1 ASC NULLS LAST`} LIMIT ${GROUP_LIMIT}`;
    } else {
      out.aggSql = from.replace('%COLS%', `${fn}(${col})::float8 AS value, COUNT(${col})::int AS n`);
    }
  }
  if (['list', 'comment_analysis', 'profile', 'compare'].includes(spec.intent)) {
    const listParams = [...w.params];
    const lim = `$${listParams.push(spec.limit || DEFAULT_LIMIT)}`;
    out.listSql = `${from.replace('%COLS%', `${spec.unit === 'report' ? REPORT_COLS : PLAYER_COLS}${w.relevance ? `, ${w.relevance} AS relevance` : ''}`)}
      ORDER BY ${orderBy(spec, w.relevance)} LIMIT ${lim}`;
    out.listParams = listParams;
  }

  // Data coverage for sparse fields used as filters: "recorded for N of M rows matching the other criteria"
  const sparse = new Map();
  spec.filters.forEach((f, i) => {
    if (FIELDS[f.field].sparse && !['is_null', 'not_null'].includes(f.op) && !sparse.has(f.field)) sparse.set(f.field, i);
  });
  out.coverage = [...sparse.entries()].map(([field]) => {
    const others = { ...spec, filters: spec.filters.filter((f) => f.field !== field) };
    const cw = buildWhere(others, near, meaningRes);
    return {
      field,
      sql: `${cw.cte}SELECT COUNT(*)::int AS total, COUNT(pl.${FIELDS[field].col})::int AS known FROM ${relation(spec)} pl${cw.join} ${cw.where}`,
      params: cw.params,
    };
  });
  return out;
}

module.exports = { buildQueries, buildWhere, keyOf };
