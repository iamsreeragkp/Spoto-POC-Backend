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
    intent: 'compare', limit: 10000, players: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'A'],
    meaning: { query: 'x'.repeat(1000), fields: ['bogus'] },
  }, vocab);
  assert.equal(spec.limit, 100);
  assert.equal(spec.players.length, 8);
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

test('tsQueryText: "top18" and "top 18" match each other; words without digits are unchanged', () => {
  assert.equal(tsQueryText(['JL top18 in Denmark']), '(jl <-> top18 <-> in <-> denmark:*) | (jl <-> top <-> 18 <-> in <-> denmark:*)');
  assert.equal(tsQueryText(['JL top 18 in Denmark']), '(jl <-> top <-> 18 <-> in <-> denmark:*) | (jl <-> top18 <-> in <-> denmark:*)');
  assert.equal(tsQueryText(['top18']), 'top18:* | (top <-> 18:*)');
  assert.equal(tsQueryText(['dribbl']), 'dribbl:*');
});

test('defaultTextScope: keyword searches in comments look at all reports unless the question says latest/current', () => {
  const { defaultTextScope } = require('../src/chat/followup');
  const plan = (fields, scope = 'latest', unit = 'player') => ({ route: 'data', spec: { unit, content_scope: scope, text: [{ fields, any_of: ['x'] }], assumptions: [] } });
  assert.equal(defaultTextScope('How many players with "JL top 18"?', plan(['x_factor', 'comment'])).spec.content_scope, 'all');
  assert.equal(defaultTextScope('players whose comment mentions agility', plan(['comment'])).spec.content_scope, 'all');
  assert.equal(defaultTextScope('How many players have "JL top 18" in their latest report?', plan(['x_factor', 'comment'])).spec.content_scope, 'latest');
  assert.equal(defaultTextScope('Who is currently described as a leader?', plan(['comment'])).spec.content_scope, 'latest');
  const xf = plan(['x_factor']);
  assert.equal(defaultTextScope('How many players have dribbling as x-factor?', xf), xf, 'x-factor-only searches keep latest');
  const rep = plan(['comment'], 'latest', 'report');
  assert.equal(defaultTextScope('How many reports mention speed?', rep), rep, 'report unit untouched');
  assert.match(defaultTextScope('How many players mention speed?', plan(['comment'])).spec.assumptions.join(' '), /all of each player/);
});

test('normalizeSpec: player names lose quotes and a leading "Player" (but "Player 12" stays)', () => {
  const p = (names) => normalizeSpec({ intent: 'profile', players: names }, vocab).spec.players;
  assert.deepEqual(p(['Player Jonas Lindqvist']), ['Jonas Lindqvist']);
  assert.deepEqual(p(['player Jonas Lindqvist', '“Anna Testsen”']), ['Jonas Lindqvist', 'Anna Testsen']);
  assert.deepEqual(p(['Player 12']), ['Player 12']);
  assert.deepEqual(p(['Alex']), ['Alex']);
});

test('normalizeSpec: "born in YYYY" on year_of_birth becomes the age_group cohort filter', () => {
  const { spec } = normalizeSpec({ intent: 'count', filters: [{ field: 'year_of_birth', op: 'eq', value: '2012' }] }, vocab);
  assert.deepEqual(spec.filters, [{ field: 'age_group', op: 'eq', value: 2012 }]);
});

test('collapseNameFilters: a new name replaces the previous question\u2019s name; names from the same question stay together', () => {
  const { collapseNameFilters } = require('../src/chat/followup');
  const nf = (...vals) => vals.map((value) => ({ field: 'player_name', op: 'contains', value }));
  const plan = (...vals) => ({ route: 'data', spec: { filters: nf(...vals).concat([{ field: 'position', op: 'contains', value: 'winger' }]), assumptions: [] } });
  const last = { filters: nf('Anna Testsen') };
  // follow-up "And Carl": the old name was carried over -> only the new one stays
  assert.deepEqual(collapseNameFilters(plan('Anna Testsen', 'Carl'), last).spec.filters.map((f) => f.value), ['winger', 'Carl']);
  // "Andre Kronborg": first name + surname both come from this question -> kept (AND)
  const both = plan('Andre', 'Kronborg');
  assert.equal(collapseNameFilters(both, last), both);
  assert.equal(collapseNameFilters(both, null), both, 'no previous plan: untouched');
  const one = plan('Carl');
  assert.equal(collapseNameFilters(one, last), one, 'a single name filter is untouched');
});

