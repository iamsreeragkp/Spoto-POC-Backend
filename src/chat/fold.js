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

/** Edit distance where a swap of two neighbouring letters counts as ONE mistake ("Krnoborg" -> "Kronborg" = 1). */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

module.exports = { foldText, foldSql, containsPattern, editDistance };
