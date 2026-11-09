// Best-effort removal of personal names from scout text before it is sent to an external AI (embeddings, the
// meaning check, written answers). Heuristics only:
//  1. known names (scouts, teams) and names learned from the data (see names.js) are masked as whole words
//  2. capitalised words in the middle of a sentence that are not labels/keep-words are masked
// Player names are already pseudonymous ("Player 12") in this dataset.
const KEEP = new Set(['I', 'Potential', 'Red', 'Purple', 'Blue', 'Green', 'Yellow', 'Orange', 'Golden', 'Boy', 'No', 'U', 'FC', 'IF',
  'Physical', 'Mental', 'Technical', 'Tactical', 'Attitude', 'Game', 'Pace', 'Danish', 'Denmark', 'Asian']);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let lastNames = null, lastRe = null;
function namesRegex(names) {
  if (names === lastNames) return lastRe;
  const list = [...new Set(names.filter((n) => n && n.length >= 2 && !KEEP.has(n)))].sort((a, b) => b.length - a.length);
  lastNames = names;
  lastRe = list.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null;
  return lastRe;
}

function redactComment(text, knownNames = []) {
  let out = String(text || '');
  const re = namesRegex(knownNames);
  if (re) out = out.replace(re, '[name]');
  // Capitalised word preceded by a lowercase word/comma (i.e. mid-sentence) and not a label/keep-word
  out = out.replace(/(?<=[a-zæøå,;)\-]\s)\b([A-ZÆØÅ][a-zæøåéü]{2,})\b(?!:)/g,
    (m, w) => (KEEP.has(w) ? m : '[name]'));
  return out.replace(/(\[name\]\s*){2,}/g, '[name] ');
}

// Ordinary English words that may only ever appear capitalised in the data (sentence starts) – not names.
const NOT_NAMES = new Set(['Above', 'Already', 'Amazing', 'Since', 'Thus', 'Nevertheless', 'Key', 'League', 'School', 'Series', 'North',
  'South', 'East', 'West', 'Bank', 'Sand', 'Sweeper', 'Lightning', 'Spoke', 'June', 'July', 'January', 'February', 'March', 'April',
  'May', 'August', 'September', 'October', 'November', 'December', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  'Sunday', 'Cannon', 'Black', 'White', 'Insufficient', 'Comfortable', 'Clinical', 'Explosive', 'Fired', 'Futsal', 'American', 'European',
  'Somali', 'Overall', 'Strong', 'Good', 'Great', 'Very', 'Nice', 'Fine', 'Top', 'Best', 'Small', 'Big', 'Tall', 'Fast', 'Quick']);
const ENGLISH_SUFFIX = /(ed|ing|ly|ive|ous|able|ible|ical|ity|ness|ment|less|ful|tion|sion|ies|es|ys)$/;

/** Words that only ever appear capitalised in the scout text -> likely names (people, clubs, places). */
function likelyNames(words) {
  return words.filter((w) => w.length >= 2 && !KEEP.has(w) && !NOT_NAMES.has(w) && !ENGLISH_SUFFIX.test(w));
}

module.exports = { redactComment, likelyNames };