test('foldText: accents are removed so "Andre" matches "Andr\u00e9" and "Jorgen" matches "J\u00f8rgen"', () => {
  const { foldText, containsPattern } = require('../src/chat/fold');
  assert.equal(foldText('Andr\u00e9 Marshall'), 'andre marshall');
  assert.equal(foldText('J\u00f8rgen M\u00e6hle \u00c5se'), 'jorgen mahle ase');
  assert.equal(containsPattern('Andr\u00e9 100%_x'), '%andre 100  x%');
});

test('defaultRecommendationScope: a recommendation filter looks at any report unless the question says latest/current', () => {
  const { defaultRecommendationScope } = require('../src/chat/followup');
  const plan = (unit = 'player') => ({ route: 'data', spec: { unit, assumptions: [], filters: [{ field: 'recommendation', op: 'eq', value: 'Golden-boy!!!' }] } });
  assert.equal(defaultRecommendationScope('Show me all the golden boy players', plan()).spec.recommendation_scope, 'all');
  assert.equal(defaultRecommendationScope('Who currently has a golden boy recommendation?', plan()).spec.recommendation_scope, 'latest');
  const rep = plan('report');
  assert.equal(defaultRecommendationScope('How many reports say golden boy?', rep), rep, 'report unit untouched');
  const none = { route: 'data', spec: { unit: 'player', filters: [{ field: 'position', op: 'contains', value: 'winger' }] } };
  assert.equal(defaultRecommendationScope('wingers', none), none);
});

test('mergeAdjacentNames: first name and surname typed together become one name', () => {
  const { mergeAdjacentNames } = require('../src/chat/followup');
  const plan = (players) => ({ route: 'data', spec: { intent: 'profile', players } });
  assert.deepEqual(mergeAdjacentNames('Tell me about Andre Kronborg', plan(['Andre', 'Kronborg'])).spec.players, ['Andre Kronborg']);
  assert.deepEqual(mergeAdjacentNames('Compare Anna and Carl', plan(['Anna', 'Carl'])).spec.players, ['Anna', 'Carl'], 'two different people stay separate');
  const one = plan(['Anna Testsen']);
  assert.equal(mergeAdjacentNames('Tell me about Anna Testsen', one), one);
});

test('normalizeSpec: keywords like "left-footed" or "golden boy players" become the recorded value as a filter', () => {
  const v = { ...vocab, recommendations: ['Golden-boy!!!', 'Needs to be watched again!'], stageOfGrowth: [], strongFoot: ['Right', 'Left', 'Two-footed'], positions: ['No. 9', 'Right winger'] };
  const f = (any_of) => normalizeSpec({ intent: 'list', text: [{ fields: ['any'], any_of }] }, v).spec;
  assert.deepEqual(f(['Left-footed']).filters, [{ field: 'strong_foot', op: 'eq', value: 'Left' }]);
  assert.equal(f(['Left-footed']).text.length, 0);
  assert.deepEqual(f(['right foot']).filters, [{ field: 'strong_foot', op: 'eq', value: 'Right' }]);
  assert.deepEqual(f(['two footed']).filters, [{ field: 'strong_foot', op: 'eq', value: 'Two-footed' }]);
  assert.deepEqual(f(['golden boy players']).filters, [{ field: 'recommendation', op: 'eq', value: 'Golden-boy!!!' }]);
  assert.equal(f(['right winger']).filters.length, 0, 'a position is not a foot');
  assert.equal(f(['left back runs']).filters.length, 0, 'other words stay a keyword search');
});

