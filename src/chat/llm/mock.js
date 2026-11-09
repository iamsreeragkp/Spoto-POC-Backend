// Deterministic provider for tests / offline demos: LLM_PROVIDER=mock.
// plan() looks the question up in a fixtures file (MOCK_SPECS, default tests/fixtures/specs.json).
// Fixture: { question, route?, reply?, spec? } – a fixture with only `spec` is a data question.
const fs = require('fs');
const path = require('path');

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stems = (s) => (norm(s).match(/[a-z]{4,}/g) || []).map((w) => w.slice(0, 5));

module.exports = {
  name: 'mock',
  async plan({ question }) {
    const file = process.env.MOCK_SPECS || path.join(__dirname, '../../../tests/fixtures/specs.json');
    const fixtures = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hit = fixtures.find((f) => norm(f.question) === norm(question));
    if (!hit) throw new Error(`mock LLM has no fixture for: ${question}`);
    return { route: hit.route || 'data', reply: hit.reply ?? null, spec: hit.spec ?? null };
  },
  /** Echoes the kind of answer and every #id it was given, so tests can check what was sent. */
  async complete({ content, onToken }) {
    const ids = [...new Set(String(content).match(/#\d+/g) || [])];
    const text = ids.length ? `(mock) Based on ${ids.join(', ')}.` : '(mock) General answer.';
    if (onToken) onToken(text);
    return text;
  },
  /** Lexical stand-in for the AI check: keeps passages sharing a 5-letter stem with the concept. */
  async verifyPassages({ concept, passages }) {
    const want = new Set(stems(concept));
    return passages.filter((p) => stems(p.text).some((s) => want.has(s))).map((p) => p.n);
  },
};
