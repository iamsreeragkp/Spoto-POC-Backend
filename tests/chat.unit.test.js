// Pure unit tests (no database, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpec, normalizePlan } = require('../src/chat/spec');
const { tsQueryText, textConditionSql } = require('../src/chat/fts');
const { redactComment, likelyNames } = require('../src/chat/redact');
const { userPrompt } = require('../src/chat/llm/prompt');

process.env.EMBEDDING_PROVIDER = 'mock';
const { embed } = require('../src/chat/embeddings');

const vocab = { tags: { physical: [{ tag: 'Pace/speed' }, { tag: 'Acceleration' }], mental: [], technical: [], tactical: [], deadball: [] } };

test('normalizeSpec snaps tags to the vocabulary and falls back to text', () => {
  const { spec, warnings } = normalizeSpec({
    intent: 'count', filters: [], text: [], content_logic: 'all', near: null,
    tags: [{ category: 'physical', any_of: ['pace/speed', 'Jumping ability'] }],
  }, vocab);
  assert.deepEqual(spec.tags, [{ category: 'physical', any_of: ['Pace/speed'] }]);
  assert.deepEqual(spec.text, [{ fields: ['x_factor', 'comment'], any_of: ['Jumping ability'], tag_matches: [] }]);
  assert.equal(warnings.length, 1);
});

test('normalizeSpec: phase-1 specs get phase-2 defaults', () => {
  const { spec } = normalizeSpec({ intent: 'list', filters: [], tags: [], text: [] }, vocab);
  assert.equal(spec.unit, 'player');
  assert.equal(spec.content_scope, 'latest');
  assert.equal(spec.meaning, null);
  assert.deepEqual(spec.players, []);
});

test('normalizeSpec: player-only fields are rejected for the report unit', () => {
  const { spec, warnings } = normalizeSpec({ intent: 'count', unit: 'report', filters: [{ field: 'report_count', op: 'gte', value: '2' }] }, vocab);
  assert.equal(spec.filters.length, 0);
  assert.match(warnings.join(' '), /only available per player/);
});

test('normalizeSpec: aggregate without a valid statistic falls back to count', () => {
  const { spec } = normalizeSpec({ intent: 'aggregate', aggregate: { fn: 'median', field: 'overall_score' } }, vocab);
  assert.equal(spec.intent, 'count');
  const ok = normalizeSpec({ intent: 'aggregate', aggregate: { fn: 'avg', field: 'player_name' } }, vocab).spec;
  assert.equal(ok.intent, 'count', 'text fields cannot be averaged');
});

test('normalizeSpec: limits, players and meaning are bounded', () => {
  const { spec } = normalizeSpec({
    intent: 'compare', limit: 10000, players: ['A', 'B', 'C', 'D', 'E', 'F', 'A'],
    meaning: { query: 'x'.repeat(1000), fields: ['bogus'] },
  }, vocab);
  assert.equal(spec.limit, 100);
  assert.equal(spec.players.length, 5);
  assert.equal(spec.meaning.query.length, 300);
  assert.deepEqual(spec.meaning.fields, ['any']);
});

test('normalizePlan handles every route', () => {
  assert.equal(normalizePlan({ route: 'general', reply: null, spec: null }, vocab).route, 'general');
  assert.equal(normalizePlan({ route: 'help', reply: null, spec: null }, vocab).route, 'help');
  const refuse = normalizePlan({ route: 'refuse', reply: null, spec: null }, vocab);
  assert.equal(refuse.route, 'refuse');
  assert.ok(refuse.reply, 'refuse always has a reply');
  const noSpec = normalizePlan({ route: 'data', reply: null, spec: null }, vocab);
  assert.equal(noSpec.route, 'clarify');
  const bare = normalizePlan({ intent: 'count', filters: [] }, vocab);
  assert.equal(bare.route, 'data');
  assert.equal(normalizePlan({ route: 'nonsense', spec: null }, vocab).route, 'clarify');
});

test('tsQueryText: prefix stems, phrases, alternatives, no syntax injection', () => {
  assert.equal(tsQueryText(['dribbl']), 'dribbl:*');
  assert.equal(tsQueryText(['carries the ball', 'agility']), '(carries <-> the <-> ball:*) | agility:*');
  assert.equal(tsQueryText(["xx') | !(yy & zz:*"]), '(xx <-> yy <-> zz:*)');
  assert.equal(tsQueryText(["x') | !(y"]), null, 'single letters are dropped');
  assert.equal(tsQueryText(['!!', '']), null);
});