test('toCompareReports: "compare" + one named player (no other conditions) means compare that player\u2019s reports', () => {
  const { toCompareReports } = require('../src/chat/followup');
  const plan = (spec) => ({ route: 'data', spec: { intent: 'list', unit: 'report', tags: [], text: [], meaning: null, near: null, players: [], assumptions: [], filters: [], ...spec } });
  const a = toCompareReports('Anna Testsen - find all the reports for this player and compare them', plan({ filters: [{ field: 'player_name', op: 'contains', value: 'Anna Testsen' }] })).spec;
  assert.equal(a.intent, 'compare');
  assert.equal(a.unit, 'player');
  assert.deepEqual(a.players, ['Anna Testsen']);
  assert.equal(a.filters.length, 0);
  const b = toCompareReports('compare the reports of Anna Testsen', plan({ players: ['Anna Testsen'] })).spec;
  assert.deepEqual(b.players, ['Anna Testsen']);
  const c = toCompareReports('Andre Kronborg compare', plan({ filters: [{ field: 'player_name', op: 'contains', value: 'Andre' }, { field: 'player_name', op: 'contains', value: 'Kronborg' }] })).spec;
  assert.deepEqual(c.players, ['Andre Kronborg']);
  const untouched = (msg, p) => { const r = plan(p); assert.equal(toCompareReports(msg, r), r); };
  untouched('find all the reports for Anna Testsen', { players: ['Anna Testsen'] });
  untouched('compare average score by position', { filters: [{ field: 'position', op: 'contains', value: 'winger' }] });
  untouched('compare Anna Testsen and Carl Baker', { players: ['Anna Testsen', 'Carl Baker'] });
});

test('explainToAnalysis: a ranked list plus "explain why" becomes a comment analysis; without it, a plain list', () => {
  const { explainToAnalysis } = require('../src/chat/followup');
  const plan = (spec) => ({ route: 'data', spec: { intent: 'list', unit: 'player', sort: { field: 'overall_score', direction: 'desc' }, limit: 3, assumptions: [], ...spec } });
  const a = explainToAnalysis('Top 3 best players and explain why they are the best', plan({}));
  assert.equal(a.spec.intent, 'comment_analysis');
  assert.equal(a.spec.limit, 3);
  const p = plan({});
  assert.equal(explainToAnalysis('Top 3 best players', p), p);
  const c = plan({ intent: 'count' });
  assert.equal(explainToAnalysis('how many and why', c), c);
  const big = explainToAnalysis('List the best players and explain why', plan({ limit: null }));
  assert.equal(big.spec.limit, 8, 'at most 8 reports are read');
  const none = plan({ sort: null, limit: null });
  assert.equal(explainToAnalysis('why are there so many players', none), none, 'no ranking: untouched');
});

test('nameFiltersNeedAName: a name filter without any name in the question becomes a keyword search; carried-over names stay', () => {
  const { nameFiltersNeedAName } = require('../src/chat/followup');
  const mask = (t) => t.replace(/Carl|Anna/g, '\u27E6N1\u27E7');
  const plan = (value) => ({ route: 'data', spec: { filters: [{ field: 'player_name', op: 'contains', value }, { field: 'position', op: 'contains', value: 'winger' }], text: [], assumptions: [] } });
  const a = nameFiltersNeedAName('How many players with "JL top18 in Denmark"?', plan('JL top18 in Denmark'), null, mask).spec;
  assert.deepEqual(a.filters.map((f) => f.field), ['position']);
  assert.deepEqual(a.text, [{ fields: ['any'], any_of: ['JL top18 in Denmark'], tag_matches: [] }]);
  const named = plan('Carl');
  assert.equal(nameFiltersNeedAName('And Carl', named, null, mask), named, 'a name token is in the question');
  const withWord = plan('Zed');
  assert.equal(nameFiltersNeedAName('players called Zed', withWord, null, mask), withWord, 'the word "called"');
  const carried = plan('Anna');
  assert.equal(nameFiltersNeedAName('how many of them are left-footed?', carried, { filters: [{ field: 'player_name', op: 'contains', value: 'Anna' }] }, mask), carried, 'carried over from the previous question');
  const p = plan('x');
  assert.equal(nameFiltersNeedAName('anything', p, null, null), p, 'no masker (mock provider): untouched');
});

