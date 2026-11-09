// Personal-data guard: no player/scout name may reach the AI provider. These tests capture the exact requests that
// would be sent (fake OpenAI client, no network, no database).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = 'test-key';
process.env.EMBEDDING_PROVIDER = 'openai';
process.env.LLM_PROVIDER = 'openai';

const { buildMasker, setMaskerForTests, assertClean } = require('../src/chat/privacy');
const openai = require('../src/chat/llm/openai');
const embeddings = require('../src/chat/embeddings');

const PLAYERS = [
  { token: '⟦P1⟧', name: 'Anna Testsen' }, { token: '⟦P2⟧', name: 'Alex' }, { token: '⟦P3⟧', name: 'André Marlowe Busk Kranz' },
  { token: '⟦P4⟧', name: 'Carl Baker' }, { token: '⟦P5⟧', name: 'Carl Eklund Jahn' }, { token: '⟦P6⟧', name: 'Bjørn Eklund' },
];
const SCOUTS = [{ token: '⟦S1⟧', name: 'Jonas Lindqvist' }, { token: '⟦S2⟧', name: 'Rolf Lund Holm' }];
const ALL_NAMES = ['Anna', 'Testsen', 'Alex', 'André', 'Andre', 'Marlowe', 'Kranz', 'Carl', 'Baker', 'Eklund', 'Jahn', 'Bjørn', 'Jonas', 'Lindqvist', 'Rolf', 'Lund', 'Holm'];
const noNames = (text) => { for (const n of ALL_NAMES) assert.ok(!new RegExp(`(?<![\\p{L}\\p{N}])${n}(?![\\p{L}\\p{N}])`, 'iu').test(text), `"${n}" was sent: ${text.slice(0, 200)}`); };

const masker = buildMasker([...PLAYERS, ...SCOUTS]);
setMaskerForTests(masker);

test('full names become reversible aliases; lone parts are anonymised; ambiguous parts never aliased', () => {
  assert.equal(masker.mask('Tell me about Anna Testsen'), 'Tell me about ⟦P1⟧');
  assert.equal(masker.mask('tell me about alex'), 'tell me about ⟦P2⟧');
  assert.equal(masker.mask('Anna was good', { allowParts: true }), '⟦P1⟧ was good', 'unique first name resolves when allowed');
  assert.equal(masker.mask('Anna was good', { allowParts: false }), '[name] was good');
  assert.equal(masker.mask('Carl was good', { allowParts: true }), '[name] was good', 'two players called Carl: not resolvable');
  assert.equal(masker.mask('Andre Marlowe Busk Kranz'), '⟦P3⟧', 'accent-folded spelling');
  assert.equal(masker.mask('Reports by Jonas Lindqvist'), 'Reports by ⟦S1⟧');
  assert.equal(masker.mask('He is composed and fast'), 'He is composed and fast', 'ordinary words untouched');
  assert.equal(masker.unmask('Compare ⟦P1⟧ and ⟦P2⟧ (scout ⟦S2⟧)'), 'Compare Anna Testsen and Alex (scout Rolf Lund Holm)');
  assert.deepEqual(masker.unmaskDeep({ players: ['⟦P4⟧'], a: [{ b: '⟦S1⟧' }], n: 3 }), { players: ['Carl Baker'], a: [{ b: 'Jonas Lindqvist' }], n: 3 });
});

test('streamed tokens split across chunks are translated back', () => {
  const out = [];
  const s = masker.unmaskStream((t) => out.push(t));
  ['Hello ', '⟦P', '1', '⟧ and ⟦', 'P2⟧', ' ok ⟦', 'x'].forEach((p) => s.push(p));
  s.flush();
  assert.equal(out.join(''), 'Hello Anna Testsen and Alex ok ⟦x');
});

test('assertClean blocks anything that still contains a name', () => {
  assert.throws(() => assertClean(masker, 'safe', 'but Anna Testsen here'), { code: 'PRIVACY_BLOCKED' });
  assert.doesNotThrow(() => assertClean(masker, masker.mask('Anna Testsen scored for Jonas Lindqvist')));
});

function fakeChat(reply) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (args) => {
      calls.push(args);
      if (args.stream) {
        return (async function* () { for (const d of ['Hi ', '⟦P', '1⟧ ', 'is great']) yield { choices: [{ delta: { content: d } }] }; })();
      }
      return { choices: [{ message: { content: reply } }] };
    } } },
  };
}

