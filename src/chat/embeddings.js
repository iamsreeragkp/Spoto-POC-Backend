// Text -> vector. EMBEDDING_PROVIDER=openai (default) | mock (offline tests; lexical hashing, no meaning).
// Every vector stored in text_chunks records the model id, so a provider/model change is detected and re-embedded.
const crypto = require('crypto');

const DIMS = 512; // must match text_chunks.embedding halfvec(512)

const providerName = () => (process.env.EMBEDDING_PROVIDER || 'openai').toLowerCase();

// ---- OpenAI ----
let client;
function openaiClient() {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY is not set');
    e.code = 'LLM_NOT_CONFIGURED';
    throw e;
  }
  const OpenAI = require('openai');
  client = client || new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS) || 20000,
    maxRetries: 2,
  });
  return client;
}
const openaiModel = () => process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

async function openaiEmbed(texts) {
  const res = await openaiClient().embeddings.create({ model: openaiModel(), input: texts, dimensions: DIMS });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ---- Mock: deterministic feature hashing of crude word stems (+ char trigrams). Similar words -> similar vectors. ----
const STOP = new Set('a an and are as at be by for from has he her him his in is it its of on or she that the their they this to was were will with very good'.split(' '));
const stem = (w) => w.replace(/(ingly|ities|ity|ings|ing|ers|er|ies|ied|ed|ly|es|s)$/, '') || w;
function bucket(s) {
  const h = crypto.createHash('md5').update(s).digest();
  return { i: h.readUInt32LE(0) % DIMS, sign: h[4] & 1 ? 1 : -1 };
}
function mockEmbedOne(text) {
  const v = new Float64Array(DIMS);
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (const w of words) {
    if (STOP.has(w) || w.length < 2) continue;
    const s = stem(w);
    const b = bucket(`w:${s}`);
    v[b.i] += b.sign * 1.0;
    for (let k = 0; k + 3 <= s.length; k++) {
      const t = bucket(`t:${s.slice(k, k + 3)}`);
      v[t.i] += t.sign * 0.25;
    }
  }
  const norm = Math.hypot(...v) || 1;
  return Array.from(v, (x) => x / norm);
}

const PROVIDERS = {
  openai: { id: () => `openai:${openaiModel()}:${DIMS}`, embed: openaiEmbed },
  mock: { id: () => `mock:hash:${DIMS}`, embed: async (texts) => texts.map(mockEmbedOne) },
};

function provider() {
  const p = PROVIDERS[providerName()];
  if (!p) throw new Error(`Unknown EMBEDDING_PROVIDER "${providerName()}" (available: ${Object.keys(PROVIDERS).join(', ')})`);
  return p;
}

/** Embeds texts in batches of up to 256. Returns number[][] (unit length). */
async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 256) out.push(...(await provider().embed(texts.slice(i, i + 256))));
  return out;
}

const modelId = () => provider().id();

/** pgvector text literal */
const toSql = (vec) => `[${vec.map((x) => (Math.abs(x) < 1e-7 ? 0 : x.toFixed(6))).join(',')}]`;

module.exports = { embed, modelId, toSql, DIMS };