test('carryFollowUp: "these 5" with five explicit players keeps exactly those players (no earlier name filter added back)', () => {
  const { carryFollowUp } = require('../src/chat/followup');
  const last = { intent: 'list', filters: [{ field: 'player_name', op: 'contains', value: 'Carl' }], tags: [], text: [], meaning: null };
  const five = ['A One', 'Carl A', 'Carl B', 'Carl C', 'Carl D'];
  const plan = { route: 'data', spec: { intent: 'comment_analysis', filters: [], tags: [], text: [], meaning: null, players: five, assumptions: [] } };
  assert.equal(carryFollowUp('Which one of these 5 has higher ranking?', last, plan), plan);
  // without a matching count the old behaviour (reuse the previous result set) stays
  const out = carryFollowUp('Which one of these has higher ranking?', last, { route: 'data', spec: { ...plan.spec, players: ['Carl A', 'Carl B'] } });
  assert.deepEqual(out.spec.players, []);
  assert.equal(out.spec.filters.length, 1);
});

test('rankAmongPlayers: "which of these N is better" ranks exactly those players by overall score', () => {
  const { rankAmongPlayers } = require('../src/chat/followup');
  const mk = (intent, extra = {}) => ({ route: 'data', spec: { intent, unit: 'player', players: ['A', 'B', 'C'], filters: [{ field: 'player_name', op: 'contains', value: 'Carl' }], sort: null, assumptions: [], ...extra } });
  const a = rankAmongPlayers('Which one of these 3 has higher ranking?', mk('comment_analysis')).spec;
  assert.equal(a.intent, 'list');
  assert.deepEqual(a.sort, { field: 'overall_score', direction: 'desc' });
  assert.equal(a.limit, 3);
  assert.equal(a.filters.length, 0);
  assert.equal(rankAmongPlayers('Which of these 3 is best, and explain why', mk('list')).spec.intent, 'comment_analysis');
  assert.deepEqual(rankAmongPlayers('Who is the most promising of these?', mk('list', { sort: { field: 'overall_potential_score', direction: 'desc' } })).spec.sort, { field: 'overall_potential_score', direction: 'desc' });
  const untouched = mk('list');
  assert.equal(rankAmongPlayers('Show these three', untouched), untouched);
  const single = { route: 'data', spec: { intent: 'list', players: ['A'], filters: [] } };
  assert.equal(rankAmongPlayers('which is better', single), single);
});

test('addToPreviousSet: "Why not X?" adds X to the previous answer\u2019s players, unless X is already in it', () => {
  const { addToPreviousSet } = require('../src/chat/followup');
  const ctx = { turns: [{ route: 'data', intent: 'list', player_names: ['Carl A', 'Carl B'] }, { route: 'clarify', player_names: null }] };
  assert.deepEqual(addToPreviousSet('Why not Anna?', ctx, ['Anna Testsen']), { players: ['Carl A', 'Carl B', 'Anna Testsen'], intent: 'list' });
  assert.equal(addToPreviousSet('Why not Carl A?', ctx, ['Carl A']), null);
  assert.equal(addToPreviousSet('Tell me about Anna', ctx, ['Anna Testsen']), null, 'needs an "add" wording');
  assert.equal(addToPreviousSet('Why not Anna?', { turns: [] }, ['Anna Testsen']), null, 'nothing to add to');
  assert.equal(addToPreviousSet('What about Anna and Carl?', ctx, ['Anna Testsen', 'Carl A']), null, 'exactly one player');
});

test('planner context includes what the assistant asked back after a clarify turn', () => {
  const p = userPrompt('yes, he is better', { turns: [{ question: 'Why not X?', route: 'clarify', intent: null, count: null, player_names: null, answer: 'Are you asking why X was not included?' }], lastSpec: null });
  assert.match(p, /the assistant asked back: "Are you asking why X was not included\?"/);
});