test('planner request contains no names; the reply is translated back to real names', async () => {
  const fake = fakeChat(JSON.stringify({ route: 'data', reply: null, spec: { intent: 'profile', players: ['⟦P1⟧'], filters: [{ field: 'scout_name', op: 'eq', value: '⟦S1⟧' }] } }));
  openai.setClientForTests(fake);
  const vocab = { tags: { physical: [{ tag: 'Speed' }], mental: [], technical: [], tactical: [], deadball: [] }, positions: ['Left-back'], stageOfGrowth: [], strongFoot: [], recommendations: [],
    ageGroups: [], scouts: SCOUTS.map((s) => s.name), locations: ['Aarhus'] };
  const plan = await openai.plan({
    question: 'Tell me about Anna Testsen, scouted by Jonas Lindqvist',
    context: { turns: [{ question: 'Show Carl Baker and Alex', route: 'data', intent: 'list', count: 2, player_names: ['Carl Baker', 'Alex'] }],
      lastSpec: { players: ['Alex'], filters: [{ field: 'scout_name', op: 'eq', value: 'Rolf Lund Holm' }] } },
    vocab,
  });
  const sent = JSON.stringify(fake.calls[0].messages);
  noNames(sent);
  assert.match(sent, /⟦P1⟧/);
  assert.match(sent, /⟦S1⟧/);
  assert.deepEqual(plan.spec.players, ['Anna Testsen']);
  assert.equal(plan.spec.filters[0].value, 'Jonas Lindqvist');
});

test('written answers: report text sent without names, streamed reply translated back', async () => {
  const fake = fakeChat('x');
  openai.setClientForTests(fake);
  const tokens = [];
  const text = await openai.complete({
    system: 'You compare players.',
    content: 'Question: compare Anna Testsen and Alex\n#12 (Anna Testsen, 2025-01-01)\nComment: Anna is quick. Alex reminds me of Bjørn Eklund. Kranz is calm. Coach Jonas Lindqvist agrees.',
    onToken: (t) => tokens.push(t),
  });
  noNames(JSON.stringify(fake.calls[0].messages));
  assert.equal(text, 'Hi Anna Testsen is great');
  assert.equal(tokens.join(''), 'Hi Anna Testsen is great');
});

test('meaning-search check: passages are sent without names', async () => {
  const fake = fakeChat(JSON.stringify({ matches: [1] }));
  openai.setClientForTests(fake);
  const r = await openai.verifyPassages({ question: 'who leads? ask Alex', concept: 'leader', passages: [{ n: 1, text: 'Carl Baker organises the team' }, { n: 2, text: 'Jahn is shy' }] });
  noNames(JSON.stringify(fake.calls[0].messages));
  assert.deepEqual(r, [1]);
});

test('embedding requests contain no names', async () => {
  const seen = [];
  embeddings.setClientForTests({ embeddings: { create: async (args) => { seen.push(args.input); return { data: args.input.map((_, i) => ({ index: i, embedding: new Array(512).fill(0.01) })) }; } } });
  // the embed path asks for a fresh directory: stub it through the cached masker (fresh bypasses cache, so patch loader)
  const priv = require('../src/chat/privacy');
  const orig = priv.getMasker;
  priv.getMasker = async () => masker;
  try {
    await embeddings.embed(['Anna Testsen is quick', 'Reminds me of Carl and Kranz', 'physical attribute: Speed']);
  } finally { priv.getMasker = orig; }
  noNames(JSON.stringify(seen));
  assert.equal(seen[0].length, 3);
  assert.equal(seen[0][2], 'physical attribute: Speed', 'ordinary text is unchanged');
});

test('fails closed: if the name directory cannot be loaded nothing is sent', async () => {
  const priv = require('../src/chat/privacy');
  priv.clearPrivacyCache();
  const chatPool = require('../src/db/chatPool');
  const origQuery = chatPool.query;
  chatPool.query = async () => { throw new Error('db down'); };
  const fake = fakeChat('{}');
  openai.setClientForTests(fake);
  try {
    await assert.rejects(() => openai.complete({ system: 's', content: 'hello Anna' }), { code: 'PRIVACY_GUARD' });
    assert.equal(fake.calls.length, 0, 'no request was made');
  } finally { chatPool.query = origQuery; setMaskerForTests(masker); }
});
