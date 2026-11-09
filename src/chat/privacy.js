// Personal-data guard for everything that leaves the server towards the AI provider (OpenAI).
//
// Player and scout names are replaced BEFORE a request is sent, at the single place every request passes through
// (llm/openai.js and embeddings.js), so no prompt can bypass it:
//   - a full name becomes an alias token: "⟦P12⟧" (player id 12) or "⟦S3⟧" (scout id 3). Reversible: the AI's reply
//     is translated back locally, so the administrator still sees real names and "tell me about <name>" still works.
//   - any other occurrence of a name part (first name, surname) becomes "[name]". Not reversible.
//   - a final check refuses to send anything that still contains a known name (fail closed).
// If the name directory cannot be loaded, nothing is sent.
//
// Limit: this covers the names in the database. Free text can still contain other personal details (a nickname, a
// school, a phone number); that is only reduced by the heuristics in redact.js, not guaranteed.
const chatPool = require('../db/chatPool');

const IGNORE_PARTS = new Set(['player', 'van', 'der', 'den', 'von', 'the', 'and', 'jr', 'junior']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');
const clean = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
const wordRe = (list) => (list.length
  ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
  : null);

/** entries: [{ token: '[P12]', name: 'Anna Testsen' }] */
function buildMasker(entries) {
  const full = new Map();            // lowercase full name (and accent-folded variant) -> token
  const partOwners = new Map();      // lowercase name part -> Set(tokens)
  for (const e of entries) {
    const name = clean(e.name);
    if (name.length < 2) continue;
    for (const v of new Set([name, fold(name)])) full.set(v.toLowerCase(), e.token);
    for (const p of name.split(/[\s\-]+/)) {
      if (p.length < 3 || /^\d+$/.test(p) || IGNORE_PARTS.has(p.toLowerCase())) continue;
      for (const v of new Set([p, fold(p)])) {
        const k = v.toLowerCase();
        if (!partOwners.has(k)) partOwners.set(k, new Set());
        partOwners.get(k).add(e.token);
      }
    }
  }
  const uniquePart = new Map([...partOwners].filter(([, s]) => s.size === 1).map(([k, s]) => [k, [...s][0]]));
  const strings = [...new Set([...full.keys(), ...partOwners.keys()])];
  const re = wordRe(strings);
  const byToken = new Map(entries.map((e) => [e.token, clean(e.name)]));
  const tokenRe = /⟦([PS]\d+)⟧/g;

  // allowParts: true  -> "Tell me about Anna" resolves to the one player called Anna (questions, conversation context)
  //             false -> only full names get an alias; lone name parts are anonymised (report text, comments)
  const mask = (text, { allowParts = false } = {}) => {
    if (!re || text == null) return text;
    return String(text).replace(re, (m) => {
      const k = m.toLowerCase();
      if (full.has(k)) return full.get(k);
      if (allowParts && uniquePart.has(k)) return uniquePart.get(k);
      return '[name]';
    });
  };
  /** irreversible: every name and name part -> [name] (text that never needs to be translated back) */
  const scrub = (text) => (re && text != null ? String(text).replace(re, '[name]') : text);
  const unmask = (text) => (typeof text === 'string' ? text.replace(tokenRe, (m, t) => byToken.get(`⟦${t}⟧`) || m) : text);
  const unmaskDeep = (v) => {
    if (typeof v === 'string') return unmask(v);
    if (Array.isArray(v)) return v.map(unmaskDeep);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmaskDeep(x)]));
    return v;
  };
  /** full names of everyone who shares a name part used in text ("Carl" -> all Carls), for "which one do you mean?" */
  const ambiguous = (text) => {
    const out = new Set();
    for (const w of String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
      const owners = partOwners.get(w);
      if (owners && owners.size > 1) for (const t of owners) out.add(byToken.get(t));
    }
    return [...out].slice(0, 8);
  };
  /** first known name still present in text (should always be null after mask/scrub) */
  const findLeak = (text) => { if (!re || text == null) return null; re.lastIndex = 0; const m = re.exec(String(text)); re.lastIndex = 0; return m ? m[0] : null; };

  /** Streaming translation back: tokens can be split across chunks ("⟦P1" + "2⟧"), so an open "[" is held back. */
  const unmaskStream = (emit) => {
    let buf = '';
    const out = (s) => { if (s) emit(unmask(s)); };
    return {
      push(piece) {
        buf += piece;
        const open = buf.lastIndexOf('⟦');
        if (open !== -1 && buf.indexOf('⟧', open) === -1 && buf.length - open <= 12) { out(buf.slice(0, open)); buf = buf.slice(open); } else { out(buf); buf = ''; }
      },
      flush() { out(buf); buf = ''; },
    };
  };
  return { mask, scrub, unmask, unmaskDeep, unmaskStream, findLeak, ambiguous, size: entries.length };
}

// ---- directory of names, loaded from the database ----
const TTL = 60 * 1000;
let cache = { at: 0, masker: null };
let loading = null;

async function load() {
  const [pl, sc] = await Promise.all([chatPool.query('SELECT id, name FROM players'), chatPool.query('SELECT id, name FROM scouts')]);
  return buildMasker([
    ...pl.rows.map((r) => ({ token: `⟦P${r.id}⟧`, name: r.name })),
    ...sc.rows.map((r) => ({ token: `⟦S${r.id}⟧`, name: r.name })),
  ]);
}

/** -> masker. Rejects (so nothing is sent) when the directory cannot be loaded. fresh: bypass the 60 s cache. */
async function getMasker({ fresh = false } = {}) {
  if (!fresh && cache.masker && Date.now() - cache.at < TTL) return cache.masker;
  loading = loading || load().then((m) => { cache = { at: Date.now(), masker: m }; return m; }).finally(() => { loading = null; });
  try {
    return await loading;
  } catch (e) {
    cache = { at: 0, masker: null };
    const err = new Error(`Personal-data guard unavailable, nothing was sent to the AI provider: ${e.message}`);
    err.code = 'PRIVACY_GUARD';
    throw err;
  }
}
const clearPrivacyCache = () => { cache = { at: 0, masker: null }; };
/** tests: install a prebuilt masker */
const setMaskerForTests = (m) => { cache = { at: Date.now() + 365 * 24 * 3600 * 1000, masker: m }; };

/** Last line of defence at the network boundary: throws if a known name is still in what is about to be sent. */
function assertClean(masker, ...texts) {
  for (const t of texts.flat()) {
    const leak = masker.findLeak(t);
    if (leak) { const e = new Error('Blocked: a personal name was about to be sent to the AI provider'); e.code = 'PRIVACY_BLOCKED'; throw e; }
  }
}

module.exports = { buildMasker, getMasker, clearPrivacyCache, setMaskerForTests, assertClean };

/** Added to every system prompt so the model copies alias tokens back verbatim instead of expanding them. */
const TOKEN_NOTE = `

Names of players and scouts are replaced by ID tokens such as ⟦P12⟧ (player) or ⟦S3⟧ (scout), because real names are never shared with you. Treat a token as the name itself and copy it EXACTLY, including the brackets, wherever that name belongs in your answer (e.g. in players or filter values). Never rewrite a token as a label with a number or in any other form.`;
module.exports.TOKEN_NOTE = TOKEN_NOTE;