test('focusSetFromContext: "these 5" = the players of the recent answers together, whatever the planner listed', () => {
  const { focusSetFromContext } = require('../src/chat/followup');
  const ctx = { turns: [{ route: 'data', player_names: ['Anna T'] }, { route: 'data', player_names: ['Carl A', 'Carl B', 'Carl C', 'Carl D'] }, { route: 'clarify', player_names: null }] };
  const plan = (players, filters = []) => ({ route: 'data', spec: { intent: 'list', players, filters, assumptions: [] } });
  // planner left one out and kept a name filter
  const a = focusSetFromContext('Which one of these 5 has higher ranking?', ctx, plan(['Carl A', 'Carl B', 'Carl C', 'Carl D'], [{ field: 'player_name', op: 'contains', value: 'Carl' }])).spec;
  assert.deepEqual(a.players, ['Anna T', 'Carl A', 'Carl B', 'Carl C', 'Carl D']);
  assert.equal(a.filters.length, 0);
  // already right: untouched
  const right = plan(['carl a', 'Anna T', 'Carl B', 'Carl C', 'Carl D']);
  assert.equal(focusSetFromContext('which of these 5 is best', ctx, right), right);
  // the count does not match the distinct players shown: untouched
  const other = plan(['Carl A']);
  assert.equal(focusSetFromContext('which of these 3 is best', ctx, other), other);
  const cnt = { route: 'data', spec: { intent: 'count', players: [], filters: [] } };
  assert.equal(focusSetFromContext('how many of these 5 are left-footed', ctx, cnt), cnt, 'counts are not about named players');
});

test('scoutsOfPreviousPlayers: a question about the scouts of "these players" uses the previous answer\u2019s players', () => {
  const { scoutsOfPreviousPlayers } = require('../src/chat/followup');
  const ctx = { turns: [{ route: 'data', intent: 'list', player_names: ['Anna Testsen', 'Carl Baker'] }], lastSpec: { filters: [{ field: 'recommendation', op: 'eq', value: 'Golden-boy!!!' }] } };
  assert.deepEqual(scoutsOfPreviousPlayers('Who were the scouts who found these players?', ctx), { players: ['Anna Testsen', 'Carl Baker'], recommendation: 'Golden-boy!!!' });
  assert.deepEqual(scoutsOfPreviousPlayers('Which scouts wrote about them?', { turns: ctx.turns, lastSpec: null }), { players: ['Anna Testsen', 'Carl Baker'], recommendation: null });
  assert.equal(scoutsOfPreviousPlayers('Who recommended them?', ctx).players.length, 2);
  assert.equal(scoutsOfPreviousPlayers('How many reports did each scout write?', ctx), null, 'no reference to the previous players');
  assert.equal(scoutsOfPreviousPlayers('Who are the scouts?', ctx), null, 'no reference to the previous players');
  assert.equal(scoutsOfPreviousPlayers('average score by scout for these players', ctx), null, 'a statistic, not a scout list');
  assert.equal(scoutsOfPreviousPlayers('Which scouts wrote about them?', { turns: [] }), null);
});

test('nameFiltersNeedAName with a vocabulary: "left-footed" given as a name becomes the recorded foot value', () => {
  const { nameFiltersNeedAName } = require('../src/chat/followup');
  const v = { ...vocab, recommendations: [], stageOfGrowth: [], strongFoot: ['Right', 'Left', 'Two-footed'], positions: ['No. 9'] };
  const plan = { route: 'data', spec: { intent: 'list', unit: 'player', filters: [{ field: 'position', op: 'contains', value: 'centre-back' }, { field: 'player_name', op: 'contains', value: 'left-footed' }], tags: [], text: [], meaning: null, players: [], assumptions: [] } };
  const out = nameFiltersNeedAName('only the left-footed ones', plan, null, (t) => t, v).spec;
  assert.deepEqual(out.filters.map((f) => `${f.field}=${f.value}`), ['position=centre-back', 'strong_foot=Left']);
  assert.equal(out.text.length, 0);
});

test('normalizeSpec: a recorded value given as a tag that does not exist ("Left-footed" as a physical tag) becomes the filter', () => {
  const v = { ...vocab, recommendations: [], stageOfGrowth: [], strongFoot: ['Right', 'Left', 'Two-footed'], positions: ['No. 9'] };
  const { spec } = normalizeSpec({ intent: 'list', tags: [{ category: 'physical', any_of: ['Left-footed'] }], text: [] }, v);
  assert.deepEqual(spec.filters, [{ field: 'strong_foot', op: 'eq', value: 'Left' }]);
  assert.equal(spec.text.length, 0);
  assert.equal(spec.tags.length, 0);
  const other = normalizeSpec({ intent: 'list', tags: [{ category: 'physical', any_of: ['Jumping ability'] }] }, v).spec;
  assert.equal(other.filters.length, 0, 'an unknown tag still falls back to a keyword search');
  assert.equal(other.text.length, 1);
});

