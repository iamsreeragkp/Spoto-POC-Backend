const OpenAI = require('openai');
const { PLAN_SCHEMA } = require('../spec');
const { systemPrompt, userPrompt, VERIFY_SYSTEM, VERIFY_SCHEMA } = require('./prompt');
const { getMasker, assertClean, TOKEN_NOTE } = require('../privacy');

let client;
function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY is not set');
    e.code = 'LLM_NOT_CONFIGURED';
    throw e;
  }
  client = client || new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS) || 20000,
    maxRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 1),
  });
  return client;
}

/** Test hook: replace the OpenAI client (the privacy tests capture what would be sent). */
const setClientForTests = (c) => { client = c; };

// Every request is masked first (player/scout names -> aliases, see privacy.js) and checked before it is sent;
// replies are translated back locally.
async function guarded(texts, opts, system = true) {
  const m = await getMasker();
  const masked = texts.map((t) => m.mask(t, opts));
  if (system) masked[0] += TOKEN_NOTE; // first text is the system prompt
  assertClean(m, masked);
  return { m, masked };
}

const model = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';

module.exports = {
  name: 'openai',
  setClientForTests,

  /** question (+ conversation context) -> raw plan { route, reply, spec } */
  async plan({ question, context, vocab }) {
    const { m, masked } = await guarded([systemPrompt(vocab), userPrompt(question, context)], { allowParts: true });
    const res = await getClient().chat.completions.create({
      model: model(),
      temperature: 0,
      max_tokens: 900,
      response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: PLAN_SCHEMA } },
      messages: [
        { role: 'system', content: masked[0] },
        { role: 'user', content: masked[1] },
      ],
    });
    return m.unmaskDeep(JSON.parse(res.choices[0].message.content));
  },

  /** Free-text completion (general chat, help, judgement, profile, compare). Streams through onToken when given. */
  async complete({ system, content, onToken, maxTokens = 500, temperature = 0.3 }) {
    const { m, masked } = await guarded([system, content], { allowParts: false });
    const args = {
      model: process.env.CHAT_COMMENT_MODEL || model(),
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: masked[0] }, { role: 'user', content: masked[1] }],
    };
    if (!onToken) return m.unmask((await getClient().chat.completions.create(args)).choices[0].message.content.trim());
    let text = '';
    const out = m.unmaskStream(onToken);
    const stream = await getClient().chat.completions.create({ ...args, stream: true });
    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta?.content;
      if (d) { text += d; out.push(d); }
    }
    out.flush();
    return m.unmask(text.trim());
  },

  /** -> numbers of the passages that express the concept */
  async verifyPassages({ question, concept, passages }) {
    const { masked } = await guarded([`Question: ${question}\nConcept: ${concept}\n\nPassages:\n${passages.map((p) => `${p.n}. ${p.text}`).join('\n')}`], { allowParts: false }, false);
    const content = masked[0];
    const res = await getClient().chat.completions.create({
      model: model(),
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_schema', json_schema: { name: 'matches', strict: true, schema: VERIFY_SCHEMA } },
      messages: [{ role: 'system', content: VERIFY_SYSTEM }, { role: 'user', content }],
    });
    return JSON.parse(res.choices[0].message.content).matches.filter((n) => Number.isInteger(n));
  },
};