test('textConditionSql: one indexed vector per field; latest vs all reports', () => {
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  assert.equal(textConditionSql({ fields: ['x_factor'], any_of: ['dribbl'] }, add, 'pl', 'tsv_'), "(pl.tsv_x @@ to_tsquery('english', $1))");
  assert.equal(textConditionSql({ fields: ['any'], any_of: ['agility'] }, add, 'pl', 'tsv_all_'),
    "(pl.tsv_all_x @@ to_tsquery('english', $2) OR pl.tsv_all_c @@ to_tsquery('english', $2) OR pl.tsv_all_t @@ to_tsquery('english', $2))");
});

test('normalizeSpec: keyword search on tag columns becomes exact tag matches', () => {
  const v = { tags: { physical: [{ tag: 'Agility – quick feet' }, { tag: 'Pace/speed' }], mental: [], technical: [{ tag: 'Carries the ball forward' }], tactical: [], deadball: [] } };
  const one = normalizeSpec({ intent: 'count', text: [{ fields: ['physical'], any_of: ['agile'] }] }, v).spec;
  assert.deepEqual(one.text, [{ fields: [], any_of: ['agile'], tag_matches: [{ category: 'physical', any_of: ['Agility – quick feet'] }] }]);
  const any = normalizeSpec({ intent: 'list', text: [{ fields: ['any'], any_of: ['carries the ball', 'agility'] }] }, v).spec;
  assert.deepEqual(any.text[0].fields, ['x_factor', 'comment'], '"any" = free text + tag vocabulary');
  assert.deepEqual(any.text[0].tag_matches, [
    { category: 'physical', any_of: ['Agility – quick feet'] }, { category: 'technical', any_of: ['Carries the ball forward'] }]);
  const none = normalizeSpec({ intent: 'count', text: [{ fields: ['physical'], any_of: ['zebra'] }] }, v);
  assert.deepEqual(none.spec.text, [{ fields: [], any_of: ['zebra'], tag_matches: [] }], 'kept, matches nothing (faithful)');
  assert.match(none.warnings.join(' '), /No physical tag contains: zebra/);
});

test('redactComment masks mid-sentence names but keeps labels', () => {
  const out = redactComment('He plays well. Technical: very good. Reminds me of Joakim Mæhle and Alex was composed.', ['Alex']);
  assert.ok(!/Joakim|Mæhle|Alex/.test(out), out);
  assert.match(out, /Technical:/);
});

test('redactComment masks names at the start of a sentence and only as whole words', () => {
  const out = redactComment('Alex was very composed. Both feet are good. Bo scored twice.', ['Alex', 'Bo']);
  assert.equal(out, '[name] was very composed. Both feet are good. [name] scored twice.');
});

test('likelyNames keeps capitalised-only words that look like names, drops English words', () => {
  assert.deepEqual(likelyNames(['Alex', 'Emil', 'Mads', 'Anders', 'Amazing', 'Celebrated', 'Unselfishly', 'Physical', 'June']),
    ['Alex', 'Emil', 'Mads', 'Anders']);
});

test('planner context lists previous turns and players shown', () => {
  const p = userPrompt('only the left-footed ones', {
    turns: [{ question: 'Show the centre-backs', route: 'data', intent: 'list', count: 27, player_names: ['Player 2', 'Player 25'] }],
    lastSpec: { intent: 'list' },
  });
  assert.match(p, /players shown in order: Player 2, Player 25/);
  assert.match(p, /Previous data spec/);
  assert.match(p, /Question: only the left-footed ones$/);
});

test('mock embeddings: related wording is closer than unrelated wording', async () => {
  const [a, b, c] = await embed(['natural leader of the team', 'he leads his teammates like a leader', 'strong left-footed free kicks']);
  const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
  assert.ok(dot(a, b) > dot(a, c));
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-6);
});

test('normalizeSpec: an exact filter on a fixed-list field with an unknown value becomes a text search', () => {
  const v = { ...vocab, recommendations: ['Golden Boy!!!', 'Needs to be watched again!'], stageOfGrowth: ['Average developed'], strongFoot: ['Right', 'Left'] };
  const { spec, warnings } = normalizeSpec({ intent: 'count', filters: [{ field: 'recommendation', op: 'eq', value: 'JL Top 18 in Denmark.' }] }, v);
  assert.equal(spec.filters.length, 0);
  assert.deepEqual(spec.text, [{ fields: ['x_factor', 'comment'], any_of: ['JL Top 18 in Denmark.'], tag_matches: [] }]);
  assert.match(warnings.join(' '), /not one of the recorded recommendation values/);
  const ok = normalizeSpec({ intent: 'count', filters: [{ field: 'recommendation', op: 'eq', value: 'golden boy' }, { field: 'strong_foot', op: 'eq', value: 'Left' }] }, v).spec;
  assert.equal(ok.filters.length, 2, 'known values are kept');
  assert.equal(ok.filters[0].value, 'Golden Boy!!!', 'case/punctuation differences are mapped to the stored wording');
});