test('normalizeSpec: the one word "Left" given as a (non-existing) tag is the strong-foot filter, but as a plain keyword it stays a keyword', () => {
  const v = { ...vocab, recommendations: [], stageOfGrowth: [], strongFoot: ['Right', 'Left', 'Two-footed'], positions: [] };
  const a = normalizeSpec({ intent: 'list', tags: [{ category: 'physical', any_of: ['Left'] }] }, v).spec;
  assert.deepEqual(a.filters, [{ field: 'strong_foot', op: 'eq', value: 'Left' }]);
  const b = normalizeSpec({ intent: 'list', text: [{ fields: ['any'], any_of: ['left'] }] }, v).spec;
  assert.equal(b.filters.length, 0);
  assert.equal(b.text.length, 1);
});

test('ensureFootFilter: a named foot with no condition in the plan gets the strong-foot filter; other plans are left alone', () => {
  const { ensureFootFilter } = require('../src/chat/followup');
  const v = { strongFoot: ['Right', 'Left', 'Two-footed'] };
  const plan = (spec) => ({ route: 'data', spec: { intent: 'list', filters: [{ field: 'position', op: 'contains', value: 'centre-back' }], tags: [], text: [], meaning: null, assumptions: [], ...spec } });
  assert.deepEqual(ensureFootFilter('only the left-footed ones', plan({}), v).spec.filters.map((f) => f.value), ['centre-back', 'Left']);
  assert.equal(ensureFootFilter('and the right foot players?', plan({}), v).spec.filters[1].value, 'Right');
  assert.equal(ensureFootFilter('the two-footed ones', plan({}), v).spec.filters[1].value, 'Two-footed');
  const has = plan({ filters: [{ field: 'strong_foot', op: 'eq', value: 'Left' }] });
  assert.equal(ensureFootFilter('only the left-footed ones', has, v), has);
  const withText = plan({ text: [{ fields: ['any'], any_of: ['strike'] }] });
  assert.equal(ensureFootFilter('players with a good left-footed strike', withText, v), withText, 'a keyword search is present');
  const other = plan({});
  assert.equal(ensureFootFilter('only the strikers', other, v), other);
});

test('showAllThenRank: "show me all the X, and then rank the best N" lists everyone and calls out the best N', () => {
  const { showAllThenRank } = require('../src/chat/followup');
  const plan = (spec) => ({ route: 'data', spec: { intent: 'list', unit: 'player', limit: 3, sort: { field: 'overall_score', direction: 'desc' }, filters: [], assumptions: [], ...spec } });
  const a = showAllThenRank('Show me all the strikers assessed, and then rank the best 3', plan({})).spec;
  assert.equal(a.limit, 25);
  assert.equal(a.top_n, 3);
  assert.equal(a.intent, 'list');
  const b = showAllThenRank('Find all the wingers and then show the top 5 by potential', plan({ limit: 5, sort: { field: 'overall_potential_score', direction: 'desc' } })).spec;
  assert.equal(b.top_n, 5);
  assert.equal(b.sort.field, 'overall_potential_score');
  const plain = plan({});
  assert.equal(showAllThenRank('Top 3 strikers', plain), plain, 'no "show all"');
  assert.equal(showAllThenRank('Show me all the strikers, rank the best 3', plan({ limit: 10 })).spec.limit, 10, 'the planner limit is not the number the user named');
});

test('editDistance: a swap of two neighbouring letters is one mistake', () => {
  const { editDistance } = require('../src/chat/fold');
  assert.equal(editDistance('krnoborg', 'kronborg'), 1);
  assert.equal(editDistance('kronburg', 'kronborg'), 1);
  assert.equal(editDistance('kronbrog', 'kronborg'), 1);
  assert.equal(editDistance('carll', 'carl'), 1);
  assert.equal(editDistance('amca', 'amcha'), 1);
  assert.equal(editDistance('zzzzqq', 'kronborg') > 2, true);
  assert.equal(editDistance('same', 'same'), 0);
});

