// Accent-insensitive name matching ("Andre" finds "André", "Jorgen" finds "Jørgen"). The same mapping is applied to the
// typed text (foldText) and, in SQL, to the stored column (foldSql), so both sides compare in the same plain-letter form.
const PAIRS = [
  ['á', 'a'], ['à', 'a'], ['â', 'a'], ['ä', 'a'], ['ã', 'a'], ['å', 'a'],
  ['é', 'e'], ['è', 'e'], ['ê', 'e'], ['ë', 'e'],
  ['í', 'i'], ['ì', 'i'], ['î', 'i'], ['ï', 'i'],
  ['ó', 'o'], ['ò', 'o'], ['ô', 'o'], ['ö', 'o'], ['õ', 'o'], ['ø', 'o'],
  ['ú', 'u'], ['ù', 'u'], ['û', 'u'], ['ü', 'u'],
  ['ý', 'y'], ['ÿ', 'y'], ['ñ', 'n'], ['ç', 'c'], ['æ', 'a'],
];
const FROM = PAIRS.map((p) => p[0]).join('');
const TO = PAIRS.map((p) => p[1]).join('');
const MAP = new Map(PAIRS);

/** lowercase, accents removed ("André Marshall" -> "andre marshall"), identical to foldSql on the database side */
const foldText = (s) => [...String(s == null ? '' : s).toLowerCase()].map((c) => MAP.get(c) || c).join('')
  .normalize('NFD').replace(/\p{M}/gu, '');

/** SQL expression for a trusted column name */
const foldSql = (col) => `translate(lower(${col}), '${FROM}', '${TO}')`;

/** LIKE pattern for "contains" (wildcards in the typed text are neutralised) */
const containsPattern = (s) => `%${foldText(s).replace(/[%_\\]/g, ' ').trim()}%`;

module.exports = { foldText, foldSql, containsPattern };