test('normalizeSpec: a keyword equal to a recorded recommendation becomes that filter; a tag word is not a position', () => {
  const v = { ...vocab, recommendations: ['Golden-boy!!!', 'Needs to be watched again!'], stageOfGrowth: [], strongFoot: ['Right', 'Left'], positions: ['No. 9', 'Right winger'] };
  const a = normalizeSpec({ intent: 'count', text: [{ fields: ['any'], any_of: ['Golden Boy!!!'] }] }, v);
  assert.deepEqual(a.spec.filters, [{ field: 'recommendation', op: 'eq', value: 'Golden-boy!!!' }]);
  assert.equal(a.spec.text.length, 0);
  const b = normalizeSpec({ intent: 'count', text: [{ fields: ['any'], any_of: ['right'] }] }, v);
  assert.equal(b.spec.filters.length, 0, 'short words stay keyword searches');
  const c = normalizeSpec({ intent: 'count', filters: [{ field: 'position', op: 'contains', value: 'Speed' }] }, v);
  assert.equal(c.spec.filters.length, 0);
  assert.match(c.warnings.join(' '), /skill tag, not a playing position/);
  const d = normalizeSpec({ intent: 'count', filters: [{ field: 'position', op: 'contains', value: 'winger' }] }, v);
  assert.equal(d.spec.filters.length, 1, 'real positions are untouched');
});

test('carryFollowUp puts back conditions the planner dropped in "of those" follow-ups', () => {
  const { carryFollowUp } = require('../src/chat/followup');
  const last = { intent: 'list', filters: [{ field: 'position', op: 'contains', value: 'winger' }], tags: [{ category: 'physical', any_of: ['Speed'] }], text: [], meaning: null, near: null, content_logic: 'all', content_scope: 'latest' };
  const dropped = { route: 'data', spec: { intent: 'count', filters: [{ field: 'age_group', op: 'eq', value: 2013 }], tags: [], text: [], meaning: null, near: null, players: ['A', 'B'], assumptions: [] } };
  const out = carryFollowUp('how many of those were born in 2013?', last, dropped).spec;
  assert.deepEqual(out.filters.map((f) => f.field), ['position', 'age_group']);
  assert.equal(out.tags.length, 1);
  assert.deepEqual(out.players, []);
  assert.match(out.assumptions.join(' '), /Kept the conditions/);
  // new topic / no back-reference / already merged: untouched
  assert.equal(carryFollowUp('how many goalkeepers are there?', last, dropped), dropped);
  const merged = { route: 'data', spec: { ...dropped.spec, filters: [...last.filters, { field: 'age_group', op: 'eq', value: 2013 }], tags: last.tags, players: [] } };
  assert.deepEqual(carryFollowUp('how many of those were born in 2013?', last, merged).spec.filters, merged.spec.filters);
  assert.equal(carryFollowUp('how many of those?', { intent: 'profile', filters: [] }, dropped), dropped);
});

test('privacy masker lists everyone who shares an ambiguous name part', () => {
  const { buildMasker } = require('../src/chat/privacy');
  const m = buildMasker([{ token: '⟦P1⟧', name: 'Carl Baker' }, { token: '⟦P2⟧', name: 'Carl Eklund Jahn' }, { token: '⟦P3⟧', name: 'Alex' }]);
  assert.deepEqual(m.ambiguous('Tell me about Carl'), ['Carl Baker', 'Carl Eklund Jahn']);
  assert.deepEqual(m.ambiguous('Tell me about Alex'), []);
});

test('normalizeSpec: "left-footed" maps to the recorded value "Left"; unrelated phrases still become text search', () => {
  const v = { ...vocab, recommendations: ['Needs to be watched again!'], stageOfGrowth: [], strongFoot: ['Right', 'Left', 'Two-footed'] };
  const a = normalizeSpec({ intent: 'count', filters: [{ field: 'strong_foot', op: 'eq', value: 'Left-footed' }] }, v).spec;
  assert.deepEqual(a.filters, [{ field: 'strong_foot', op: 'eq', value: 'Left' }]);
  const b = normalizeSpec({ intent: 'count', filters: [{ field: 'strong_foot', op: 'eq', value: 'Two footed' }] }, v).spec;
  assert.deepEqual(b.filters, [{ field: 'strong_foot', op: 'eq', value: 'Two-footed' }]);
  const c = normalizeSpec({ intent: 'count', filters: [{ field: 'recommendation', op: 'eq', value: 'JL Top 18 in Denmark.' }] }, v).spec;
  assert.equal(c.filters.length, 0);
  assert.equal(c.text.length, 1);
});