test('mergePositionAlternatives: two position conditions mean either position (strikers = No. 9 or Forward)', () => {
  const { mergePositionAlternatives } = require('../src/chat/followup');
  const plan = (filters) => ({ route: 'data', spec: { filters } });
  const a = mergePositionAlternatives(plan([{ field: 'position', op: 'contains', value: 'No. 9' }, { field: 'position', op: 'contains', value: 'Forward' }, { field: 'age_group', op: 'eq', value: 2012 }])).spec.filters;
  assert.deepEqual(a, [{ field: 'age_group', op: 'eq', value: 2012 }, { field: 'position', op: 'contains_any', value: ['No. 9', 'Forward'] }]);
  const one = plan([{ field: 'position', op: 'contains', value: 'No. 9' }]);
  assert.equal(mergePositionAlternatives(one), one);
  const names = plan([{ field: 'player_name', op: 'contains', value: 'Anna' }, { field: 'player_name', op: 'contains', value: 'Testsen' }]);
  assert.equal(mergePositionAlternatives(names), names, 'name parts stay AND');
});

test('reportTypeFromWords: "feedback"/"coach" or "assessment" in the question sets the report type when the plan lacks it', () => {
  const { reportTypeFromWords } = require('../src/chat/followup');
  const plan = (unit, filters = []) => ({ route: 'data', spec: { intent: 'count', unit, filters, assumptions: [] } });
  assert.deepEqual(reportTypeFromWords('How many feedback reports are there?', plan('report')).spec.filters, [{ field: 'report_type', op: 'eq', value: 'feedback' }]);
  assert.deepEqual(reportTypeFromWords('Which coach wrote the most?', plan('report')).spec.filters, [{ field: 'report_type', op: 'eq', value: 'feedback' }]);
  assert.deepEqual(reportTypeFromWords('players with an assessment', plan('player')).spec.filters, [{ field: 'assessment_count', op: 'gt', value: 0 }]);
  assert.deepEqual(reportTypeFromWords('Show me all the strikers assessed', plan('player')).spec.filters, [{ field: 'assessment_count', op: 'gt', value: 0 }]);
  const both = plan('report');
  assert.equal(reportTypeFromWords('compare the assessment and the feedback', both), both, 'both kinds named: no restriction');
  const has = plan('report', [{ field: 'report_type', op: 'eq', value: 'feedback' }]);
  assert.equal(reportTypeFromWords('feedback reports', has), has);
  const none = plan('report');
  assert.equal(reportTypeFromWords('how many reports per scout', none), none);
});

test('dropTextRepeatingTags: a keyword equal to a tag of the plan is dropped (tag "Speed" + keyword "speed")', () => {
  const { dropTextRepeatingTags } = require('../src/chat/followup');
  const plan = (text, logic = 'all') => ({ route: 'data', spec: { tags: [{ category: 'physical', any_of: ['Speed'] }], text, content_logic: logic } });
  assert.deepEqual(dropTextRepeatingTags(plan([{ fields: ['comment'], any_of: ['speed'] }])).spec.text, []);
  assert.deepEqual(dropTextRepeatingTags(plan([{ fields: ['comment'], any_of: ['speed', 'agility'] }])).spec.text, [{ fields: ['comment'], any_of: ['agility'] }]);
  const alt = plan([{ fields: ['comment'], any_of: ['speed'] }], 'any');
  assert.equal(dropTextRepeatingTags(alt), alt, 'alternatives (any) are left alone');
});

test('pickOption: the answer to "which player do you mean" picks one of the offered names', () => {
  const { pickOption } = require('../src/chat/followup');
  const opts = ['Jonas Ravn Testsen', 'Jónas Ravnsted Testsen'];
  assert.equal(pickOption('Jonas Ravn Testsen', opts), 'Jonas Ravn Testsen');
  assert.equal(pickOption('I mean Jónas Ravnsted Testsen', opts), 'Jónas Ravnsted Testsen');
  assert.equal(pickOption('Ravnsted', opts), 'Jónas Ravnsted Testsen');
  assert.equal(pickOption('the first one', opts), 'Jonas Ravn Testsen');
  assert.equal(pickOption('2', opts), 'Jónas Ravnsted Testsen');
  assert.equal(pickOption('the last one', opts), 'Jónas Ravnsted Testsen');
  assert.equal(pickOption('Testsen', opts), null, 'a word both names share decides nothing');
  assert.equal(pickOption('how many strikers are there?', opts), null);
});
